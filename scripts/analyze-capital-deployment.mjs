#!/usr/bin/env node
/**
 * Analyze per-window capital deployment for a strategy.
 */
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import { loadWindowsWithGroundTruth, getTickDateRange, close as closeSqlite } from '../src/backtest/data-loader-sqlite.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const stratName = process.argv[2] || 'mm-balanced-polyref';
const strat = await import(`../src/backtest/strategies/${stratName}.js`);

const dateRange = await getTickDateRange();
let windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
windows = windows.filter(w =>
  (w.symbol || '').toLowerCase() === 'btc' &&
  (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open))
);

const db = new Database('data/timeline-cache.sqlite');
const stmt = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?');

let maxCap = 0, maxCapWindow = null;
let totalWindows = 0, tradedWindows = 0;
const capPerWindow = [];

for (const win of windows) {
  const ct = win.window_close_time instanceof Date ? win.window_close_time.toISOString() : win.window_close_time;
  const row = stmt.get('btc:' + ct);
  if (!row) continue;
  const timeline = JSON.parse(gunzipSync(row.timeline).toString());

  const strategy = { name: strat.name, evaluate: strat.evaluate, onWindowOpen: strat.onWindowOpen, defaults: strat.defaults };
  const result = evaluateWindow({
    window: win, timeline, strategy, strategyConfig: strat.defaults,
    initialCapital: 10000, spreadBuffer: 0, tradingFee: 0, windowDurationMs: 900000,
  });

  totalWindows++;
  if (result.trades.length === 0) continue;
  tradedWindows++;

  const totalCost = result.trades.reduce((s, t) => s + t.cost, 0);
  const upTrades = result.trades.filter(t => t.token && t.token.includes('-up'));
  const downTrades = result.trades.filter(t => t.token && t.token.includes('-down'));
  const upCost = upTrades.reduce((s, t) => s + t.cost, 0);
  const downCost = downTrades.reduce((s, t) => s + t.cost, 0);

  capPerWindow.push(totalCost);

  if (totalCost > maxCap) {
    maxCap = totalCost;
    maxCapWindow = {
      time: ct,
      totalCost: totalCost.toFixed(2),
      upCost: upCost.toFixed(2),
      downCost: downCost.toFixed(2),
      trades: result.trades.length,
      pnl: result.pnl.toFixed(2),
      tradeDetails: result.trades.map(t => ({
        token: (t.token && t.token.includes('-up')) ? 'UP' : 'DOWN',
        price: t.entryPrice ? t.entryPrice.toFixed(4) : '?',
        size: t.size ? t.size.toFixed(2) : '?',
        cost: t.cost ? t.cost.toFixed(2) : '?',
        reason: t.reason ? t.reason.slice(0, 80) : '',
      })),
    };
  }
}

capPerWindow.sort((a, b) => a - b);
const p50 = capPerWindow[Math.floor(capPerWindow.length * 0.5)];
const p90 = capPerWindow[Math.floor(capPerWindow.length * 0.9)];
const p99 = capPerWindow[Math.floor(capPerWindow.length * 0.99)];
const mean = capPerWindow.reduce((s, c) => s + c, 0) / capPerWindow.length;

console.log(`=== ${stratName} Capital Deployment ===`);
console.log(`Total windows: ${totalWindows}`);
console.log(`Traded windows: ${tradedWindows} (${(tradedWindows/totalWindows*100).toFixed(1)}%)`);
console.log(`Avg PnL per window: $${(453.73 / tradedWindows).toFixed(4)}`);
console.log('');
console.log('Capital per window (traded only):');
console.log(`  Mean:   $${mean.toFixed(2)}`);
console.log(`  Median: $${p50 ? p50.toFixed(2) : 'N/A'}`);
console.log(`  P90:    $${p90 ? p90.toFixed(2) : 'N/A'}`);
console.log(`  P99:    $${p99 ? p99.toFixed(2) : 'N/A'}`);
console.log(`  Max:    $${maxCap.toFixed(2)}`);
console.log('');
console.log('Max capital window:');
console.log(JSON.stringify(maxCapWindow, null, 2));

// Show distribution
const buckets = [0, 2, 4, 6, 8, 10, 15, 20, 30, 50];
console.log('\nCapital distribution:');
for (let i = 0; i < buckets.length; i++) {
  const lo = buckets[i];
  const hi = i + 1 < buckets.length ? buckets[i + 1] : Infinity;
  const count = capPerWindow.filter(c => c >= lo && c < hi).length;
  if (count > 0) {
    const label = hi === Infinity ? `$${lo}+` : `$${lo}-$${hi}`;
    console.log(`  ${label.padEnd(10)}: ${count} windows (${(count/capPerWindow.length*100).toFixed(1)}%)`);
  }
}

db.close();
closeSqlite();
