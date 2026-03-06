#!/usr/bin/env node
/**
 * Analyze MM strategy leg composition:
 * - How many windows get both legs filled (spread captured)?
 * - How many get single leg (directional risk)?
 * - P&L breakdown by leg type
 */

import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import {
  loadWindowsWithGroundTruth,
  getTickDateRange,
  close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const strat = await import('../src/backtest/strategies/mm-bs-spread.js');
const strategy = {
  name: strat.name, evaluate: strat.evaluate,
  onWindowOpen: strat.onWindowOpen, defaults: strat.defaults,
};

const dateRange = await getTickDateRange();
let windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
windows = windows.filter(w =>
  (w.symbol || '').toLowerCase() === 'btc' &&
  (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open))
);

console.log(`Analyzing ${windows.length} BTC windows...\n`);

const db = new Database('data/timeline-cache.sqlite');
let bothLegs = 0, upOnly = 0, downOnly = 0, noTrades = 0;
let bothPnl = 0, upOnlyPnl = 0, downOnlyPnl = 0;
let bothCostSum = 0;
let bothWins = 0, singleWins = 0, singleTotal = 0;
const bothCosts = [];
const singlePnls = [];

for (let wi = 0; wi < windows.length; wi++) {
  const win = windows[wi];
  const ct = win.window_close_time instanceof Date ? win.window_close_time.toISOString() : win.window_close_time;
  const key = `btc:${ct}`;
  const row = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?').get(key);
  if (!row) continue;
  const timeline = JSON.parse(gunzipSync(row.timeline).toString());

  const result = evaluateWindow({
    window: win, timeline, strategy,
    strategyConfig: strategy.defaults,
    initialCapital: 10000, spreadBuffer: 0.005, tradingFee: 0,
    windowDurationMs: 900000,
  });

  const upTrades = result.trades.filter(t => t.token && t.token.includes('-up'));
  const downTrades = result.trades.filter(t => t.token && t.token.includes('-down'));
  const hasUp = upTrades.length > 0;
  const hasDown = downTrades.length > 0;

  if (hasUp && hasDown) {
    bothLegs++;
    const totalCost = upTrades[0].cost + downTrades[0].cost;
    bothCostSum += totalCost;
    bothCosts.push(totalCost);
    bothPnl += result.pnl;
    if (result.pnl > 0) bothWins++;
  } else if (hasUp || hasDown) {
    const single = hasUp ? 'UP' : 'DOWN';
    if (hasUp) upOnly++;
    else downOnly++;
    const pnl = result.pnl;
    if (hasUp) upOnlyPnl += pnl;
    else downOnlyPnl += pnl;
    singleTotal++;
    singlePnls.push(pnl);
    if (pnl > 0) singleWins++;
  } else {
    noTrades++;
  }

  if ((wi + 1) % 200 === 0) process.stdout.write(`\r  ${wi + 1}/${windows.length}`);
}
db.close();
closeSqlite();

console.log(`\r  ${windows.length}/${windows.length} done\n`);

console.log('=== MM LEG ANALYSIS ===\n');
console.log(`Windows:        ${windows.length}`);
console.log(`No trades:      ${noTrades} (${(noTrades/windows.length*100).toFixed(1)}%)\n`);

console.log(`BOTH LEGS:      ${bothLegs} windows (${(bothLegs/windows.length*100).toFixed(1)}%)`);
console.log(`  Avg cost:     $${bothLegs > 0 ? (bothCostSum/bothLegs).toFixed(4) : 'n/a'} (spread = $${bothLegs > 0 ? (1 - bothCostSum/bothLegs).toFixed(4) : 'n/a'})`);
console.log(`  Total PnL:    $${bothPnl.toFixed(2)}`);
console.log(`  Avg PnL:      $${bothLegs > 0 ? (bothPnl/bothLegs).toFixed(4) : 'n/a'}/window`);
console.log(`  Win rate:     ${bothLegs > 0 ? (bothWins/bothLegs*100).toFixed(1) : 0}% (${bothWins}/${bothLegs})`);

// Cost distribution for both-legs
if (bothCosts.length > 0) {
  bothCosts.sort((a, b) => a - b);
  const below1 = bothCosts.filter(c => c < 1.0).length;
  const above1 = bothCosts.filter(c => c >= 1.0).length;
  console.log(`  Cost < $1.00: ${below1} (riskless profit)`);
  console.log(`  Cost >= $1.00: ${above1} (spread buffer ate the edge)`);
  console.log(`  Min cost:     $${bothCosts[0].toFixed(4)}`);
  console.log(`  Median cost:  $${bothCosts[Math.floor(bothCosts.length/2)].toFixed(4)}`);
  console.log(`  Max cost:     $${bothCosts[bothCosts.length-1].toFixed(4)}`);
}

console.log(`\nSINGLE LEG:     ${singleTotal} windows (${(singleTotal/windows.length*100).toFixed(1)}%)`);
console.log(`  UP only:      ${upOnly}, PnL: $${upOnlyPnl.toFixed(2)}`);
console.log(`  DOWN only:    ${downOnly}, PnL: $${downOnlyPnl.toFixed(2)}`);
console.log(`  Win rate:     ${singleTotal > 0 ? (singleWins/singleTotal*100).toFixed(1) : 0}% (${singleWins}/${singleTotal})`);
console.log(`  Total PnL:    $${(upOnlyPnl + downOnlyPnl).toFixed(2)}`);

console.log(`\nOVERALL PnL:    $${(bothPnl + upOnlyPnl + downOnlyPnl).toFixed(2)}`);
console.log(`  From spreads: $${bothPnl.toFixed(2)}`);
console.log(`  From singles: $${(upOnlyPnl + downOnlyPnl).toFixed(2)}`);
