/**
 * Settlement Arb — All Instruments (BTC, ETH, SOL, XRP)
 *
 * Uses Pyth oracle ticks as the settlement proxy for all instruments.
 * (Pyth agrees 100% with Chainlink on BTC resolution direction.)
 *
 * For each window: load last 120s of Pyth + CLOB tick data,
 * build second-by-second timeline, test the settlement arb signal.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-settlement-arb-all-instruments.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

// Map window_close_events symbol to CLOB symbol patterns and RTDS symbol
const INSTRUMENT_CONFIG = {
  btc: { rtdsSymbol: 'btc', clobDown: s => s.toLowerCase().includes('btc') && s.toLowerCase().includes('down') },
  eth: { rtdsSymbol: 'eth', clobDown: s => s.toLowerCase().includes('eth') && s.toLowerCase().includes('down') },
  sol: { rtdsSymbol: 'sol', clobDown: s => s.toLowerCase().includes('sol') && s.toLowerCase().includes('down') },
  xrp: { rtdsSymbol: 'xrp', clobDown: s => s.toLowerCase().includes('xrp') && s.toLowerCase().includes('down') },
};

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  SETTLEMENT ARB — ALL INSTRUMENTS (Pyth Oracle)         ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  // Load ALL windows with resolved direction (Pyth-based or CL-based)
  const windowsRes = await pool.query(`
    SELECT id, window_close_time, symbol, strike_price,
           oracle_price_at_close, pyth_price_at_close, chainlink_price_at_close,
           resolved_direction
    FROM window_close_events
    WHERE strike_price IS NOT NULL AND strike_price > 0
      AND resolved_direction IS NOT NULL
    ORDER BY symbol, window_close_time ASC
  `);

  const allWindows = windowsRes.rows;
  console.log(`  Total resolved windows: ${allWindows.length}`);

  // Count by instrument
  const bySym = {};
  for (const w of allWindows) {
    bySym[w.symbol] = (bySym[w.symbol] || 0) + 1;
  }
  for (const [sym, cnt] of Object.entries(bySym)) {
    console.log(`    ${sym}: ${cnt} windows`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════════
  // Process each instrument separately
  // ═══════════════════════════════════════════════════════════

  const instrumentResults = {};

  for (const [instrument, config] of Object.entries(INSTRUMENT_CONFIG)) {
    const instWindows = allWindows.filter(w => w.symbol === instrument);
    if (instWindows.length === 0) continue;

    console.log(`  Processing ${instrument.toUpperCase()}: ${instWindows.length} windows...`);

    const analyses = [];
    let processed = 0;

    for (const win of instWindows) {
      const closeTimeMs = new Date(win.window_close_time).getTime();
      const strike = parseFloat(win.strike_price);
      const resolved = win.resolved_direction.toUpperCase();
      const lookbackMs = 120000;
      const startTime = new Date(closeTimeMs - lookbackMs);

      // Load Pyth ticks + CLOB snapshots in parallel
      // For BTC also try Chainlink
      const oracleTopic = instrument === 'btc' ? 'crypto_prices_chainlink' : 'crypto_prices_pyth';

      const windowEpoch = Math.floor(closeTimeMs / 1000) - 900;
      const [oracleRes, clobRes] = await Promise.all([
        pool.query(`
          SELECT timestamp, price FROM rtds_ticks
          WHERE timestamp >= $1 AND timestamp <= $2
            AND topic = $3 AND symbol = $4
          ORDER BY timestamp ASC
        `, [startTime, win.window_close_time, oracleTopic, config.rtdsSymbol]),
        pool.query(`
          SELECT timestamp, symbol, best_bid, best_ask FROM clob_price_snapshots
          WHERE timestamp >= $1 AND timestamp <= $2
            AND window_epoch = $3
          ORDER BY timestamp ASC
        `, [startTime, win.window_close_time, windowEpoch]),
      ]);

      if (oracleRes.rows.length === 0) { processed++; continue; }

      const oracleTicks = oracleRes.rows.map(r => ({ ts: new Date(r.timestamp).getTime(), price: parseFloat(r.price) }));
      const clobTicks = clobRes.rows
        .filter(r => r.symbol.toLowerCase().includes(instrument))
        .map(r => ({
          ts: new Date(r.timestamp).getTime(),
          isDown: config.clobDown(r.symbol),
          ask: parseFloat(r.best_ask),
          bid: parseFloat(r.best_bid),
        }));

      // Build second-by-second timeline
      const oracleBelowAt = {};
      const clobStateAt = {};

      for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
        const targetMs = closeTimeMs - (sec * 1000);

        // Latest oracle tick at or before this second
        let latestOracle = null;
        for (let i = oracleTicks.length - 1; i >= 0; i--) {
          if (oracleTicks[i].ts <= targetMs) { latestOracle = oracleTicks[i]; break; }
        }

        // Latest CLOB DOWN tick
        let latestDown = null;
        for (let i = clobTicks.length - 1; i >= 0; i--) {
          if (clobTicks[i].ts <= targetMs && clobTicks[i].isDown) { latestDown = clobTicks[i]; break; }
        }

        if (latestOracle) {
          oracleBelowAt[sec] = latestOracle.price < strike;
          clobStateAt[sec] = {
            oraclePrice: latestOracle.price,
            deficit: strike - latestOracle.price,
            downAsk: latestDown?.ask ?? null,
            downBid: latestDown?.bid ?? null,
          };
        }
      }

      analyses.push({
        closeTime: win.window_close_time, strike, resolved, instrument,
        oracleBelowAt, clobStateAt,
        hasClobData: clobTicks.length > 0,
        oracleAtClose: parseFloat(win.oracle_price_at_close || win.pyth_price_at_close || win.chainlink_price_at_close || 0),
      });

      processed++;
      if (processed % 30 === 0) process.stdout.write(`    ${instrument.toUpperCase()}: ${processed}/${instWindows.length}...\r`);
    }
    console.log(`    ${instrument.toUpperCase()}: ${processed} processed                    `);

    instrumentResults[instrument] = analyses;
  }

  console.log();

  // ═══════════════════════════════════════════════════════════
  // Report per instrument
  // ═══════════════════════════════════════════════════════════

  for (const [instrument, analyses] of Object.entries(instrumentResults)) {
    const withClob = analyses.filter(w => w.hasClobData);

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ${instrument.toUpperCase()} — ${analyses.length} windows (${withClob.length} with CLOB)`);
    console.log('═══════════════════════════════════════════════════════════\n');

    const downCount = analyses.filter(w => w.resolved === 'DOWN').length;
    const upCount = analyses.filter(w => w.resolved === 'UP').length;
    console.log(`  Resolution: DOWN=${downCount} (${pct(downCount, analyses.length)}%), UP=${upCount}\n`);

    // Part 1: Signal accuracy
    console.log('  ── Oracle < Strike Signal Accuracy ──');
    console.log('  Offset │ Ora<Str │ →DOWN │ Acc%   │ Ora>Str │ →UP │ Acc%');
    console.log('  ──────────────────────────────────────────────────────────');

    for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
      let belowTotal = 0, belowDown = 0;
      let aboveTotal = 0, aboveUp = 0;

      for (const w of analyses) {
        const below = w.oracleBelowAt[sec];
        if (below === undefined) continue;
        if (below) {
          belowTotal++;
          if (w.resolved === 'DOWN') belowDown++;
        } else {
          aboveTotal++;
          if (w.resolved === 'UP') aboveUp++;
        }
      }

      console.log(
        `  T-${String(sec).padStart(3)}s │ ${String(belowTotal).padStart(7)} │ ${String(belowDown).padStart(5)} │ ${pct(belowDown, belowTotal).padStart(5)}% │ ${String(aboveTotal).padStart(7)} │ ${String(aboveUp).padStart(3)} │ ${pct(aboveUp, aboveTotal).padStart(5)}%`
      );
    }
    console.log();

    // Part 2: Strategy — Buy DOWN when oracle < strike AND DOWN ask < threshold
    for (const maxAsk of [0.50, 0.70, 0.90]) {
      console.log(`  ── Strategy: Buy DOWN when Oracle<Strike + DN ask < $${maxAsk.toFixed(2)} ──`);
      console.log('  Entry  │ Setups │ Wins │ Losses │ WinRate │ Avg Entry │ EV/trade │ Total PnL');
      console.log('  ────────────────────────────────────────────────────────────────────────────');

      for (const sec of [60, 30, 10, 5, 3, 2, 1]) {
        const trades = [];
        for (const w of withClob) {
          if (w.oracleBelowAt[sec] !== true) continue;
          const st = w.clobStateAt[sec];
          if (!st || st.downAsk == null || isNaN(st.downAsk) || st.downAsk <= 0 || st.downAsk >= maxAsk) continue;

          const fill = st.downAsk + 0.005;
          if (fill >= 1) continue;
          const won = w.resolved === 'DOWN';
          const pnl = won ? (1.0 - fill) : -fill;
          trades.push({ fill, won, pnl, closeTime: w.closeTime, strike: w.strike, oraclePrice: st.oraclePrice, deficit: st.deficit, downAsk: st.downAsk });
        }

        if (trades.length === 0) {
          console.log(`  T-${String(sec).padStart(3)}s │      0 │    - │      - │       - │         - │        - │         -`);
          continue;
        }
        const wins = trades.filter(t => t.won).length;
        const losses = trades.length - wins;
        const wr = wins / trades.length;
        const avgEntry = trades.reduce((s, t) => s + t.fill, 0) / trades.length;
        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const ev = totalPnl / trades.length;

        console.log(
          `  T-${String(sec).padStart(3)}s │ ${String(trades.length).padStart(6)} │ ${String(wins).padStart(4)} │ ${String(losses).padStart(6)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ $${avgEntry.toFixed(3).padStart(7)} │ $${ev.toFixed(3).padStart(7)} │ $${totalPnl.toFixed(2).padStart(8)}`
        );
      }
      console.log();
    }

    // Part 3: Individual arb trades at T-5s and T-3s (if any)
    for (const sec of [10, 5, 3, 2]) {
      const trades = [];
      for (const w of withClob) {
        if (w.oracleBelowAt[sec] !== true) continue;
        const st = w.clobStateAt[sec];
        if (!st || st.downAsk == null || isNaN(st.downAsk) || st.downAsk <= 0 || st.downAsk >= 0.50) continue;

        const fill = st.downAsk + 0.005;
        if (fill >= 1) continue;
        const won = w.resolved === 'DOWN';
        const pnl = won ? (1.0 - fill) : -fill;
        trades.push({
          closeTime: w.closeTime, strike: w.strike, oraclePrice: st.oraclePrice,
          deficit: st.deficit, downAsk: st.downAsk, won, pnl, resolved: w.resolved,
        });
      }

      if (trades.length > 0) {
        console.log(`  ── Individual Arb Trades at T-${sec}s (DN ask < $0.50) ──`);
        console.log('  Time (ET)          │ Strike     │ Oracle     │ Deficit │ DN Ask │ Result │ PnL');
        console.log('  ───────────────────────────────────────────────────────────────────────────────');
        for (const e of trades) {
          const ts = new Date(e.closeTime);
          const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          console.log(
            `  ${et.padEnd(19)} │ $${e.strike.toFixed(2).padStart(9)} │ $${e.oraclePrice.toFixed(2).padStart(9)} │ $${e.deficit.toFixed(2).padStart(6)} │ $${e.downAsk.toFixed(3)} │ ${(e.won ? 'WIN ' : 'LOSS').padStart(4)}  │ $${e.pnl.toFixed(3).padStart(7)}`
          );
        }
        console.log();
      }
    }

    // Part 4: False positives (oracle < strike but resolves UP)
    const fps = [];
    for (const sec of [10, 5, 3, 2, 1]) {
      for (const w of analyses) {
        if (w.resolved === 'UP' && w.oracleBelowAt[sec] === true) {
          fps.push({ sec, closeTime: w.closeTime, strike: w.strike, oraclePrice: w.clobStateAt[sec]?.oraclePrice, deficit: w.clobStateAt[sec]?.deficit });
        }
      }
    }

    // Deduplicate by closeTime (show earliest offset)
    const fpByTime = {};
    for (const fp of fps) {
      if (!fpByTime[fp.closeTime] || fp.sec > fpByTime[fp.closeTime].sec) {
        fpByTime[fp.closeTime] = fp;
      }
    }
    const uniqueFps = Object.values(fpByTime);

    if (uniqueFps.length > 0) {
      console.log(`  ── False Positives: Oracle<Strike but resolves UP (${uniqueFps.length} total) ──`);
      console.log('  Time (ET)          │ Earliest │ Strike     │ Oracle     │ Deficit');
      console.log('  ─────────────────────────────────────────────────────────────────');
      for (const fp of uniqueFps) {
        const ts = new Date(fp.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        console.log(
          `  ${et.padEnd(19)} │ T-${String(fp.sec).padStart(3)}s  │ $${(fp.oraclePrice ? fp.strike.toFixed(2) : '-').padStart(9)} │ $${(fp.oraclePrice ? fp.oraclePrice.toFixed(2) : '-').padStart(9)} │ $${(fp.deficit ? fp.deficit.toFixed(2) : '-').padStart(6)}`
        );
      }
      console.log();
    } else {
      console.log('  No false positives found (oracle < strike always → DOWN)\n');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Cross-instrument comparison
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  CROSS-INSTRUMENT COMPARISON');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('  ── Signal Accuracy at T-5s ──');
  console.log('  Instrument │ Ora<Str │ →DOWN │ Acc%   │ Ora>Str │ →UP │ Acc%');
  console.log('  ───────────────────────────────────────────────────────────');

  for (const [instrument, analyses] of Object.entries(instrumentResults)) {
    let belowTotal = 0, belowDown = 0, aboveTotal = 0, aboveUp = 0;
    for (const w of analyses) {
      const below = w.oracleBelowAt[5];
      if (below === undefined) continue;
      if (below) { belowTotal++; if (w.resolved === 'DOWN') belowDown++; }
      else { aboveTotal++; if (w.resolved === 'UP') aboveUp++; }
    }
    console.log(
      `  ${instrument.toUpperCase().padEnd(10)} │ ${String(belowTotal).padStart(7)} │ ${String(belowDown).padStart(5)} │ ${pct(belowDown, belowTotal).padStart(5)}% │ ${String(aboveTotal).padStart(7)} │ ${String(aboveUp).padStart(3)} │ ${pct(aboveUp, aboveTotal).padStart(5)}%`
    );
  }
  console.log();

  console.log('  ── Arb PnL at T-5s (DN ask < $0.50) ──');
  console.log('  Instrument │ Trades │ Wins │ WinRate │ EV/trade │ Total PnL');
  console.log('  ─────────────────────────────────────────────────────────');

  for (const [instrument, analyses] of Object.entries(instrumentResults)) {
    const withClob = analyses.filter(w => w.hasClobData);
    const trades = [];
    for (const w of withClob) {
      if (w.oracleBelowAt[5] !== true) continue;
      const st = w.clobStateAt[5];
      if (!st || st.downAsk == null || isNaN(st.downAsk) || st.downAsk <= 0 || st.downAsk >= 0.50) continue;
      const fill = st.downAsk + 0.005;
      if (fill >= 1) continue;
      const won = w.resolved === 'DOWN';
      const pnl = won ? (1.0 - fill) : -fill;
      trades.push({ won, pnl });
    }

    if (trades.length === 0) {
      console.log(`  ${instrument.toUpperCase().padEnd(10)} │      0 │    - │       - │        - │         -`);
      continue;
    }
    const wins = trades.filter(t => t.won).length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const ev = totalPnl / trades.length;
    console.log(
      `  ${instrument.toUpperCase().padEnd(10)} │ ${String(trades.length).padStart(6)} │ ${String(wins).padStart(4)} │ ${(wins / trades.length * 100).toFixed(1).padStart(6)}% │ $${ev.toFixed(3).padStart(7)} │ $${totalPnl.toFixed(2).padStart(8)}`
    );
  }
  console.log();

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Settlement arb analysis failed:', err); pool.end(); process.exit(1); });
