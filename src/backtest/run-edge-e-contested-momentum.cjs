/**
 * Edge E: Contested Windows + CL Momentum
 *
 * Only trade contested windows (DOWN ask ≥ threshold) where CL is ALSO
 * moving in the favourable direction. Combines the dominant CLOB signal
 * with the independent CL trajectory axis.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-e-contested-momentum.cjs
 */

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) { return d > 0 ? (n / d * 100).toFixed(1) : '0.0'; }

async function loadWindows() {
  const rows = await pool.query(`
    SELECT window_close_time, symbol, offset_ms,
           strike_price, chainlink_price, polyref_price,
           clob_down_bid, clob_down_ask, clob_up_bid, clob_up_ask,
           exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
           resolved_direction, chainlink_at_close
    FROM window_backtest_states
    ORDER BY window_close_time ASC, offset_ms DESC
  `);

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
    for (const s of win.samples) {
      s._strike = s.strike_price ? parseFloat(s.strike_price) : null;
      s._cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      s._ref = s.polyref_price ? parseFloat(s.polyref_price) : null;
      s._downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      s._upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;
    }
    // CL trajectory
    const cl120 = win.sampleMap[120000]?._cl;
    const cl60 = win.sampleMap[60000]?._cl;
    const cl30 = win.sampleMap[30000]?._cl;
    const cl10 = win.sampleMap[10000]?._cl;
    win.clDelta_2to1 = (cl120 != null && cl60 != null) ? cl60 - cl120 : null;
    win.clDelta_1to30 = (cl60 != null && cl30 != null) ? cl30 - cl60 : null;
    win.clDelta_30to10 = (cl30 != null && cl10 != null) ? cl10 - cl30 : null;
  }
  return windows;
}

