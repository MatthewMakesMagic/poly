#!/usr/bin/env node
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import {
  loadWindowsWithGroundTruth, getTickDateRange, close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const strat = await import('../src/backtest/strategies/mm-informed.js');

const dateRange = await getTickDateRange();
let windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
windows = windows.filter(w =>
  (w.symbol || '').toLowerCase() === 'btc' &&
  (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open))
);

console.log(`${windows.length} BTC windows\n`);

const configs = [
  { label: 'edge=0.03,exit=0.05', fairEdge: 0.03, exitEdge: 0.05 },
  { label: 'edge=0.03,exit=0.08', fairEdge: 0.03, exitEdge: 0.08 },
  { label: 'edge=0.05,exit=0.03', fairEdge: 0.05, exitEdge: 0.03 },
  { label: 'edge=0.05,exit=0.05', fairEdge: 0.05, exitEdge: 0.05 },
  { label: 'edge=0.05,exit=0.08', fairEdge: 0.05, exitEdge: 0.08 },
  { label: 'edge=0.08,exit=0.03', fairEdge: 0.08, exitEdge: 0.03 },
  { label: 'edge=0.08,exit=0.08', fairEdge: 0.08, exitEdge: 0.08 },
  { label: 'edge=0.10,exit=0.05', fairEdge: 0.10, exitEdge: 0.05 },
  { label: 'edge=0.10,exit=0.10', fairEdge: 0.10, exitEdge: 0.10 },
  { label: 'edge=0.15,exit=0.08', fairEdge: 0.15, exitEdge: 0.08 },
  { label: 'no-exit(baseline)', fairEdge: 0.05, exitEdge: 999 },
];

const db = new Database('data/timeline-cache.sqlite');

console.log('Config'.padEnd(25) + ' | Trades | WR%    | PnL       | $/Trade   | PF    | AvgWin  | AvgLoss');
console.log('-'.repeat(105));

for (const cfg of configs) {
  const strategy = {
    name: strat.name, evaluate: strat.evaluate,
    onWindowOpen: strat.onWindowOpen, defaults: strat.defaults,
  };
  const stratConfig = { ...strat.defaults, ...cfg };
  let totalPnl = 0, totalTrades = 0, totalWins = 0;
  let grossWins = 0, grossLosses = 0;
  let winCount = 0, lossCount = 0;

  for (const win of windows) {
    const ct = win.window_close_time instanceof Date ? win.window_close_time.toISOString() : win.window_close_time;
    const row = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?').get('btc:' + ct);
    if (row == null) continue;
    const timeline = JSON.parse(gunzipSync(row.timeline).toString());

    const result = evaluateWindow({
      window: win, timeline, strategy, strategyConfig: stratConfig,
      initialCapital: 10000, spreadBuffer: 0, tradingFee: 0, windowDurationMs: 900000,
    });
    totalPnl += result.pnl;
    totalTrades += result.trades.length;
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
  console.log(
    cfg.label.padEnd(25) + ' | ' +
    String(totalTrades).padStart(6) + ' | ' +
    (wr + '%').padStart(6) + ' | ' +
    ('$' + totalPnl.toFixed(2)).padStart(9) + ' | ' +
    ('$' + perTrade).padStart(9) + ' | ' +
    pf.padStart(5) + ' | ' +
    ('$' + avgWin).padStart(7) + ' | ' +
    ('$' + avgLoss).padStart(7)
  );
}

db.close();
closeSqlite();
