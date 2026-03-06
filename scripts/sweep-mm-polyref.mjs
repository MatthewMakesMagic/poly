#!/usr/bin/env node
/**
 * Sweep mm-hedge-polyref parameters across the grid:
 *   minEdge: [0.01, 0.02, 0.03, 0.05]
 *   maxPerSide: [6, 10, 20]
 *   cooldownMs: [5000, 10000, 15000]
 *
 * 4 × 3 × 3 = 36 configs × 1212 windows, single-threaded from cache.
 */
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import {
  loadWindowsWithGroundTruth, getTickDateRange, close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const strat = await import('../src/backtest/strategies/mm-hedge-polyref.js');

const dateRange = await getTickDateRange();
let windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
windows = windows.filter(w =>
  (w.symbol || '').toLowerCase() === 'btc' &&
  (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open))
);

console.log(`${windows.length} BTC windows\n`);

// Build sweep grid
const minEdges = [0.01, 0.02, 0.03, 0.05];
const maxPerSides = [6, 10, 20];
const cooldowns = [5000, 10000, 15000];

const configs = [];
for (const minEdge of minEdges) {
  for (const maxPerSide of maxPerSides) {
    for (const cooldownMs of cooldowns) {
      configs.push({
        label: `edge=${minEdge},max=$${maxPerSide},cd=${cooldownMs/1000}s`,
        minEdge,
        maxPerSide,
        cooldownMs,
      });
    }
  }
}

console.log(`${configs.length} configs to sweep\n`);

const db = new Database('data/timeline-cache.sqlite');
const stmt = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?');

console.log(
  'Config'.padEnd(30) + ' | ' +
  'Trades'.padStart(6) + ' | ' +
  'WR%'.padStart(6) + ' | ' +
  'PnL'.padStart(10) + ' | ' +
  '$/Trade'.padStart(9) + ' | ' +
  'PF'.padStart(6) + ' | ' +
  'AvgWin'.padStart(8) + ' | ' +
  'AvgLoss'.padStart(8) + ' | ' +
  'Windows'.padStart(7)
);
console.log('-'.repeat(110));

const results = [];

for (let ci = 0; ci < configs.length; ci++) {
  const cfg = configs[ci];
  const strategy = {
    name: strat.name, evaluate: strat.evaluate,
    onWindowOpen: strat.onWindowOpen, defaults: strat.defaults,
  };
  const stratConfig = { ...strat.defaults, ...cfg };

  let totalPnl = 0, totalTrades = 0, totalWins = 0;
  let grossWins = 0, grossLosses = 0;
  let winCount = 0, lossCount = 0;
  let windowsTraded = 0;

  for (const win of windows) {
    const ct = win.window_close_time instanceof Date ? win.window_close_time.toISOString() : win.window_close_time;
    const row = stmt.get('btc:' + ct);
    if (!row) continue;
    const timeline = JSON.parse(gunzipSync(row.timeline).toString());

    const result = evaluateWindow({
      window: win, timeline, strategy, strategyConfig: stratConfig,
      initialCapital: 10000, spreadBuffer: 0, tradingFee: 0, windowDurationMs: 900000,
    });
    totalPnl += result.pnl;
    totalTrades += result.trades.length;
    if (result.trades.length > 0) windowsTraded++;
    for (const t of result.trades) {
      if (t.pnl > 0) { totalWins++; grossWins += t.pnl; winCount++; }
      else { grossLosses += Math.abs(t.pnl); lossCount++; }
    }
  }

  const wr = totalTrades > 0 ? (totalWins/totalTrades*100).toFixed(1) : '0';
  const pf = grossLosses > 0 ? (grossWins/grossLosses).toFixed(2) : 'inf';
  const perTrade = totalTrades > 0 ? (totalPnl/totalTrades).toFixed(4) : '0';
  const avgWin = winCount > 0 ? (grossWins/winCount).toFixed(3) : '0';
  const avgLoss = lossCount > 0 ? (-grossLosses/lossCount).toFixed(3) : '0';

  results.push({ ...cfg, totalPnl, totalTrades, wr: parseFloat(wr), pf: parseFloat(pf), perTrade: parseFloat(perTrade), windowsTraded });

  console.log(
    cfg.label.padEnd(30) + ' | ' +
    String(totalTrades).padStart(6) + ' | ' +
    (wr + '%').padStart(6) + ' | ' +
    ('$' + totalPnl.toFixed(2)).padStart(10) + ' | ' +
    ('$' + perTrade).padStart(9) + ' | ' +
    pf.padStart(6) + ' | ' +
    ('$' + avgWin).padStart(8) + ' | ' +
    ('$' + avgLoss).padStart(8) + ' | ' +
    String(windowsTraded).padStart(7)
  );
}

// Sort by PnL and show top 10
console.log('\n' + '='.repeat(80));
console.log('TOP 10 BY PNL');
console.log('='.repeat(80));
results.sort((a, b) => b.totalPnl - a.totalPnl);
for (let i = 0; i < Math.min(10, results.length); i++) {
  const r = results[i];
  console.log(
    `${i+1}. ${r.label.padEnd(30)} $${r.totalPnl.toFixed(2).padStart(9)} | ${r.totalTrades} trades | ${r.wr}% WR | PF ${r.pf} | ${r.windowsTraded} windows`
  );
}

// Sort by PF and show top 10
console.log('\n' + '='.repeat(80));
console.log('TOP 10 BY PROFIT FACTOR');
console.log('='.repeat(80));
results.sort((a, b) => b.pf - a.pf);
for (let i = 0; i < Math.min(10, results.length); i++) {
  const r = results[i];
  console.log(
    `${i+1}. ${r.label.padEnd(30)} PF ${String(r.pf).padStart(5)} | $${r.totalPnl.toFixed(2).padStart(9)} | ${r.totalTrades} trades | ${r.wr}% WR | ${r.windowsTraded} windows`
  );
}

db.close();
closeSqlite();
