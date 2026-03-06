#!/usr/bin/env node
/**
 * Analyze UP/DOWN matching in paired MM strategy.
 * Compare with original mm-hedge-polyref matching.
 */
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import {
  loadWindowsWithGroundTruth, getTickDateRange, close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const stratName = process.argv[2] || 'mm-paired-polyref';
const strat = await import(`../src/backtest/strategies/${stratName}.js`);

const dateRange = await getTickDateRange();
let windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
windows = windows.filter(w =>
  (w.symbol || '').toLowerCase() === 'btc' &&
  (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open))
);

console.log(`${windows.length} BTC windows\n`);

const db = new Database('data/timeline-cache.sqlite');
const stmt = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?');

// Parse config from args: --minEdge=0.01 --maxPerSide=20 etc.
const overrides = {};
for (const arg of process.argv.slice(3)) {
  const m = arg.match(/^--(\w+)=(.+)$/);
  if (m) overrides[m[1]] = parseFloat(m[2]);
}
const stratConfig = { ...strat.defaults, ...overrides };
console.log(`Config: ${JSON.stringify(overrides)}\n`);

let totalWindows = 0, tradedWindows = 0;
let totalUpBuys = 0, totalDownBuys = 0;
let totalUpCost = 0, totalDownCost = 0;
let totalUpTokens = 0, totalDownTokens = 0;
let totalPairedTokens = 0, totalUnmatchedTokens = 0;
let totalPairedProfit = 0;
let windowsWithBothSides = 0;
let windowsUpOnly = 0, windowsDownOnly = 0;
let totalPnl = 0;
let edgeBuys = 0, hedgeBuys = 0;
const matchRates = [];

for (const win of windows) {
  const ct = win.window_close_time instanceof Date ? win.window_close_time.toISOString() : win.window_close_time;
  const row = stmt.get('btc:' + ct);
  if (!row) continue;
  const timeline = JSON.parse(gunzipSync(row.timeline).toString());

  const strategy = {
    name: strat.name, evaluate: strat.evaluate,
    onWindowOpen: strat.onWindowOpen, defaults: strat.defaults,
  };

  const result = evaluateWindow({
    window: win, timeline, strategy, strategyConfig: stratConfig,
    initialCapital: 10000, spreadBuffer: 0, tradingFee: 0, windowDurationMs: 900000,
  });

  totalWindows++;
  totalPnl += result.pnl;
  if (result.trades.length === 0) continue;
  tradedWindows++;

  // Count edge vs hedge buys from trade reasons
  for (const t of result.trades) {
    if (t.reason?.startsWith('edge_buy')) edgeBuys++;
    else if (t.reason?.startsWith('hedge_buy')) hedgeBuys++;
  }

  const upTrades = result.trades.filter(t => t.token?.includes('-up') || t.token?.includes('_up'));
  const downTrades = result.trades.filter(t => t.token?.includes('-down') || t.token?.includes('_down'));

  const upTokens = upTrades.reduce((s, t) => s + t.size, 0);
  const downTokens = downTrades.reduce((s, t) => s + t.size, 0);
  const upCost = upTrades.reduce((s, t) => s + t.cost, 0);
  const downCost = downTrades.reduce((s, t) => s + t.cost, 0);

  totalUpBuys += upTrades.length;
  totalDownBuys += downTrades.length;
  totalUpTokens += upTokens;
  totalDownTokens += downTokens;
  totalUpCost += upCost;
  totalDownCost += downCost;

  const paired = Math.min(upTokens, downTokens);
  const unmatched = Math.abs(upTokens - downTokens);
  totalPairedTokens += paired;
  totalUnmatchedTokens += unmatched;

  if (paired > 0 && upTokens > 0 && downTokens > 0) {
    const avgUpPrice = upCost / upTokens;
    const avgDownPrice = downCost / downTokens;
    const pairCost = avgUpPrice + avgDownPrice;
    const pairProfit = paired * (1.00 - pairCost);
    totalPairedProfit += pairProfit;
  }

  if (upTrades.length > 0 && downTrades.length > 0) windowsWithBothSides++;
  else if (upTrades.length > 0) windowsUpOnly++;
  else if (downTrades.length > 0) windowsDownOnly++;

  const matchRate = (upTokens + downTokens) > 0 ? (paired * 2) / (upTokens + downTokens) : 0;
  matchRates.push({
    windowTime: ct,
    upBuys: upTrades.length,
    downBuys: downTrades.length,
    upTokens: upTokens.toFixed(1),
    downTokens: downTokens.toFixed(1),
    paired: paired.toFixed(1),
    unmatched: unmatched.toFixed(1),
    matchRate: (matchRate * 100).toFixed(1),
    pnl: result.pnl.toFixed(2),
  });
}

