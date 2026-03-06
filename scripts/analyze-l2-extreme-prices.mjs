/**
 * Analyze L2 orderbook liquidity at extreme price levels (bid < 0.10)
 * for BTC-UP tokens. Goal: understand if passive fills are realistic
 * at sub-$0.10 prices.
 */

import Database from 'better-sqlite3';

const db = new Database('data/backtest.sqlite', { readonly: true });

// Query for rows where best_bid < 0.10 but > 0.01, spread across different timestamps
const rows = db.prepare(`
  SELECT *
  FROM l2_orderbook_snapshots
  WHERE symbol = 'btc-up'
    AND best_bid < 0.10
    AND best_bid > 0.01
  ORDER BY timestamp ASC
  LIMIT 500
`).all();

console.log(`Found ${rows.length} rows with btc-up best_bid in (0.01, 0.10)\n`);

if (rows.length === 0) {
  console.log('No data found. Exiting.');
  db.close();
  process.exit(0);
}

// Sample ~50 evenly spaced rows from the result set
const step = Math.max(1, Math.floor(rows.length / 50));
const sampled = [];
for (let i = 0; i < rows.length; i += step) {
  sampled.push(rows[i]);
  if (sampled.length >= 50) break;
}

console.log(`Sampled ${sampled.length} rows for detailed analysis\n`);
console.log('='.repeat(120));
console.log(
  'Timestamp'.padEnd(28),
  'Bid'.padStart(8),
  'Ask'.padStart(8),
  'Spread'.padStart(8),
  'BidLvls'.padStart(8),
  'AskLvls'.padStart(8),
  'BestBidSz'.padStart(10),
  'TotBidDep'.padStart(12),
  'TotAskDep'.padStart(12),
  'BidDep$'.padStart(10),
  'AskDep$'.padStart(10),
);
console.log('='.repeat(120));

const stats = {
  totalBidDepths: [],
  totalAskDepths: [],
  bidLevelCounts: [],
  askLevelCounts: [],
  bestBidSizes: [],
  spreads: [],
  bidDepthDollars: [],
  askDepthDollars: [],
  bestBids: [],
  bestAsks: [],
};

