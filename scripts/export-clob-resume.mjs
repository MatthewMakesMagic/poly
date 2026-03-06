#!/usr/bin/env node

/**
 * Resume CLOB price snapshot export from id 14576720.
 * Fills the gap: currently Feb 11-17, need through Mar 2.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';
import Database from 'better-sqlite3';

const BATCH_SIZE = 10000;
const SQLITE_PATH = resolve(process.cwd(), 'data/backtest.sqlite');

function getDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const match = envContent.match(/^DATABASE_URL="?([^"\n]+)"?$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  throw new Error('DATABASE_URL not set');
}

function toISOString(val) {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toReal(val) {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  console.log('=== Resume CLOB Export ===\n');

  const pool = new pg.Pool({
    connectionString: getDbUrl(),
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    statement_timeout: 300000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  // Test connection
  const client = await pool.connect();
  client.release();
  console.log('Postgres connected');

  const db = new Database(SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000');

  // Get current max id
  const maxId = db.prepare('SELECT MAX(id) as m FROM clob_price_snapshots').get().m || 0;
  console.log(`Resuming from id ${maxId}`);

  // Get time range from window_close_events
  const minMax = db.prepare('SELECT MIN(window_close_time) as mn, MAX(window_close_time) as mx FROM window_close_events').get();
  const startDate = new Date(new Date(minMax.mn).getTime() - 6 * 60 * 1000).toISOString();
  const endDate = new Date(new Date(minMax.mx).getTime() + 60 * 1000).toISOString();
  console.log(`Time range: ${startDate} to ${endDate}`);

  const insert = db.prepare(`INSERT OR IGNORE INTO clob_price_snapshots
    (id, timestamp, token_id, symbol, window_epoch,
     best_bid, best_ask, mid_price, spread, last_trade_price, bid_size_top, ask_size_top)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const t0 = Date.now();
  let lastId = maxId;
  let totalRows = 0;
  let retries = 0;
  const MAX_RETRIES = 5;

  while (true) {
    let result;
    try {
      result = await pool.query(
        `SELECT id, timestamp, token_id, symbol, window_epoch,
                best_bid, best_ask, mid_price, spread, last_trade_price, bid_size_top, ask_size_top
         FROM clob_price_snapshots
         WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
         ORDER BY id ASC LIMIT $4`,
        [startDate, endDate, lastId, BATCH_SIZE]
      );
      retries = 0; // Reset on success
    } catch (err) {
      retries++;
      console.error(`\n  Query error at id ${lastId}: ${err.message}`);
      if (retries >= MAX_RETRIES) {
        console.error(`  Max retries (${MAX_RETRIES}) reached. Stopping.`);
        break;
      }
      const waitSec = Math.min(10 * retries, 30);
      console.log(`  Retry ${retries}/${MAX_RETRIES} in ${waitSec}s...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      // Reconnect pool
      try { await pool.end(); } catch {}
      Object.assign(pool, new pg.Pool({
        connectionString: getDbUrl(),
        max: 3,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 30000,
        statement_timeout: 300000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      }));
      continue;
    }

    const rows = result.rows;
    if (rows.length === 0) break;

    const insertBatch = db.transaction((batch) => {
      for (const r of batch) {
        insert.run(
          r.id, toISOString(r.timestamp), r.token_id, r.symbol,
          r.window_epoch != null ? Number(r.window_epoch) : null,
          toReal(r.best_bid), toReal(r.best_ask), toReal(r.mid_price),
          toReal(r.spread), toReal(r.last_trade_price),
          toReal(r.bid_size_top), toReal(r.ask_size_top)
        );
      }
    });
    insertBatch(rows);

    lastId = rows[rows.length - 1].id;
    totalRows += rows.length;

    if (totalRows % 50000 === 0 || rows.length < BATCH_SIZE) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (totalRows / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  CLOB: ${totalRows} rows | last_id=${lastId} | ${rate} rows/s | ${elapsed}s`);
    }

    if (rows.length < BATCH_SIZE) break;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\nExport complete: ${totalRows} new rows in ${elapsed}s`);

  // Final stats
  const count = db.prepare('SELECT COUNT(*) as c FROM clob_price_snapshots').get().c;
  const range = db.prepare('SELECT MIN(timestamp) as mn, MAX(timestamp) as mx FROM clob_price_snapshots').get();
  console.log(`Total CLOB rows: ${count}`);
  console.log(`Range: ${range.mn} → ${range.mx}`);

  const { statSync } = await import('fs');
  console.log(`SQLite size: ${(statSync(SQLITE_PATH).size / 1024 / 1024).toFixed(1)} MB`);

  db.close();
  await pool.end();
}

main().catch(err => {
  console.error('Failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
