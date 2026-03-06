#!/usr/bin/env node

/**
 * Export CoinGecko prices from PostgreSQL vwap_snapshots to local SQLite backtest DB.
 * Creates a coingecko_ticks table matching the shape of exchange_ticks for easy integration.
 *
 * Usage:
 *   node scripts/export-coingecko-to-sqlite.mjs
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SQLITE_PATH = process.env.SQLITE_PATH || resolve(process.cwd(), 'data', 'backtest.sqlite');
const BATCH_SIZE = 50000;

// Load DATABASE_URL
if (!process.env.DATABASE_URL) {
  try {
    const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const match = envContent.match(/^DATABASE_URL=(.+)$/m);
    if (match) process.env.DATABASE_URL = match[1].replace(/^["']|["']$/g, '');
  } catch { /* ignore */ }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

async function main() {
  console.log('=== Export CoinGecko data from PG to SQLite ===\n');

  // Connect to PG
  const client = new pg.Client(process.env.DATABASE_URL);
  await client.connect();
  console.log('Connected to PostgreSQL');

  // Open SQLite
  const db = new Database(SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -256000');

  // Create table
  db.exec(`
    CREATE TABLE IF NOT EXISTS coingecko_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price REAL NOT NULL
    )
  `);

  // Check if already populated
  const existing = db.prepare('SELECT COUNT(*) as c FROM coingecko_ticks').get();
  if (existing.c > 0) {
    console.log(`Table already has ${existing.c} rows. Dropping and rebuilding...`);
    db.exec('DELETE FROM coingecko_ticks');
  }

  // Get count from PG
  const countResult = await client.query(
    `SELECT COUNT(*) as c FROM vwap_snapshots WHERE coingecko_price IS NOT NULL`
  );
  const totalRows = parseInt(countResult.rows[0].c);
  console.log(`Total CoinGecko rows in PG: ${totalRows.toLocaleString()}`);

  // We only need ~1 tick per 10s per symbol (CG polls every 10s, but snapshots are ~1s)
  // Downsample: take one row per 10s bucket per symbol to keep it manageable
  console.log('Downsampling to ~1 tick per 10s per symbol...');

  const t0 = Date.now();
  const insert = db.prepare(
    'INSERT INTO coingecko_ticks (timestamp, symbol, price) VALUES (?, ?, ?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(r.timestamp, r.symbol, r.price);
    }
  });

  let offset = 0;
  let totalInserted = 0;

  // Use a cursor-like approach with DISTINCT ON to downsample
  // Group by symbol + 10-second bucket, take the first row from each
  const query = `
    SELECT DISTINCT ON (symbol, date_trunc('minute', timestamp) +
           (EXTRACT(second FROM timestamp)::int / 10 * 10) * interval '1 second')
      timestamp, symbol, coingecko_price as price
    FROM vwap_snapshots
    WHERE coingecko_price IS NOT NULL
    ORDER BY symbol,
             date_trunc('minute', timestamp) +
             (EXTRACT(second FROM timestamp)::int / 10 * 10) * interval '1 second',
             timestamp
  `;

  console.log('Querying PG (downsampled)...');
  const result = await client.query(query);
  console.log(`Got ${result.rows.length.toLocaleString()} downsampled rows`);

  // Insert in batches
  for (let i = 0; i < result.rows.length; i += BATCH_SIZE) {
    const batch = result.rows.slice(i, i + BATCH_SIZE).map(r => ({
      timestamp: r.timestamp.toISOString(),
      symbol: r.symbol,
      price: parseFloat(r.price),
    }));
    insertMany(batch);
    totalInserted += batch.length;
    process.stdout.write(`\r  Inserted: ${totalInserted.toLocaleString()} / ${result.rows.length.toLocaleString()}`);
  }
  console.log('');

  // Create index
  console.log('Creating index...');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_ticks_sym_time ON coingecko_ticks(symbol, timestamp)`);

  // Verify
  const verify = db.prepare('SELECT symbol, COUNT(*) as c, MIN(timestamp) as start, MAX(timestamp) as finish FROM coingecko_ticks GROUP BY symbol ORDER BY symbol').all();
  console.log('\n=== Verification ===');
  for (const r of verify) {
    console.log(`  ${r.symbol}: ${r.c.toLocaleString()} ticks, ${r.start.slice(0, 10)} to ${r.finish.slice(0, 10)}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s. Total: ${totalInserted.toLocaleString()} ticks exported to ${SQLITE_PATH}`);

  db.close();
  await client.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
