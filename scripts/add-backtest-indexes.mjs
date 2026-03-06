#!/usr/bin/env node
/**
 * Add composite indexes to backtest.sqlite for per-window query performance.
 *
 * Indexes added:
 *   clob_price_snapshots(window_epoch, symbol, timestamp) — full composite for IN queries
 *   clob_price_snapshots(window_epoch, timestamp) — covers LIKE queries + ORDER BY
 *   rtds_ticks(timestamp, topic) — covers per-window rtds queries
 *
 * Also runs ANALYZE to update query planner statistics, then benchmarks.
 *
 * Performance note: set these pragmas in the runner for best results:
 *   db.pragma('cache_size = -256000');   // 256MB cache
 *   db.pragma('mmap_size = 2147483648'); // 2GB mmap
 * Warm-cache per-window CLOB queries: ~3ms avg (cold: ~14ms).
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'backtest.sqlite');

console.log(`Opening ${dbPath} ...`);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ── 1. Create indexes ──────────────────────────────────────────────

const indexes = [
  {
    name: 'idx_clob_epoch_sym_ts',
    table: 'clob_price_snapshots',
    sql: 'CREATE INDEX IF NOT EXISTS idx_clob_epoch_sym_ts ON clob_price_snapshots(window_epoch, symbol, timestamp)',
  },
  {
    name: 'idx_clob_epoch_ts',
    table: 'clob_price_snapshots',
    sql: 'CREATE INDEX IF NOT EXISTS idx_clob_epoch_ts ON clob_price_snapshots(window_epoch, timestamp)',
  },
  {
    name: 'idx_rtds_ts_topic',
    table: 'rtds_ticks',
    sql: 'CREATE INDEX IF NOT EXISTS idx_rtds_ts_topic ON rtds_ticks(timestamp, topic)',
  },
];

for (const idx of indexes) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?")
    .get(idx.name);

  if (exists) {
    console.log(`  [ok] ${idx.name} already exists — skipping`);
  } else {
    console.log(`  Creating ${idx.name} on ${idx.table} ...`);
    const t0 = Date.now();
    db.exec(idx.sql);
    console.log(`  [ok] ${idx.name} created in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

// ── 2. ANALYZE ─────────────────────────────────────────────────────

console.log('\nRunning ANALYZE ...');
const t0 = Date.now();
db.exec('ANALYZE');
console.log(`ANALYZE done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 3. Benchmark per-window CLOB queries ───────────────────────────

console.log('\nBenchmarking per-window CLOB queries ...');

// Performance pragmas
db.pragma('cache_size = -256000');
db.pragma('mmap_size = 2147483648');

const epochs = db
  .prepare('SELECT DISTINCT window_epoch FROM clob_price_snapshots ORDER BY window_epoch LIMIT 20')
  .all()
  .map((r) => r.window_epoch);

const stmt = db.prepare(`
  SELECT timestamp, symbol, token_id, best_bid, best_ask,
         mid_price, spread, bid_size_top, ask_size_top, window_epoch
  FROM clob_price_snapshots
  WHERE timestamp >= ? AND timestamp <= ?
    AND symbol LIKE ?
    AND window_epoch = ?
  ORDER BY timestamp ASC
`);

// Warm-up pass (first 10 epochs)
console.log('  Warming cache with 10 queries ...');
for (const epoch of epochs.slice(0, 10)) {
  const openDate = new Date(epoch * 1000).toISOString();
  const closeDate = new Date((epoch + 900) * 1000).toISOString();
  stmt.all(openDate, closeDate, 'btc%', epoch);
}

// Cold benchmark (next 10 epochs, never queried)
console.log('\n  Cold queries (first access):');
const coldDurations = [];
for (const epoch of epochs.slice(10, 20)) {
  const openDate = new Date(epoch * 1000).toISOString();
  const closeDate = new Date((epoch + 900) * 1000).toISOString();
  const t1 = performance.now();
  const rows = stmt.all(openDate, closeDate, 'btc%', epoch);
  const elapsed = performance.now() - t1;
  coldDurations.push(elapsed);
  console.log(`    epoch=${epoch}  rows=${rows.length}  ${elapsed.toFixed(2)} ms`);
}
const coldAvg = coldDurations.reduce((a, b) => a + b, 0) / coldDurations.length;

// Warm benchmark (re-read first 10 epochs, already cached)
console.log('\n  Warm queries (cached):');
const warmDurations = [];
for (const epoch of epochs.slice(0, 10)) {
  const openDate = new Date(epoch * 1000).toISOString();
  const closeDate = new Date((epoch + 900) * 1000).toISOString();
  const t1 = performance.now();
  const rows = stmt.all(openDate, closeDate, 'btc%', epoch);
  const elapsed = performance.now() - t1;
  warmDurations.push(elapsed);
  console.log(`    epoch=${epoch}  rows=${rows.length}  ${elapsed.toFixed(2)} ms`);
}
const warmAvg = warmDurations.reduce((a, b) => a + b, 0) / warmDurations.length;

console.log(`\nCold avg: ${coldAvg.toFixed(2)} ms | Warm avg: ${warmAvg.toFixed(2)} ms`);
if (warmAvg < 10) {
  console.log('PASS — warm-cache average < 10 ms');
} else {
  console.log('WARN — warm-cache average >= 10 ms');
}

db.close();
console.log('\nDone.');
