#!/usr/bin/env node
/**
 * Quick diagnostic: what does askUp + askDown look like across windows?
 * Are there opportunities to buy both sides at combined < $1.00?
 */
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import {
  loadWindowsWithGroundTruth, getTickDateRange, close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const dateRange = await getTickDateRange();
let windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
windows = windows.filter(w =>
  (w.symbol || '').toLowerCase() === 'btc' &&
  (w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open))
);

const db = new Database('data/timeline-cache.sqlite');
const stmt = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?');

let totalSnapshots = 0;
let combinedBelow100 = 0;
let combinedBelow098 = 0;
let combinedBelow095 = 0;
let combinedBelow090 = 0;
const combinedValues = [];
const perWindowStats = [];

for (const win of windows) {
  const ct = win.window_close_time instanceof Date ? win.window_close_time.toISOString() : win.window_close_time;
  const row = stmt.get('btc:' + ct);
  if (!row) continue;
  const timeline = JSON.parse(gunzipSync(row.timeline).toString());

  const closeMs = new Date(ct).getTime();

  // Build time-synced snapshots: track latest ask for each side
  let lastAskUp = null, lastAskDown = null;
  let windowCombined = [];

  for (const tick of timeline) {
    const tickMs = tick._ms || new Date(tick.timestamp).getTime();
    const timeToClose = closeMs - tickMs;

    // Update latest asks
    if (tick.source === 'clobUp' && tick.best_ask > 0.01) {
      lastAskUp = tick.best_ask;
    } else if (tick.source === 'clobDown' && tick.best_ask > 0.01) {
      lastAskDown = tick.best_ask;
    }

    // Only analyze entry window (last 5 min, skip final 5s)
    if (timeToClose > 300000 || timeToClose < 5000) continue;
    if (!lastAskUp || !lastAskDown) continue;

    // Only count when we get a new CLOB tick (avoid double-counting)
    if (tick.source !== 'clobUp' && tick.source !== 'clobDown') continue;

    totalSnapshots++;
    const combined = lastAskUp + lastAskDown;
    combinedValues.push(combined);
    windowCombined.push(combined);

    if (combined < 1.00) combinedBelow100++;
    if (combined < 0.98) combinedBelow098++;
    if (combined < 0.95) combinedBelow095++;
    if (combined < 0.90) combinedBelow090++;
  }

  if (windowCombined.length > 0) {
    const avg = windowCombined.reduce((s, v) => s + v, 0) / windowCombined.length;
    let minVal = Infinity;
    for (const v of windowCombined) if (v < minVal) minVal = v;
    perWindowStats.push({ window: ct, avg, min: minVal, ticks: windowCombined.length });
  }
}

console.log('='.repeat(80));
console.log('COMBINED ASK (askUp + askDown) ANALYSIS — BTC entry window');
console.log('='.repeat(80));
console.log(`Total CLOB snapshots in entry window: ${totalSnapshots}`);
console.log();
console.log(`Combined < $1.00: ${combinedBelow100} (${(combinedBelow100/totalSnapshots*100).toFixed(1)}%)`);
console.log(`Combined < $0.98: ${combinedBelow098} (${(combinedBelow098/totalSnapshots*100).toFixed(1)}%)`);
console.log(`Combined < $0.95: ${combinedBelow095} (${(combinedBelow095/totalSnapshots*100).toFixed(1)}%)`);
console.log(`Combined < $0.90: ${combinedBelow090} (${(combinedBelow090/totalSnapshots*100).toFixed(1)}%)`);

// Distribution
combinedValues.sort((a, b) => a - b);
const p = (pct) => combinedValues[Math.floor(combinedValues.length * pct / 100)];
console.log(`\nDistribution:`);
console.log(`  Min:  $${combinedValues[0]?.toFixed(4)}`);
console.log(`  P5:   $${p(5)?.toFixed(4)}`);
console.log(`  P10:  $${p(10)?.toFixed(4)}`);
console.log(`  P25:  $${p(25)?.toFixed(4)}`);
console.log(`  P50:  $${p(50)?.toFixed(4)}`);
console.log(`  P75:  $${p(75)?.toFixed(4)}`);
console.log(`  P90:  $${p(90)?.toFixed(4)}`);
console.log(`  P95:  $${p(95)?.toFixed(4)}`);
console.log(`  Max:  $${combinedValues[combinedValues.length - 1]?.toFixed(4)}`);
console.log(`  Mean: $${(combinedValues.reduce((s, v) => s + v, 0) / combinedValues.length).toFixed(4)}`);

// Per-window stats
const windowsBelow100 = perWindowStats.filter(w => w.min < 1.00).length;
const windowsBelow098 = perWindowStats.filter(w => w.min < 0.98).length;
const windowsBelow095 = perWindowStats.filter(w => w.min < 0.95).length;
console.log(`\nPer-window (${perWindowStats.length} windows with data):`);
console.log(`  Windows where min(combined) < $1.00: ${windowsBelow100} (${(windowsBelow100/perWindowStats.length*100).toFixed(1)}%)`);
console.log(`  Windows where min(combined) < $0.98: ${windowsBelow098} (${(windowsBelow098/perWindowStats.length*100).toFixed(1)}%)`);
console.log(`  Windows where min(combined) < $0.95: ${windowsBelow095} (${(windowsBelow095/perWindowStats.length*100).toFixed(1)}%)`);
console.log(`  Windows where avg(combined) < $1.00: ${perWindowStats.filter(w => w.avg < 1.00).length}`);
console.log(`  Windows where avg(combined) < $1.02: ${perWindowStats.filter(w => w.avg < 1.02).length}`);

// Show 10 windows with lowest combined ask
perWindowStats.sort((a, b) => a.min - b.min);
console.log(`\n--- 10 WINDOWS WITH LOWEST COMBINED ASK ---`);
for (let i = 0; i < Math.min(10, perWindowStats.length); i++) {
  const w = perWindowStats[i];
  console.log(`  ${w.window} — min=$${w.min.toFixed(4)}, avg=$${w.avg.toFixed(4)}, ${w.ticks} ticks`);
}

db.close();
closeSqlite();
