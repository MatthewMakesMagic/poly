import { loadWindowTickData, loadWindowsWithGroundTruth, getTickDateRange, close } from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';
import { createMarketState } from '../src/backtest/market-state.js';

const dateRange = await getTickDateRange();
const windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
const win = windows.find(w => new Date(w.window_close_time).toISOString() === '2026-02-22T06:00:00.000Z' && w.symbol?.toLowerCase() === 'btc');

const data = await loadWindowTickData({ window: win, windowDurationMs: 15 * 60 * 1000 });
for (const t of data.rtdsTicks) {
  if (t.topic === 'crypto_prices_chainlink') t.source = 'chainlink';
  else if (t.topic === 'crypto_prices') t.source = 'polyRef';
  else t.source = 'rtds_' + t.topic;
}
for (const s of data.clobSnapshots) s.source = s.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
for (const t of data.exchangeTicks) t.source = 'exchange_' + t.exchange;
for (const t of (data.l2BookTicks || [])) t.source = t.direction === 'down' ? 'l2Down' : 'l2Up';
precomputeTimestamps(data);

function merge2(a, b) {
  const t = a.length + b.length;
  const r = new Array(t);
  let i = 0, j = 0, o = 0;
  while (i < a.length && j < b.length) {
    if (a[i]._ms <= b[j]._ms) r[o++] = a[i++];
    else r[o++] = b[j++];
  }
  while (i < a.length) r[o++] = a[i++];
  while (j < b.length) r[o++] = b[j++];
  return r;
}

let tl = merge2(data.rtdsTicks, data.clobSnapshots);
tl = merge2(tl, data.exchangeTicks);
if (data.l2BookTicks.length > 0) tl = merge2(tl, data.l2BookTicks);

const state = createMarketState();
const closeMs = new Date(win.window_close_time).getTime();
const openMs = closeMs - 15 * 60 * 1000;
state.setWindow(win, new Date(openMs).toISOString());

// Process events and look for the first few moments where we have both clobUp and clobDown with levels
let printed = 0;
for (const event of tl) {
  const eventMs = new Date(event.timestamp).getTime();
  if (eventMs < openMs) continue;
  if (eventMs >= closeMs) break;

  state.processEvent(event);
  state.updateTimeToClose(event.timestamp);

  // After processing, check if we have L2 levels
  if (state.clobDown?.levels && state.clobUp?.levels && printed < 5) {
    const l2BidsUp = state.clobUp.levels?.bids;
    const l2BidsDown = state.clobDown.levels?.bids;
    const l2AsksUp = state.clobUp.levels?.asks;
    const l2AsksDown = state.clobDown.levels?.asks;

    console.log(`\n--- Event: ${event.source} at ${String(event.timestamp).slice(11,23)} ---`);
    console.log(`  clobUp.bestBid=${state.clobUp.bestBid} clobUp.bestAsk=${state.clobUp.bestAsk}`);
    console.log(`  clobDown.bestBid=${state.clobDown.bestBid} clobDown.bestAsk=${state.clobDown.bestAsk}`);
    console.log(`  L2 UP bids: ${JSON.stringify(l2BidsUp?.slice(0,3))}`);
    console.log(`  L2 UP asks: ${JSON.stringify(l2AsksUp?.slice(0,3))}`);
    console.log(`  L2 DN bids: ${JSON.stringify(l2BidsDown?.slice(0,3))}`);
    console.log(`  L2 DN asks: ${JSON.stringify(l2AsksDown?.slice(0,3))}`);

    const upBid = l2BidsUp?.[0]?.[0] || state.clobUp.bestBid;
    const dnBid = l2BidsDown?.[0]?.[0] || state.clobDown.bestBid;
    console.log(`  Strategy would use: upBid=${upBid} dnBid=${dnBid} pairCost=${(upBid + dnBid).toFixed(3)}`);
    printed++;
  }
}

// Also check first L2 tick data
const firstL2Down = data.l2BookTicks.find(t => t.source === 'l2Down');
if (firstL2Down) {
  console.log('\n--- First L2 DOWN tick raw data ---');
  console.log('  typeof top_levels:', typeof firstL2Down.top_levels);
  console.log('  top_levels keys:', firstL2Down.top_levels ? Object.keys(firstL2Down.top_levels) : 'null');
  const levels = firstL2Down.top_levels;
  if (levels?.bids) {
    console.log('  bids[0]:', levels.bids[0], 'type:', typeof levels.bids[0]?.[0]);
  }
  if (levels?.asks) {
    console.log('  asks[0]:', levels.asks[0], 'type:', typeof levels.asks[0]?.[0]);
  }
}

close();