console.log('='.repeat(80));
console.log(`MATCHING ANALYSIS — ${stratName}`);
console.log('='.repeat(80));
console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
console.log(`Total windows: ${totalWindows}`);
console.log(`Traded windows: ${tradedWindows} (${(tradedWindows/totalWindows*100).toFixed(1)}%)`);
console.log(`  Both sides: ${windowsWithBothSides} (${(windowsWithBothSides/tradedWindows*100).toFixed(1)}%)`);
console.log(`  UP only: ${windowsUpOnly} (${(windowsUpOnly/tradedWindows*100).toFixed(1)}%)`);
console.log(`  DOWN only: ${windowsDownOnly} (${(windowsDownOnly/tradedWindows*100).toFixed(1)}%)`);

console.log(`\nTrade counts:`);
console.log(`  Total: ${totalUpBuys + totalDownBuys}`);
console.log(`  Edge buys: ${edgeBuys}`);
console.log(`  Hedge buys: ${hedgeBuys}`);
console.log(`  UP buys: ${totalUpBuys} (${(totalUpBuys/(totalUpBuys+totalDownBuys)*100).toFixed(1)}%)`);
console.log(`  DOWN buys: ${totalDownBuys} (${(totalDownBuys/(totalUpBuys+totalDownBuys)*100).toFixed(1)}%)`);

console.log(`\nToken volumes:`);
console.log(`  UP tokens: ${totalUpTokens.toFixed(1)} ($${totalUpCost.toFixed(2)} cost)`);
console.log(`  DOWN tokens: ${totalDownTokens.toFixed(1)} ($${totalDownCost.toFixed(2)} cost)`);
console.log(`  Avg UP price: $${(totalUpCost/totalUpTokens).toFixed(4)}`);
console.log(`  Avg DOWN price: $${(totalDownCost/totalDownTokens).toFixed(4)}`);
console.log(`  Avg combined pair cost: $${((totalUpCost/totalUpTokens)+(totalDownCost/totalDownTokens)).toFixed(4)}`);

console.log(`\nMatching:`);
console.log(`  Paired tokens: ${totalPairedTokens.toFixed(1)} (${(totalPairedTokens/(totalPairedTokens+totalUnmatchedTokens)*100).toFixed(1)}%)`);
console.log(`  Unmatched tokens: ${totalUnmatchedTokens.toFixed(1)} (${(totalUnmatchedTokens/(totalPairedTokens+totalUnmatchedTokens)*100).toFixed(1)}%)`);
console.log(`  Paired guaranteed profit: $${totalPairedProfit.toFixed(2)}`);
console.log(`  Spread capture: $${((totalUpCost/totalUpTokens)+(totalDownCost/totalDownTokens) < 1 ? (1.00 - (totalUpCost/totalUpTokens) - (totalDownCost/totalDownTokens)).toFixed(4) : 'N/A (combined > $1.00)')}/pair`);

const rates = matchRates.map(m => parseFloat(m.matchRate));
rates.sort((a, b) => a - b);
console.log(`\nMatch rate distribution (${tradedWindows} traded windows):`);
console.log(`  0% (one side only): ${rates.filter(r => r === 0).length}`);
console.log(`  1-25%: ${rates.filter(r => r > 0 && r <= 25).length}`);
console.log(`  25-50%: ${rates.filter(r => r > 25 && r <= 50).length}`);
console.log(`  50-75%: ${rates.filter(r => r > 50 && r <= 75).length}`);
console.log(`  75-99%: ${rates.filter(r => r > 75 && r < 100).length}`);
console.log(`  100%: ${rates.filter(r => r >= 100).length}`);
console.log(`  Median: ${rates[Math.floor(rates.length/2)]}%`);
console.log(`  Mean: ${(rates.reduce((s,r) => s+r, 0) / rates.length).toFixed(1)}%`);

db.close();
closeSqlite();
