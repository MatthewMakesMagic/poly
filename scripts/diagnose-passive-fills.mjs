import { loadWindowTickData, loadWindowsWithGroundTruth, getTickDateRange, close } from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';

const dateRange = await getTickDateRange();
const windows = await loadWindowsWithGroundTruth({ startDate: dateRange.earliest, endDate: dateRange.latest });
const win = windows.find(w => new Date(w.window_close_time).toISOString() === '2026-02-22T06:00:00.000Z' && w.symbol?.toLowerCase() === 'btc');

if (!win) { console.log('Window not found'); process.exit(1); }

const data = await loadWindowTickData({ window: win, windowDurationMs: 15 * 60 * 1000 });

// Tag sources
for (const t of data.rtdsTicks) {
  if (t.topic === 'crypto_prices_chainlink') t.source = 'chainlink';
  else if (t.topic === 'crypto_prices') t.source = 'polyRef';
  else t.source = 'rtds_' + t.topic;
}
for (const s of data.clobSnapshots) s.source = s.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
for (const t of data.exchangeTicks) t.source = 'exchange_' + t.exchange;
for (const t of (data.l2BookTicks || [])) t.source = t.direction === 'down' ? 'l2Down' : 'l2Up';
precomputeTimestamps(data);

const l2Down = data.l2BookTicks.filter(t => t.source === 'l2Down');
const l2Up = data.l2BookTicks.filter(t => t.source === 'l2Up');

console.log(`L2 ticks: ${data.l2BookTicks.length} total, ${l2Up.length} UP, ${l2Down.length} DOWN`);

// Show DOWN L2 best asks over time
console.log('\n--- DOWN L2 best asks (first 20 ticks) ---');
let downAsks = [];
for (const t of l2Down.slice(0, 40)) {
  let levels;
  try { levels = typeof t.top_levels === 'string' ? JSON.parse(t.top_levels) : t.top_levels; } catch { continue; }
  const asks = levels?.asks || [];
  const bids = levels?.bids || [];
  const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => a[0])) : null;
  const bestBid = bids.length > 0 ? Math.max(...bids.map(b => b[0])) : null;
  const ts = t.timestamp instanceof Date ? t.timestamp.toISOString().slice(11,19) : String(t.timestamp).slice(11,19);
  console.log(`  ${ts} | bestBid=${bestBid?.toFixed(3) || 'null'} bestAsk=${bestAsk?.toFixed(3) || 'null'} | bids=${bids.length} asks=${asks.length}`);
  if (bestAsk) downAsks.push(bestAsk);
}

if (downAsks.length > 0) {
  console.log(`\nDOWN best ask range: ${Math.min(...downAsks).toFixed(3)} - ${Math.max(...downAsks).toFixed(3)}`);
  console.log(`Our DOWN bid would be at ~0.43-0.45 (fairDown - 0.01)`);
  console.log(`Would any fill? ${downAsks.some(a => a <= 0.45) ? 'YES' : 'NO'}`);
} else {
  console.log('\nNo DOWN asks found in L2 data!');
}

// Show UP L2 for comparison
console.log('\n--- UP L2 best asks (first 10 ticks) ---');
for (const t of l2Up.slice(0, 10)) {
  let levels;
  try { levels = typeof t.top_levels === 'string' ? JSON.parse(t.top_levels) : t.top_levels; } catch { continue; }
  const asks = levels?.asks || [];
  const bids = levels?.bids || [];
  const bestAsk = asks.length > 0 ? Math.min(...asks.map(a => a[0])) : null;
  const bestBid = bids.length > 0 ? Math.max(...bids.map(b => b[0])) : null;
  const ts = t.timestamp instanceof Date ? t.timestamp.toISOString().slice(11,19) : String(t.timestamp).slice(11,19);
  console.log(`  ${ts} | bestBid=${bestBid?.toFixed(3) || 'null'} bestAsk=${bestAsk?.toFixed(3) || 'null'}`);
}

// Check the raw L2 data — are there ANY ticks with direction=down?
console.log('\n--- L2 direction distribution ---');
const dirCounts = {};
for (const t of data.l2BookTicks) {
  const dir = t.direction || 'null';
  dirCounts[dir] = (dirCounts[dir] || 0) + 1;
}
console.log(dirCounts);

// Check token_ids
const tokenIds = new Set(data.l2BookTicks.map(t => t.token_id));
console.log(`\nUnique token_ids in L2: ${[...tokenIds].join(', ')}`);

// Check window_id
const windowIds = new Set(data.l2BookTicks.map(t => t.window_id));
console.log(`Window IDs in L2: ${[...windowIds].join(', ')}`);

close();
