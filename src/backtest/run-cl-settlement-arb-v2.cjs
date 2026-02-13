/**
 * Chainlink Settlement Arb v2 — Clean Signal Analysis
 *
 * Core question: At each time offset before close, if CL is below strike,
 * what is the CLOB showing and what's the PnL if we buy DOWN?
 *
 * Also checks false positives: CL below strike but resolves UP.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-cl-settlement-arb-v2.cjs
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
function p(v, d = 0) { return v != null ? (typeof v === 'number' ? v.toFixed(d) : String(v)) : '-'; }

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  CL SETTLEMENT ARB v2                                    ║');
  console.log('║  At each offset: is CL below strike? What does CLOB say? ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  // Use fast-track table for core data
  const rows = await pool.query(`
    SELECT window_close_time, symbol, offset_ms,
           strike_price, chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_down_mid,
           clob_up_bid, clob_up_ask,
           exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
           resolved_direction, chainlink_at_close
    FROM window_backtest_states
    ORDER BY window_close_time ASC, offset_ms DESC
  `);

  // Group by window
  const windowMap = new Map();
  for (const row of rows.rows) {
    const key = row.window_close_time.toISOString();
    if (!windowMap.has(key)) {
      windowMap.set(key, { closeTime: row.window_close_time, symbol: row.symbol, samples: [], sampleMap: {} });
    }
    const win = windowMap.get(key);
    win.samples.push(row);
    win.sampleMap[row.offset_ms] = row;
  }

  const windows = Array.from(windowMap.values());
  for (const win of windows) {
    win.resolved = win.samples[0]?.resolved_direction;
    const clAtClose = win.samples[0]?.chainlink_at_close;
    const strike = win.samples[0]?.strike_price;
    if (!win.resolved && clAtClose && strike) {
      win.resolved = parseFloat(clAtClose) > parseFloat(strike) ? 'UP' : 'DOWN';
    }
    win.hasClob = win.samples.some(s => s.clob_down_ask != null && parseFloat(s.clob_down_ask) > 0);
  }

  const clobWindows = windows.filter(w => w.hasClob);
  const downWindows = clobWindows.filter(w => w.resolved === 'DOWN');
  const upWindows = clobWindows.filter(w => w.resolved === 'UP');

  console.log(`  Total windows: ${windows.length}`);
  console.log(`  With CLOB data: ${clobWindows.length}`);
  console.log(`  DOWN resolved: ${downWindows.length}, UP resolved: ${upWindows.length}\n`);

  // ═══════════════════════════════════════════════════════════
  // PART 1: At each offset, is CL below strike? Signal accuracy.
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 1: "CL BELOW STRIKE" AS A SIGNAL');
  console.log('  If CL < strike at T-Xs, does DOWN actually resolve?');
  console.log('═══════════════════════════════════════════════════════════\n');

  const offsets = [120000, 60000, 30000, 10000, 5000, 2000, 1000];

  console.log('  ───────────────────────────────────────────────────────────────────────────────────');
  console.log('  Offset  │ CL<Strike │ Resolves DOWN │ Accuracy │ CL>Strike │ Resolves UP │ Accuracy');
  console.log('  ───────────────────────────────────────────────────────────────────────────────────');

  for (const offsetMs of offsets) {
    let clBelowTotal = 0, clBelowDownResolve = 0;
    let clAboveTotal = 0, clAboveUpResolve = 0;

    for (const win of clobWindows) {
      const s = win.sampleMap[offsetMs];
      if (!s) continue;
      const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      const strike = s.strike_price ? parseFloat(s.strike_price) : null;
      if (cl == null || strike == null) continue;

      if (cl < strike) {
        clBelowTotal++;
        if (win.resolved === 'DOWN') clBelowDownResolve++;
      } else {
        clAboveTotal++;
        if (win.resolved === 'UP') clAboveUpResolve++;
      }
    }

    console.log(
      `  T-${String(offsetMs / 1000).padStart(4)}s │ ${String(clBelowTotal).padStart(9)} │ ${String(clBelowDownResolve).padStart(13)} │ ${pct(clBelowDownResolve, clBelowTotal).padStart(7)}% │ ${String(clAboveTotal).padStart(9)} │ ${String(clAboveUpResolve).padStart(11)} │ ${pct(clAboveUpResolve, clAboveTotal).padStart(7)}%`
    );
  }
  console.log('  ───────────────────────────────────────────────────────────────────────────────────\n');

  // ═══════════════════════════════════════════════════════════
  // PART 2: When CL < strike, what does CLOB say? The mispricing.
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 2: CLOB MISPRICING WHEN CL < STRIKE');
  console.log('  When we KNOW it should be DOWN, how is CLOB priced?');
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const offsetMs of [60000, 30000, 10000, 5000, 2000, 1000]) {
    const downAskValues = [];
    const upAskValues = [];
    const surpriseDowns = []; // CL < strike, market thinks UP (DOWN ask < 0.50)

    for (const win of clobWindows) {
      const s = win.sampleMap[offsetMs];
      if (!s) continue;
      const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      const strike = s.strike_price ? parseFloat(s.strike_price) : null;
      const downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      const upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;
      if (cl == null || strike == null || downAsk == null || isNaN(downAsk) || downAsk <= 0) continue;

      if (cl < strike) {
        downAskValues.push({ downAsk, upAsk, cl, strike, deficit: strike - cl, resolved: win.resolved, closeTime: win.closeTime });

        if (downAsk < 0.50) {
          surpriseDowns.push({ downAsk, upAsk, cl, strike, deficit: strike - cl, resolved: win.resolved, closeTime: win.closeTime });
        }
      }
    }

    const resolvedDown = downAskValues.filter(v => v.resolved === 'DOWN');
    const resolvedUp = downAskValues.filter(v => v.resolved === 'UP');

    console.log(`  ── T-${offsetMs / 1000}s: CL < strike (${downAskValues.length} windows) ──`);
    if (downAskValues.length > 0) {
      console.log(`    Median DOWN ask: $${median(downAskValues.map(v => v.downAsk)).toFixed(3)}`);
      console.log(`    Median UP ask:   $${median(downAskValues.filter(v => v.upAsk).map(v => v.upAsk)).toFixed(3)}`);
      console.log(`    Resolve DOWN: ${resolvedDown.length}/${downAskValues.length} (${pct(resolvedDown.length, downAskValues.length)}%)`);
      console.log(`    Resolve UP:   ${resolvedUp.length}/${downAskValues.length} (${pct(resolvedUp.length, downAskValues.length)}%)`);

      // Mispriced subset: market thinks UP (DOWN ask < 0.50) but CL says DOWN
      const mispriced = surpriseDowns.filter(v => v.resolved === 'DOWN');
      const mispricedFalse = surpriseDowns.filter(v => v.resolved === 'UP');
      console.log(`    MISPRICED (DOWN ask < $0.50, CL < strike): ${surpriseDowns.length} windows`);
      console.log(`      → Resolved DOWN (WIN): ${mispriced.length} (${pct(mispriced.length, surpriseDowns.length)}%)`);
      console.log(`      → Resolved UP (LOSS): ${mispricedFalse.length} (${pct(mispricedFalse.length, surpriseDowns.length)}%)`);

      if (mispriced.length > 0) {
        const avgEntry = mispriced.reduce((s, v) => s + v.downAsk, 0) / mispriced.length;
        const avgPnl = mispriced.reduce((s, v) => s + (1.0 - v.downAsk - 0.005), 0) / mispriced.length;
        const losses = mispricedFalse.reduce((s, v) => s + (-(v.downAsk + 0.005)), 0);
        const totalPnl = mispriced.reduce((s, v) => s + (1.0 - v.downAsk - 0.005), 0) + losses;
        const evPerTrade = totalPnl / surpriseDowns.length;

        console.log(`      Avg entry (wins): $${avgEntry.toFixed(3)}`);
        console.log(`      Total PnL: $${totalPnl.toFixed(2)} (${surpriseDowns.length} trades, EV $${evPerTrade.toFixed(3)}/trade)`);
      }
    }
    console.log();
  }

  // ═══════════════════════════════════════════════════════════
  // PART 3: Deficit buckets — does deeper CL < strike predict better?
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 3: DEFICIT BUCKETS AT T-10s');
  console.log('  Does deeper CL-below-strike predict DOWN better?');
  console.log('═══════════════════════════════════════════════════════════\n');

  const deficitBuckets = [
    { label: '$0-$20 below', min: 0, max: 20 },
    { label: '$20-$50 below', min: 20, max: 50 },
    { label: '$50-$100 below', min: 50, max: 100 },
    { label: '$100-$200 below', min: 100, max: 200 },
    { label: '$200-$500 below', min: 200, max: 500 },
    { label: '$500+ below', min: 500 },
  ];

  console.log('  ────────────────────────────────────────────────────────────────────────────────');
  console.log('  Deficit Bucket     │ Windows │ DOWN │ DOWN% │ Med DN Ask │ Med UP Ask │ EV/trade');
  console.log('  ────────────────────────────────────────────────────────────────────────────────');

  for (const bucket of deficitBuckets) {
    const matching = [];
    for (const win of clobWindows) {
      const s = win.sampleMap[10000];
      if (!s) continue;
      const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      const strike = s.strike_price ? parseFloat(s.strike_price) : null;
      const downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      if (cl == null || strike == null || downAsk == null || isNaN(downAsk) || downAsk <= 0) continue;
      if (cl >= strike) continue;

      const deficit = strike - cl;
      if (deficit < bucket.min) continue;
      if (bucket.max != null && deficit >= bucket.max) continue;

      matching.push({ downAsk, upAsk: s.clob_up_ask ? parseFloat(s.clob_up_ask) : null, deficit, resolved: win.resolved, closeTime: win.closeTime });
    }

    const downCount = matching.filter(v => v.resolved === 'DOWN').length;
    const medDnAsk = median(matching.map(v => v.downAsk));
    const medUpAsk = median(matching.filter(v => v.upAsk).map(v => v.upAsk));

    // EV per trade: buy DOWN at ask+0.005 for every match
    let totalPnl = 0;
    for (const m of matching) {
      const fill = m.downAsk + 0.005;
      if (m.resolved === 'DOWN') totalPnl += (1.0 - fill);
      else totalPnl -= fill;
    }
    const evPerTrade = matching.length > 0 ? totalPnl / matching.length : 0;

    console.log(
      `  ${bucket.label.padEnd(20)} │ ${String(matching.length).padStart(7)} │ ${String(downCount).padStart(4)} │ ${pct(downCount, matching.length).padStart(4)}% │ $${medDnAsk != null ? medDnAsk.toFixed(3).padStart(8) : '   -    '} │ $${medUpAsk != null ? medUpAsk.toFixed(3).padStart(8) : '   -    '} │ $${evPerTrade.toFixed(3).padStart(7)}`
    );
  }
  console.log('  ────────────────────────────────────────────────────────────────────────────────\n');

  // ═══════════════════════════════════════════════════════════
  // PART 4: Tradeable signal — the strategy
  // Buy DOWN when: CL < strike at T-Xs AND DOWN ask < threshold
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 4: STRATEGY SWEEP');
  console.log('  Buy DOWN when CL < strike AND DOWN ask < maxPrice');
  console.log('═══════════════════════════════════════════════════════════\n');

  const sweepResults = [];
  const stratOffsets = [60000, 30000, 10000, 5000, 2000, 1000];
  const maxPrices = [0.30, 0.40, 0.50, 0.60, 0.70, 0.80];
  const minDeficits = [0, 20, 50, 80, 100];

  for (const offsetMs of stratOffsets) {
    for (const maxPrice of maxPrices) {
      for (const minDeficit of minDeficits) {
        const trades = [];

        for (const win of clobWindows) {
          const s = win.sampleMap[offsetMs];
          if (!s) continue;
          const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
          const strike = s.strike_price ? parseFloat(s.strike_price) : null;
          const downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
          if (cl == null || strike == null || downAsk == null || isNaN(downAsk) || downAsk <= 0) continue;
          if (cl >= strike) continue;
          if (downAsk >= maxPrice) continue;

          const deficit = strike - cl;
          if (deficit < minDeficit) continue;

          const fill = downAsk + 0.005;
          if (fill >= 1) continue;
          const won = win.resolved === 'DOWN';
          const pnl = won ? (1.0 - fill) : -fill;
          trades.push({ fill, won, pnl, downAsk, deficit });
        }

        if (trades.length === 0) continue;
        const wins = trades.filter(t => t.won).length;
        const wr = wins / trades.length;
        const avgEntry = trades.reduce((s, t) => s + t.fill, 0) / trades.length;
        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const ev = totalPnl / trades.length;

        sweepResults.push({
          offsetMs, maxPrice, minDeficit,
          trades: trades.length, wins, wr, avgEntry, totalPnl, ev
        });
      }
    }
  }

  sweepResults.sort((a, b) => b.ev - a.ev);
  const profitable = sweepResults.filter(r => r.ev > 0);

  console.log(`  ${sweepResults.length} configs tested, ${profitable.length} show +EV\n`);

  // Top 30
  console.log('  Top 30 by EV/trade:');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');
  console.log('  Rank │ Offset │ MaxPx │ MinDef │ Trades │ Wins │ WinRate │ AvgEntry │ EV/trade │ PnL');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < Math.min(30, sweepResults.length); i++) {
    const r = sweepResults[i];
    console.log(
      `  ${String(i + 1).padStart(4)} │ T-${String(r.offsetMs / 1000).padStart(3)}s │ $${r.maxPrice.toFixed(2)} │ $${String(r.minDeficit).padStart(4)} │ ${String(r.trades).padStart(6)} │ ${String(r.wins).padStart(4)} │ ${(r.wr * 100).toFixed(1).padStart(6)}% │ $${r.avgEntry.toFixed(3).padStart(7)} │ $${r.ev.toFixed(3).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────────────\n');

  // Also show configs with >5 trades and best EV
  const significant = sweepResults.filter(r => r.trades >= 5 && r.ev > 0);
  significant.sort((a, b) => b.ev - a.ev);

  console.log(`  Configs with 5+ trades and +EV: ${significant.length}\n`);
  if (significant.length > 0) {
    console.log('  Top 20 (5+ trades):');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ MaxPx │ MinDef │ Trades │ Wins │ WinRate │ AvgEntry │ EV/trade │ PnL');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────');

    for (let i = 0; i < Math.min(20, significant.length); i++) {
      const r = significant[i];
      console.log(
        `  ${String(i + 1).padStart(4)} │ T-${String(r.offsetMs / 1000).padStart(3)}s │ $${r.maxPrice.toFixed(2)} │ $${String(r.minDeficit).padStart(4)} │ ${String(r.trades).padStart(6)} │ ${String(r.wins).padStart(4)} │ ${(r.wr * 100).toFixed(1).padStart(6)}% │ $${r.avgEntry.toFixed(3).padStart(7)} │ $${r.ev.toFixed(3).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────\n');
  }

  // ═══════════════════════════════════════════════════════════
  // PART 5: Individual "surprise DOWN" windows
  // CL < strike at T-10s AND DOWN ask < 0.50 AND resolves DOWN
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 5: SURPRISE DOWN WINDOWS (T-10s, DOWN ask < $0.50)');
  console.log('  These are the "UP at 93+ and it closes DOWN" events');
  console.log('═══════════════════════════════════════════════════════════\n');

  const surprises = [];
  for (const win of clobWindows) {
    const s = win.sampleMap[10000];
    if (!s) continue;
    const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
    const strike = s.strike_price ? parseFloat(s.strike_price) : null;
    const downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
    const upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;
    const ref = s.polyref_price ? parseFloat(s.polyref_price) : null;
    if (cl == null || strike == null || downAsk == null || isNaN(downAsk) || downAsk <= 0) continue;
    if (cl >= strike) continue;
    if (downAsk >= 0.50) continue; // market thinks UP

    const deficit = strike - cl;
    const fill = downAsk + 0.005;
    const won = win.resolved === 'DOWN';
    const pnl = won ? (1.0 - fill) : -fill;

    surprises.push({
      closeTime: win.closeTime, strike, cl, ref, deficit,
      downAsk, upAsk, resolved: win.resolved, won, pnl
    });
  }

  console.log(`  Total "surprise" setups at T-10s: ${surprises.length}`);
  console.log(`  Wins (resolve DOWN): ${surprises.filter(s => s.won).length}`);
  console.log(`  Losses (resolve UP): ${surprises.filter(s => !s.won).length}\n`);

  if (surprises.length > 0) {
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Time (ET)          │ Strike   │ CL       │ Ref      │ Deficit │ DN Ask │ UP Ask │ Result │ PnL');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');

    for (const s of surprises) {
      const ts = new Date(s.closeTime);
      const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

      console.log(
        `  ${et.padEnd(19)} │ $${s.strike.toFixed(0).padStart(7)} │ $${s.cl.toFixed(0).padStart(7)} │ $${s.ref != null ? s.ref.toFixed(0).padStart(7) : '      -'} │ $${s.deficit.toFixed(0).padStart(6)} │ $${s.downAsk.toFixed(3)} │ $${s.upAsk != null ? s.upAsk.toFixed(3) : '  -  '} │ ${(s.won ? 'WIN ' : 'LOSS').padStart(4)}  │ $${s.pnl.toFixed(3).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────');

    const totalPnl = surprises.reduce((s, v) => s + v.pnl, 0);
    const avgPnl = totalPnl / surprises.length;
    console.log(`\n  Total PnL: $${totalPnl.toFixed(2)}, Avg: $${avgPnl.toFixed(3)}/trade\n`);
  }

  // ═══════════════════════════════════════════════════════════
  // PART 6: BROADER — any time CL < strike AND contested
  // Check at T-5s, T-2s, T-1s too for tighter signals
  // ═══════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PART 6: CL < STRIKE SIGNAL ACROSS ALL TIME OFFSETS');
  console.log('  Buy DOWN whenever CL < strike AND DOWN ask < $0.50');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log('  Offset │ Setups │ Wins │ Losses │ WinRate │ Avg Entry │ EV/trade │ PnL');
  console.log('  ──────────────────────────────────────────────────────────────────────');

  for (const offsetMs of [60000, 30000, 10000, 5000, 2000, 1000]) {
    const trades = [];
    for (const win of clobWindows) {
      const s = win.sampleMap[offsetMs];
      if (!s) continue;
      const cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      const strike = s.strike_price ? parseFloat(s.strike_price) : null;
      const downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      if (cl == null || strike == null || downAsk == null || isNaN(downAsk) || downAsk <= 0) continue;
      if (cl >= strike) continue;
      if (downAsk >= 0.50) continue;

      const fill = downAsk + 0.005;
      if (fill >= 1) continue;
      const won = win.resolved === 'DOWN';
      const pnl = won ? (1.0 - fill) : -fill;
      trades.push({ fill, won, pnl });
    }

    if (trades.length === 0) {
      console.log(`  T-${String(offsetMs / 1000).padStart(4)}s │ ${String(0).padStart(6)} │    - │      - │       - │         - │        - │     -`);
      continue;
    }
    const wins = trades.filter(t => t.won).length;
    const losses = trades.length - wins;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fill, 0) / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const ev = totalPnl / trades.length;

    console.log(
      `  T-${String(offsetMs / 1000).padStart(4)}s │ ${String(trades.length).padStart(6)} │ ${String(wins).padStart(4)} │ ${String(losses).padStart(6)} │ ${(wr * 100).toFixed(1).padStart(6)}% │ $${avgEntry.toFixed(3).padStart(7)} │ $${ev.toFixed(3).padStart(7)} │ $${totalPnl.toFixed(2).padStart(5)}`
    );
  }
  console.log('  ──────────────────────────────────────────────────────────────────────\n');

  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('CL-Settlement-Arb-v2 failed:', err); pool.end(); process.exit(1); });
