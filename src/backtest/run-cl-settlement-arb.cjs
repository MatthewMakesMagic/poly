/**
 * Chainlink Settlement Arb — The User's Actual Hypothesis
 *
 * We receive the Chainlink feed in real-time. When CL drops below strike
 * near window close, we KNOW the resolution will be DOWN. But the CLOB
 * might still show UP at 93%+ because of the 878ms lag.
 *
 * Questions:
 *   1. In surprise DOWN windows, WHEN did CL cross below strike?
 *   2. Was the CLOB still showing UP high at that moment?
 *   3. How much time was there to act (buy DOWN on CLOB)?
 *   4. If we buy DOWN the moment CL < strike, what's the CLOB ask at that instant?
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-cl-settlement-arb.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 60000 });

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  CHAINLINK SETTLEMENT ARB                                ║');
  console.log('║  "See the answer before the market does"                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  // Load ALL windows with resolution data
  const windowsQuery = await pool.query(`
    SELECT window_close_time, symbol, strike_price, chainlink_price_at_close,
           COALESCE(resolved_direction,
             CASE WHEN chainlink_price_at_close > strike_price THEN 'UP' ELSE 'DOWN' END
           ) as resolved,
           market_up_price_10s, market_up_price_5s, market_up_price_1s,
           market_down_price_10s, market_down_price_5s, market_down_price_1s
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND chainlink_price_at_close IS NOT NULL
    ORDER BY window_close_time ASC
  `);

  const allWindows = windowsQuery.rows;
  console.log(`  Total windows: ${allWindows.length}\n`);

  // ═══════════════════════════════════════════════════════════
  // For EACH window, load tick-by-tick CL + CLOB for last 60s
  // Find: when did CL first cross below strike? What was CLOB at that moment?
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 1: CHAINLINK CROSSING ANALYSIS');
  console.log('  When does CL cross below strike? Is CLOB still wrong?');
  console.log('═══════════════════════════════════════════════════════════\n');

  const crossingEvents = [];
  const arbOpportunities = [];
  let processed = 0;

  for (const win of allWindows) {
    const closeTime = win.window_close_time;
    const closeTimeMs = new Date(closeTime).getTime();
    const strike = parseFloat(win.strike_price);
    const resolved = win.resolved;

    // Load last 120s of tick data (CL + CLOB + polyRef)
    const lookbackMs = 120 * 1000;
    const startTime = new Date(closeTimeMs - lookbackMs);

    const windowEpoch = Math.floor(closeTimeMs / 1000) - 900;
    const [clTicks, clobTicks, refTicks] = await Promise.all([
      pool.query(`
        SELECT timestamp, price FROM rtds_ticks
        WHERE timestamp >= $1 AND timestamp <= $2 AND topic = 'crypto_prices_chainlink'
        ORDER BY timestamp ASC
      `, [startTime, closeTime]),
      pool.query(`
        SELECT timestamp, symbol, best_bid, best_ask, mid_price FROM clob_price_snapshots
        WHERE timestamp >= $1 AND timestamp <= $2
          AND window_epoch = $3
        ORDER BY timestamp ASC
      `, [startTime, closeTime, windowEpoch]),
      pool.query(`
        SELECT timestamp, price FROM rtds_ticks
        WHERE timestamp >= $1 AND timestamp <= $2 AND topic = 'crypto_prices'
        ORDER BY timestamp ASC
      `, [startTime, closeTime]),
    ]);

    // Process CL ticks: find first crossing below strike
    let firstCrossBelowTs = null;
    let firstCrossBelowPrice = null;
    let clAboveStrike = null; // was CL ever above strike in this window?
    let lastCLAboveTs = null;

    for (const row of clTicks.rows) {
      const ts = new Date(row.timestamp).getTime();
      const price = parseFloat(row.price);

      if (price > strike) {
        clAboveStrike = true;
        lastCLAboveTs = ts;
      }

      if (price <= strike && clAboveStrike && firstCrossBelowTs === null) {
        firstCrossBelowTs = ts;
        firstCrossBelowPrice = price;
      }
    }

    // Also find: where was CL at various offsets from close
    const clAtOffset = {};
    for (const offsetMs of [60000, 30000, 10000, 5000, 2000, 1000, 500]) {
      const targetTs = closeTimeMs - offsetMs;
      let closest = null;
      let closestDist = Infinity;
      for (const row of clTicks.rows) {
        const ts = new Date(row.timestamp).getTime();
        const dist = Math.abs(ts - targetTs);
        if (dist < closestDist) { closestDist = dist; closest = row; }
      }
      if (closest && closestDist < 2000) {
        clAtOffset[offsetMs] = parseFloat(closest.price);
      }
    }

    // Find CLOB state at various moments
    const clobDownAtOffset = {};
    const clobUpAtOffset = {};
    for (const row of clobTicks.rows) {
      const ts = new Date(row.timestamp).getTime();
      const isDown = row.symbol?.toLowerCase().includes('down');
      if (isDown) {
        for (const offsetMs of [60000, 30000, 10000, 5000, 2000, 1000, 500]) {
          const targetTs = closeTimeMs - offsetMs;
          if (Math.abs(ts - targetTs) < 500) {
            clobDownAtOffset[offsetMs] = { ask: parseFloat(row.best_ask), bid: parseFloat(row.best_bid) };
          }
        }
      } else {
        for (const offsetMs of [60000, 30000, 10000, 5000, 2000, 1000, 500]) {
          const targetTs = closeTimeMs - offsetMs;
          if (Math.abs(ts - targetTs) < 500) {
            clobUpAtOffset[offsetMs] = { ask: parseFloat(row.best_ask), bid: parseFloat(row.best_bid) };
          }
        }
      }
    }

    // Find CLOB state at the moment CL crosses below strike
    let clobDownAtCrossing = null;
    let clobUpAtCrossing = null;
    if (firstCrossBelowTs != null) {
      // Find nearest CLOB snapshot BEFORE the crossing
      let bestDown = null, bestDownDist = Infinity;
      let bestUp = null, bestUpDist = Infinity;
      for (const row of clobTicks.rows) {
        const ts = new Date(row.timestamp).getTime();
        if (ts > firstCrossBelowTs) continue; // only look at CLOB BEFORE crossing
        const dist = firstCrossBelowTs - ts;
        const isDown = row.symbol?.toLowerCase().includes('down');
        if (isDown && dist < bestDownDist) { bestDownDist = dist; bestDown = row; }
        if (!isDown && dist < bestUpDist) { bestUpDist = dist; bestUp = row; }
      }
      if (bestDown) clobDownAtCrossing = { ask: parseFloat(bestDown.best_ask), bid: parseFloat(bestDown.best_bid), ageMs: bestDownDist };
      if (bestUp) clobUpAtCrossing = { ask: parseFloat(bestUp.best_ask), bid: parseFloat(bestUp.best_bid), ageMs: bestUpDist };
    }

    // Find polyRef at crossing moment
    let refAtCrossing = null;
    if (firstCrossBelowTs != null) {
      let best = null, bestDist = Infinity;
      for (const row of refTicks.rows) {
        const ts = new Date(row.timestamp).getTime();
        const dist = Math.abs(ts - firstCrossBelowTs);
        if (dist < bestDist) { bestDist = dist; best = row; }
      }
      if (best) refAtCrossing = parseFloat(best.price);
    }

    const timeBeforeClose = firstCrossBelowTs != null ? (closeTimeMs - firstCrossBelowTs) : null;

    crossingEvents.push({
      closeTime, strike, resolved, clAtClose: parseFloat(win.chainlink_price_at_close),
      firstCrossBelowTs, firstCrossBelowPrice, timeBeforeClose,
      clAtOffset, clobDownAtOffset, clobUpAtOffset,
      clobDownAtCrossing, clobUpAtCrossing, refAtCrossing,
      clAboveStrike, lastCLAboveTs,
    });

    // Arb opportunity: CL crossed below strike AND CLOB still shows UP high
    if (firstCrossBelowTs != null && resolved === 'DOWN' && clobDownAtCrossing) {
      const downAsk = clobDownAtCrossing.ask;
      if (downAsk > 0 && downAsk < 0.50) { // DOWN is still cheap = market thinks UP
        arbOpportunities.push({
          closeTime, strike, resolved,
          clCrossPrice: firstCrossBelowPrice,
          timeBeforeCloseMs: timeBeforeClose,
          downAskAtCross: downAsk,
          upAskAtCross: clobUpAtCrossing?.ask,
          clobAgeMs: clobDownAtCrossing.ageMs,
          refAtCross: refAtCrossing,
          deficit: strike - firstCrossBelowPrice,
          pnl: 1.0 - (downAsk + 0.005), // buy DOWN at ask+buffer, settle at $1
        });
      }
    }

    processed++;
    if (processed % 30 === 0) process.stdout.write(`  Processed ${processed}/${allWindows.length}...\r`);
  }
  console.log(`  Processed ${processed}/${allWindows.length} windows                    \n`);

  // ─── Report: CL position at various offsets from close ───
  console.log('  ── CL Position Relative to Strike at Various Times Before Close ──\n');
  console.log('  For DOWN-resolved windows only:');
  console.log('  ─────────────────────────────────────────────────────────────────────');
  console.log('  Offset  │ Windows │ CL < Strike │ CL < Strike % │ Avg Deficit');
  console.log('  ─────────────────────────────────────────────────────────────────────');

  const downWindows = crossingEvents.filter(e => e.resolved === 'DOWN');
  for (const offsetMs of [60000, 30000, 10000, 5000, 2000, 1000, 500]) {
    const withData = downWindows.filter(e => e.clAtOffset[offsetMs] != null);
    const belowStrike = withData.filter(e => e.clAtOffset[offsetMs] < e.strike);
    const deficits = belowStrike.map(e => e.strike - e.clAtOffset[offsetMs]);
    const avgDeficit = deficits.length > 0 ? deficits.reduce((s, v) => s + v, 0) / deficits.length : 0;

    console.log(
      `  T-${String(offsetMs / 1000).padStart(4)}s │ ${String(withData.length).padStart(7)} │ ${String(belowStrike.length).padStart(11)} │ ${pct(belowStrike.length, withData.length).padStart(13)}% │ $${avgDeficit.toFixed(0).padStart(4)}`
    );
  }
  console.log('  ─────────────────────────────────────────────────────────────────────\n');

  // ─── Report: CL crossing timing for DOWN windows ───
  const downWithCrossing = downWindows.filter(e => e.firstCrossBelowTs != null && e.timeBeforeClose != null);
  const downNeverAbove = downWindows.filter(e => !e.clAboveStrike);

  console.log('  ── When Does CL First Cross Below Strike? (DOWN windows only) ──\n');
  console.log(`  DOWN windows: ${downWindows.length}`);
  console.log(`  CL was NEVER above strike in window: ${downNeverAbove.length} (always below — no crossing event)`);
  console.log(`  CL crossed below during window: ${downWithCrossing.length}\n`);

  if (downWithCrossing.length > 0) {
    const timings = downWithCrossing.map(e => e.timeBeforeClose);
    console.log(`  Crossing time before close:`);
    console.log(`    Median: ${(median(timings) / 1000).toFixed(1)}s, Min: ${(Math.min(...timings) / 1000).toFixed(1)}s, Max: ${(Math.max(...timings) / 1000).toFixed(1)}s`);

    const buckets = [
      { label: '> 60s before close', min: 60000 },
      { label: '30-60s before close', min: 30000, max: 60000 },
      { label: '10-30s before close', min: 10000, max: 30000 },
      { label: '5-10s before close', min: 5000, max: 10000 },
      { label: '2-5s before close', min: 2000, max: 5000 },
      { label: '< 2s before close', max: 2000 },
    ];

    console.log('\n  ────────────────────────────────────────────────');
    console.log('  Timing Bucket        │ Count │ % of Crossings');
    console.log('  ────────────────────────────────────────────────');
    for (const b of buckets) {
      const count = downWithCrossing.filter(e => {
        const t = e.timeBeforeClose;
        if (b.min != null && t < b.min) return false;
        if (b.max != null && t >= b.max) return false;
        return true;
      }).length;
      console.log(`  ${b.label.padEnd(22)} │ ${String(count).padStart(5)} │ ${pct(count, downWithCrossing.length).padStart(13)}%`);
    }
    console.log('  ────────────────────────────────────────────────\n');
  }

  // ─── THE KEY QUESTION: Arb Opportunities ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 2: ARB OPPORTUNITIES');
  console.log('  CL < strike AND CLOB still shows DOWN cheap (< $0.50)');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`  Total arb opportunities found: ${arbOpportunities.length}\n`);

  if (arbOpportunities.length > 0) {
    const totalPnl = arbOpportunities.reduce((s, a) => s + a.pnl, 0);
    const avgPnl = totalPnl / arbOpportunities.length;
    const avgDownAsk = arbOpportunities.reduce((s, a) => s + a.downAskAtCross, 0) / arbOpportunities.length;
    const timings = arbOpportunities.map(a => a.timeBeforeCloseMs);

    console.log(`  Summary:`);
    console.log(`    Avg DOWN ask at CL crossing: $${avgDownAsk.toFixed(3)}`);
    console.log(`    Avg profit per trade: $${avgPnl.toFixed(3)}`);
    console.log(`    Total PnL: $${totalPnl.toFixed(2)}`);
    console.log(`    Median time to act: ${(median(timings) / 1000).toFixed(1)}s before close\n`);

    console.log('  Individual opportunities:');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Time (ET)          │ Strike   │ CL Cross │ Deficit │ DN Ask │ UP Ask │ Time Left │ Profit');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');

    for (const a of arbOpportunities) {
      const ts = new Date(a.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const upAsk = a.upAskAtCross != null ? `$${a.upAskAtCross.toFixed(3)}` : '   -   ';

      console.log(
        `  ${et.padEnd(19)} │ $${a.strike.toFixed(0).padStart(7)} │ $${a.clCrossPrice.toFixed(0).padStart(7)} │ $${a.deficit.toFixed(0).padStart(6)} │ $${a.downAskAtCross.toFixed(3)} │ ${upAsk} │ ${(a.timeBeforeCloseMs / 1000).toFixed(1).padStart(7)}s │ $${a.pnl.toFixed(3)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────\n');
  }

  // ─── ALSO: Check windows where CL is below strike for EXTENDED period ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 3: EXTENDED CL-BELOW-STRIKE WINDOWS');
  console.log('  Windows where CL was below strike for 5+ seconds');
  console.log('  AND market still showed UP at high price');
  console.log('═══════════════════════════════════════════════════════════\n');

  // For each DOWN window, check: was CL below strike at T-5s? T-10s?
  // AND was CLOB UP ask > 0.80?
  const extendedArbs = [];
  for (const e of crossingEvents) {
    if (e.resolved !== 'DOWN') continue;
    // CL below strike at T-10s or T-5s, AND CLOB UP ask > 0.80 at same time
    for (const offsetMs of [10000, 5000, 2000, 1000]) {
      const cl = e.clAtOffset[offsetMs];
      const upClob = e.clobUpAtOffset[offsetMs];
      const downClob = e.clobDownAtOffset[offsetMs];
      if (cl == null || upClob == null || downClob == null) continue;
      if (cl < e.strike && upClob.ask > 0.80) {
        extendedArbs.push({
          closeTime: e.closeTime, strike: e.strike, offsetMs,
          cl, deficit: e.strike - cl,
          upAsk: upClob.ask, downAsk: downClob.ask,
          pnl: 1.0 - (downClob.ask + 0.005),
        });
        break; // only count earliest offset per window
      }
    }
  }

  console.log(`  Extended arb opportunities: ${extendedArbs.length}\n`);

  if (extendedArbs.length > 0) {
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');
    console.log('  Time (ET)          │ Strike   │ CL       │ Deficit │ T-offset │ UP Ask │ DN Ask │ PnL');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');

    for (const a of extendedArbs) {
      const ts = new Date(a.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

      console.log(
        `  ${et.padEnd(19)} │ $${a.strike.toFixed(0).padStart(7)} │ $${a.cl.toFixed(0).padStart(7)} │ $${a.deficit.toFixed(0).padStart(6)} │ T-${String(a.offsetMs / 1000).padStart(3)}s  │ $${a.upAsk.toFixed(3)} │ $${a.downAsk.toFixed(3)} │ $${a.pnl.toFixed(3)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────\n');

    const totalExtPnl = extendedArbs.reduce((s, a) => s + a.pnl, 0);
    console.log(`  Total PnL from extended arbs: $${totalExtPnl.toFixed(2)}`);
    console.log(`  Avg PnL per trade: $${(totalExtPnl / extendedArbs.length).toFixed(3)}\n`);
  }

  // ─── Final Summary ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════\n');

  const totalArbs = arbOpportunities.length + extendedArbs.length;
  if (totalArbs > 0) {
    console.log('  CL settlement arb opportunities DO exist.');
    console.log(`  Crossing-based: ${arbOpportunities.length} (CL crosses below strike, CLOB still wrong)`);
    console.log(`  Extended: ${extendedArbs.length} (CL below strike for 5+ seconds, CLOB still showing UP high)`);
    const totalAllPnl = arbOpportunities.reduce((s, a) => s + a.pnl, 0) + extendedArbs.reduce((s, a) => s + a.pnl, 0);
    console.log(`  Combined PnL: $${totalAllPnl.toFixed(2)}`);
  } else {
    console.log('  No CL settlement arb opportunities found.');
    console.log('  Either CL was always below strike (no crossing), or CLOB updated too quickly.');
  }
  console.log();

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('CL-Settlement-Arb failed:', err); pool.end(); process.exit(1); });