for (const row of sampled) {
  let topLevels;
  try {
    topLevels = JSON.parse(row.top_levels);
  } catch (e) {
    console.log(`  [parse error for row at ${row.timestamp}]`);
    continue;
  }

  const bids = topLevels.bids || [];
  const asks = topLevels.asks || [];

  const totalBidDepth = bids.reduce((sum, [, size]) => sum + size, 0);
  const totalAskDepth = asks.reduce((sum, [, size]) => sum + size, 0);
  const bestBidSize = bids.length > 0 ? bids[0][1] : 0;
  const spread = row.best_ask - row.best_bid;

  // Dollar-weighted depth (price * size)
  const bidDepthDollars = bids.reduce((sum, [price, size]) => sum + price * size, 0);
  const askDepthDollars = asks.reduce((sum, [price, size]) => sum + price * size, 0);

  const ts = new Date(row.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 23);

  console.log(
    ts.padEnd(28),
    row.best_bid.toFixed(4).padStart(8),
    row.best_ask.toFixed(4).padStart(8),
    spread.toFixed(4).padStart(8),
    String(bids.length).padStart(8),
    String(asks.length).padStart(8),
    bestBidSize.toFixed(0).padStart(10),
    totalBidDepth.toFixed(0).padStart(12),
    totalAskDepth.toFixed(0).padStart(12),
    ('$' + bidDepthDollars.toFixed(0)).padStart(10),
    ('$' + askDepthDollars.toFixed(0)).padStart(10),
  );

  stats.totalBidDepths.push(totalBidDepth);
  stats.totalAskDepths.push(totalAskDepth);
  stats.bidLevelCounts.push(bids.length);
  stats.askLevelCounts.push(asks.length);
  stats.bestBidSizes.push(bestBidSize);
  stats.spreads.push(spread);
  stats.bidDepthDollars.push(bidDepthDollars);
  stats.askDepthDollars.push(askDepthDollars);
  stats.bestBids.push(row.best_bid);
  stats.bestAsks.push(row.best_ask);
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

console.log('\n' + '='.repeat(80));
console.log('SUMMARY STATISTICS (sub-$0.10 bid levels for BTC-UP)');
console.log('='.repeat(80));

console.log(`\nSample size: ${sampled.length} snapshots`);
console.log(`Price range: best_bid ${pct(stats.bestBids, 0).toFixed(4)} - ${pct(stats.bestBids, 1).toFixed(4)}`);
console.log(`             best_ask ${pct(stats.bestAsks, 0).toFixed(4)} - ${pct(stats.bestAsks, 1).toFixed(4)}`);

console.log(`\n--- Spread ---`);
console.log(`  Median spread:  ${median(stats.spreads).toFixed(4)}`);
console.log(`  Mean spread:    ${mean(stats.spreads).toFixed(4)}`);
console.log(`  p10 spread:     ${pct(stats.spreads, 0.1).toFixed(4)}`);
console.log(`  p90 spread:     ${pct(stats.spreads, 0.9).toFixed(4)}`);

console.log(`\n--- Bid Side ---`);
console.log(`  Median bid levels:    ${median(stats.bidLevelCounts).toFixed(0)}`);
console.log(`  Median best-bid size: ${median(stats.bestBidSizes).toFixed(0)} shares`);
console.log(`  Median total bid depth: ${median(stats.totalBidDepths).toFixed(0)} shares`);
console.log(`  Median bid depth ($):   $${median(stats.bidDepthDollars).toFixed(0)}`);
console.log(`  p10 total bid depth:    ${pct(stats.totalBidDepths, 0.1).toFixed(0)} shares`);
console.log(`  p90 total bid depth:    ${pct(stats.totalBidDepths, 0.9).toFixed(0)} shares`);

console.log(`\n--- Ask Side ---`);
console.log(`  Median ask levels:    ${median(stats.askLevelCounts).toFixed(0)}`);
console.log(`  Median total ask depth: ${median(stats.totalAskDepths).toFixed(0)} shares`);
console.log(`  Median ask depth ($):   $${median(stats.askDepthDollars).toFixed(0)}`);
console.log(`  p10 total ask depth:    ${pct(stats.totalAskDepths, 0.1).toFixed(0)} shares`);
console.log(`  p90 total ask depth:    ${pct(stats.totalAskDepths, 0.9).toFixed(0)} shares`);

// Breakdown by price bucket
console.log(`\n--- Breakdown by Price Bucket ---`);
const buckets = [
  { label: '0.01 - 0.03', lo: 0.01, hi: 0.03 },
  { label: '0.03 - 0.05', lo: 0.03, hi: 0.05 },
  { label: '0.05 - 0.07', lo: 0.05, hi: 0.07 },
  { label: '0.07 - 0.10', lo: 0.07, hi: 0.10 },
];

for (const bucket of buckets) {
  const indices = [];
  for (let i = 0; i < sampled.length; i++) {
    if (stats.bestBids[i] >= bucket.lo && stats.bestBids[i] < bucket.hi) {
      indices.push(i);
    }
  }
  if (indices.length === 0) {
    console.log(`  ${bucket.label}: no data`);
    continue;
  }
  const bidDepths = indices.map(i => stats.totalBidDepths[i]);
  const askDepths = indices.map(i => stats.totalAskDepths[i]);
  const bidSizes = indices.map(i => stats.bestBidSizes[i]);
  const bidLevels = indices.map(i => stats.bidLevelCounts[i]);
  const spr = indices.map(i => stats.spreads[i]);

  console.log(`  ${bucket.label} (n=${indices.length}):`);
  console.log(`    Median bid depth: ${median(bidDepths).toFixed(0)} shares | ask depth: ${median(askDepths).toFixed(0)} shares`);
  console.log(`    Median best-bid size: ${median(bidSizes).toFixed(0)} | bid levels: ${median(bidLevels).toFixed(0)}`);
  console.log(`    Median spread: ${median(spr).toFixed(4)}`);
}

// Check: how many snapshots have basically zero bid depth?
const zeroBid = stats.totalBidDepths.filter(d => d < 100).length;
const thinBid = stats.totalBidDepths.filter(d => d < 1000).length;
console.log(`\n--- Liquidity Flags ---`);
console.log(`  Snapshots with < 100 total bid shares: ${zeroBid} / ${sampled.length} (${(100 * zeroBid / sampled.length).toFixed(1)}%)`);
console.log(`  Snapshots with < 1,000 total bid shares: ${thinBid} / ${sampled.length} (${(100 * thinBid / sampled.length).toFixed(1)}%)`);

// Show a few example full books at different price levels
console.log(`\n${'='.repeat(80)}`);
console.log('EXAMPLE FULL ORDER BOOKS');
console.log('='.repeat(80));

// Pick one from each bucket
for (const bucket of buckets) {
  const idx = sampled.findIndex((r, i) => stats.bestBids[i] >= bucket.lo && stats.bestBids[i] < bucket.hi);
  if (idx === -1) continue;
  const row = sampled[idx];
  const tl = JSON.parse(row.top_levels);
  const ts = new Date(row.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 23);
  console.log(`\n--- Bid=${row.best_bid.toFixed(4)} Ask=${row.best_ask.toFixed(4)} @ ${ts} ---`);
  console.log('  BIDS:');
  for (const [price, size] of (tl.bids || []).slice(0, 8)) {
    console.log(`    ${price.toFixed(4)}  x  ${size.toFixed(0).padStart(8)}`);
  }
  if ((tl.bids || []).length > 8) console.log(`    ... (${tl.bids.length - 8} more levels)`);
  console.log('  ASKS:');
  for (const [price, size] of (tl.asks || []).slice(0, 8)) {
    console.log(`    ${price.toFixed(4)}  x  ${size.toFixed(0).padStart(8)}`);
  }
  if ((tl.asks || []).length > 8) console.log(`    ... (${tl.asks.length - 8} more levels)`);
}

db.close();
console.log('\nDone.');
