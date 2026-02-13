/**
 * Edge M: CLOB-Era Only — Clean Data Split
 *
 * The overall dataset blends CLOB-era (42.2% DOWN) and pre-CLOB (67.6% DOWN).
 * This skews all analysis. Here we re-run Edge C and Edge D using ONLY windows
 * that have CLOB data, to see if the strategies still work in the more
 * efficient CLOB-era market.
 *
 * This is the most honest test of whether our edge is real.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node src/backtest/run-edge-m-clob-era.cjs
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
           clob_down_bid, clob_down_ask, clob_down_mid,
           clob_up_bid, clob_up_ask,
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

    // Determine if this window has CLOB data
    win.hasClob = false;
    for (const s of win.samples) {
      s._strike = s.strike_price ? parseFloat(s.strike_price) : null;
      s._cl = s.chainlink_price ? parseFloat(s.chainlink_price) : null;
      s._ref = s.polyref_price ? parseFloat(s.polyref_price) : null;
      s._downAsk = s.clob_down_ask ? parseFloat(s.clob_down_ask) : null;
      s._upAsk = s.clob_up_ask ? parseFloat(s.clob_up_ask) : null;
      s._deficit = (s._strike != null && s._cl != null) ? s._strike - s._cl : null;

      if (s._downAsk != null && !isNaN(s._downAsk) && s._downAsk > 0) {
        win.hasClob = true;
      }
    }
  }
  return windows;
}

function runAnalysis(windows) {
  const allWindows = windows;
  const clobWindows = windows.filter(w => w.hasClob);
  const noClobWindows = windows.filter(w => !w.hasClob);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DATA SPLIT ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════\n');

  const allDown = allWindows.filter(w => w.resolved === 'DOWN').length;
  const clobDown = clobWindows.filter(w => w.resolved === 'DOWN').length;
  const noClobDown = noClobWindows.filter(w => w.resolved === 'DOWN').length;

  console.log(`  ALL windows:     ${allWindows.length} (DOWN=${allDown}, ${pct(allDown, allWindows.length)}%)`);
  console.log(`  CLOB-era:        ${clobWindows.length} (DOWN=${clobDown}, ${pct(clobDown, clobWindows.length)}%)`);
  console.log(`  Pre-CLOB:        ${noClobWindows.length} (DOWN=${noClobDown}, ${pct(noClobDown, noClobWindows.length)}%)\n`);

  // ─── Edge C on CLOB-era only ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE C — CLOB ERA ONLY');
  console.log('═══════════════════════════════════════════════════════════\n');

  runEdgeCSweep(clobWindows, 'CLOB-ERA');

  // ─── Edge C on ALL windows ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE C — ALL WINDOWS (for comparison)');
  console.log('═══════════════════════════════════════════════════════════\n');

  runEdgeCSweep(allWindows, 'ALL');

  // ─── Edge D on CLOB-era only ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE D (Buy Cheap DOWN) — CLOB ERA ONLY');
  console.log('═══════════════════════════════════════════════════════════\n');

  runEdgeDSweep(clobWindows, 'CLOB-ERA');

  // ─── Edge D on ALL ───
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  EDGE D (Buy Cheap DOWN) — ALL WINDOWS');
  console.log('═══════════════════════════════════════════════════════════\n');

  runEdgeDSweep(allWindows, 'ALL');
}

function runEdgeCSweep(windows, label) {
  const sweepGrid = {
    entryOffset: [30000, 60000, 120000],
    deficitThreshold: [40, 60, 80, 100, 120],
    nearStrikeThreshold: [50, 100, 150, 200],
    maxDownPrice: [0.50, 0.60, 0.65, 0.70, 0.80],
  };

  const paramSets = [];
  for (const eo of sweepGrid.entryOffset) {
    for (const dt of sweepGrid.deficitThreshold) {
      for (const nst of sweepGrid.nearStrikeThreshold) {
        for (const mdp of sweepGrid.maxDownPrice) {
          paramSets.push({ entryOffset: eo, deficitThreshold: dt, nearStrikeThreshold: nst, maxDownPrice: mdp });
        }
      }
    }
  }

  const allResults = [];
  for (const params of paramSets) {
    const trades = [];
    for (const win of windows) {
      const s = win.sampleMap[params.entryOffset];
      if (!s || s._downAsk == null || isNaN(s._downAsk) || s._downAsk <= 0 || s._downAsk >= 1) continue;
      if (s._strike == null || s._cl == null || s._ref == null) continue;

      const deficit = s._strike - s._cl;
      const refGap = Math.abs(s._ref - s._strike);

      if (deficit <= params.deficitThreshold) continue;
      if (refGap >= params.nearStrikeThreshold) continue;
      if (s._downAsk >= params.maxDownPrice) continue;

      const fillPrice = s._downAsk + 0.005;
      if (fillPrice >= 1) continue;
      const won = win.resolved === 'DOWN';
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;
      trades.push({ fillPrice, won, pnl });
    }

    if (trades.length === 0) continue;
    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    allResults.push({ params, tradeCount: trades.length, wins, winRate: wr, avgEntry, ev, totalPnl });
  }

  allResults.sort((a, b) => b.ev - a.ev);
  const profitable = allResults.filter(r => r.ev > 0);

  console.log(`  [${label}] ${allResults.length}/${paramSets.length} configs produced trades, ${profitable.length} show +EV\n`);

  if (allResults.length > 0) {
    console.log('  Top 15:');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ Deficit │ NearStr │ MaxPx │ Trades │ WinRate │ AvgEntry │ EV/Trade │ PnL');
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────');

    const top = allResults.slice(0, 15);
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.entryOffset / 1000).padStart(4)}s │ $${String(p.deficitThreshold).padStart(5)} │ $${String(p.nearStrikeThreshold).padStart(5)} │ ${p.maxDownPrice.toFixed(2).padStart(5)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────\n');
  }
}

function runEdgeDSweep(windows, label) {
  const sweepGrid = {
    entryOffset: [10000, 30000, 60000, 120000],
    maxDownPrice: [0.40, 0.50, 0.55, 0.60, 0.65, 0.70],
  };

  const paramSets = [];
  for (const eo of sweepGrid.entryOffset) {
    for (const mdp of sweepGrid.maxDownPrice) {
      paramSets.push({ entryOffset: eo, maxDownPrice: mdp });
    }
  }

  const allResults = [];
  for (const params of paramSets) {
    const trades = [];
    for (const win of windows) {
      const s = win.sampleMap[params.entryOffset];
      if (!s || s._downAsk == null || isNaN(s._downAsk) || s._downAsk <= 0 || s._downAsk >= 1) continue;
      if (s._downAsk >= params.maxDownPrice) continue;

      const fillPrice = s._downAsk + 0.005;
      if (fillPrice >= 1) continue;
      const won = win.resolved === 'DOWN';
      const pnl = won ? (1.0 - fillPrice) : -fillPrice;
      trades.push({ fillPrice, won, pnl });
    }

    if (trades.length === 0) continue;
    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const avgEntry = trades.reduce((s, t) => s + t.fillPrice, 0) / trades.length;
    const ev = (wr * (1 - avgEntry)) - ((1 - wr) * avgEntry);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    allResults.push({ params, tradeCount: trades.length, wins, winRate: wr, avgEntry, ev, totalPnl });
  }

  allResults.sort((a, b) => b.ev - a.ev);
  const profitable = allResults.filter(r => r.ev > 0);

  console.log(`  [${label}] ${allResults.length}/${paramSets.length} configs produced trades, ${profitable.length} show +EV\n`);

  if (allResults.length > 0) {
    console.log('  All configs:');
    console.log('  ────────────────────────────────────────────────────────────────────────');
    console.log('  Rank │ Offset │ MaxPx │ Trades │ WinRate │ AvgEntry │ EV/Trade │ PnL');
    console.log('  ────────────────────────────────────────────────────────────────────────');

    for (let i = 0; i < allResults.length; i++) {
      const r = allResults[i];
      const p = r.params;
      console.log(
        `  ${String(i + 1).padStart(4)} │ ${String(p.entryOffset / 1000).padStart(4)}s │ ${p.maxDownPrice.toFixed(2).padStart(5)} │ ${String(r.tradeCount).padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(6)}% │ ${r.avgEntry.toFixed(4).padStart(8)} │ $${r.ev.toFixed(4).padStart(7)} │ $${r.totalPnl.toFixed(2).padStart(7)}`
      );
    }
    console.log('  ────────────────────────────────────────────────────────────────────────\n');
  }
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  EDGE M: CLOB-Era Only — Clean Data Split Test            ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const t0 = Date.now();
  const windows = await loadWindows();
  console.log(`  Loaded ${windows.length} windows\n`);
  runAnalysis(windows);
  console.log(`  Total runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch(err => { console.error('Edge-M failed:', err); pool.end(); process.exit(1); });