function runStrategy(windows) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE E: Contested + CL Momentum');
  console.log('═══════════════════════════════════════════════════════════\n');

  const sweepGrid = {
    entryOffset: [10000, 30000, 60000],
    minDownAsk: [0.10, 0.15, 0.20, 0.25, 0.30],          // contested threshold
    maxDownAsk: [0.50, 0.60, 0.65, 0.70, 0.80],
    clMomentumWindow: ['2to1', '1to30', '30to10'],        // which CL delta to use
    clMomentumDir: ['FALLING', 'ANY'],                     // CL must be falling (favours DOWN)
    clMomentumMin: [0, 5, 10, 20],                         // min absolute CL movement
  };

  const paramSets = [];
  for (const eo of sweepGrid.entryOffset) {
    for (const mda of sweepGrid.minDownAsk) {
      for (const xda of sweepGrid.maxDownAsk) {
        if (mda >= xda) continue;
        for (const cmw of sweepGrid.clMomentumWindow) {
          for (const cmd of sweepGrid.clMomentumDir) {
            for (const cmm of sweepGrid.clMomentumMin) {
              paramSets.push({ entryOffset: eo, minDownAsk: mda, maxDownAsk: xda, clMomentumWindow: cmw, clMomentumDir: cmd, clMomentumMin: cmm });
            }
          }
        }
      }
    }
  }

  console.log(`  Sweeping ${paramSets.length} parameter combinations...\n`);

  const allResults = [];
  const t0 = Date.now();

  for (const params of paramSets) {
    const trades = [];

    for (const win of windows) {
      const s = win.sampleMap[params.entryOffset];
      if (!s || s._downAsk == null || isNaN(s._downAsk) || s._downAsk <= 0) continue;

      // Contested filter
      if (s._downAsk < params.minDownAsk || s._downAsk >= params.maxDownAsk) continue;

      // CL momentum filter
      let clDelta;
      if (params.clMomentumWindow === '2to1') clDelta = win.clDelta_2to1;
      else if (params.clMomentumWindow === '1to30') clDelta = win.clDelta_1to30;
      else clDelta = win.clDelta_30to10;

      if (clDelta == null) continue;

      if (params.clMomentumDir === 'FALLING' && clDelta > 0) continue; // skip if CL rising
      if (Math.abs(clDelta) < params.clMomentumMin) continue;

      // Buy DOWN
      const fillPrice = s._downAsk + 0.005;
      if (fillPrice >= 1) continue;
      const won = win.resolved === 'DOWN';
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;

      trades.push({ closeTime: win.closeTime, fillPrice, won, pnl, downAsk: s._downAsk, clDelta, resolved: win.resolved });
    }

    if (trades.length === 0) continue;

    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

    allResults.push({ params, tradeCount: trades.length, wins, winRate: wr, avgEntry, ev, totalPnl, trades });
  }

  const sweepMs = Date.now() - t0;
  allResults.sort((a, b) => b.ev - a.ev);

  const profitable = allResults.filter(r => r.ev > 0);
  console.log(`  Sweep: ${paramSets.length} configs in ${sweepMs}ms`);
  console.log(`  ${allResults.length}/${paramSets.length} produced trades, ${profitable.length} show +EV\n`);

  if (allResults.length > 0) {
    console.log('  Top 25 by EV/trade:');
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ MinAsk │ MaxAsk │ CLWin    │ CLDir   │ CLMin │ Trades │ WinRate │ AvgEntry │ EV/Trade');
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 25);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.entryOffset / 1000).padStart(4)}s │ ${p.minDownAsk.toFixed(2).padStart(6)} │ ${p.maxDownAsk.toFixed(2).padStart(6)} │ ${p.clMomentumWindow.padEnd(8)} │ ${p.clMomentumDir.padEnd(7)} │ $${String(p.clMomentumMin).padStart(3)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)}`
      );
    }
    console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────');

    const best = allResults[0];
    console.log(`\n  BEST: offset=${best.params.entryOffset / 1000}s, downAsk=[${best.params.minDownAsk},${best.params.maxDownAsk}), clWin=${best.params.clMomentumWindow}, clDir=${best.params.clMomentumDir}, clMin=$${best.params.clMomentumMin}`);
    console.log(`    ${best.tradeCount} trades, ${best.wins} wins, WR=${(best.winRate * 100).toFixed(1)}%, EV=$${best.ev.toFixed(4)}, PnL=$${best.totalPnl.toFixed(2)}\n`);

    if (best.trades.length <= 30) {
      console.log('  Trade log:');
      for (const t of best.trades) {
        const ts = new Date(t.closeTime);
        const et = ts.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const pnlStr = t.pnl >= 0 ? `\x1b[32m+$${t.pnl.toFixed(3)}\x1b[0m` : `\x1b[31m-$${Math.abs(t.pnl).toFixed(3)}\x1b[0m`;
        console.log(`    ${et} | ask=${t.downAsk.toFixed(3)} | clΔ=$${t.clDelta.toFixed(1).padStart(6)} | ${t.resolved.padEnd(4)} | ${pnlStr}`);
      }
    }
  }

  // Key finding: does CL momentum ADD to contested-only?
  console.log('\n  ── Does CL Momentum Add Value to Contested Filter? ──\n');
  const contestedOnly = allResults.filter(r => r.params.clMomentumDir === 'ANY' && r.params.clMomentumMin === 0);
  const withMomentum = allResults.filter(r => r.params.clMomentumDir === 'FALLING' && r.params.clMomentumMin > 0);
  if (contestedOnly.length > 0 && withMomentum.length > 0) {
    console.log(`  Contested only (no momentum filter): best EV=$${contestedOnly[0].ev.toFixed(4)}, median EV=$${median(contestedOnly.map(r => r.ev))?.toFixed(4)}`);
    console.log(`  + CL falling filter:                 best EV=$${withMomentum[0].ev.toFixed(4)}, median EV=$${median(withMomentum.map(r => r.ev))?.toFixed(4)}`);
  }
  console.log();
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  EDGE E: Contested Windows + CL Momentum                 ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);
  runStrategy(windows);
  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Edge-E failed:', err); pool.end(); process.exit(1); });
