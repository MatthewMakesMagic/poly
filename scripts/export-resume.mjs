#!/usr/bin/env node

/**
 * Resume export: finish rtds_ticks from id 12999817, then clob, exchange, wbs.
 * Keeps existing data in backtest.sqlite.
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
    const match = envContent.match(/^DATABASE_URL=(.+)$/m);
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

async function batchExport(pool, db, { label, pgQuery, pgParams, insertSql, mapRow }) {
  console.log(`\n--- ${label} ---`);
  const insert = db.prepare(insertSql);
  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  // For resuming: check if we need a starting lastId
  if (pgParams.lastId) {
    lastId = pgParams.lastId;
    delete pgParams.lastId;
    console.log(`  Resuming from id ${lastId}`);
  }

  while (hasMore) {
    const params = typeof pgParams === 'function' ? pgParams(lastId) : [...(pgParams.base || []), lastId, BATCH_SIZE];
    let result;
    try {
      result = await pool.query(pgQuery, params);
    } catch (err) {
      console.error(`\n  Query error at id ${lastId}: ${err.message}`);
      console.log(`  Retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
      try {
        result = await pool.query(pgQuery, params);
      } catch (err2) {
        console.error(`  Retry failed: ${err2.message}`);
        break;
      }
    }

    const rows = result.rows;
    if (rows.length > 0) {
      const insertBatch = db.transaction((batch) => {
        for (const r of batch) insert.run(...mapRow(r));
      });
      insertBatch(rows);
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
      if (totalRows % 100000 === 0 || rows.length < BATCH_SIZE) {
        process.stdout.write(`\r  ${label}: ${totalRows} rows exported...`);
      }
    }
    hasMore = rows.length === BATCH_SIZE;
  }
  console.log(`\r  ${label}: ${totalRows} rows total          `);
  return totalRows;
}

async function main() {
  console.log('=== Resume Export ===\n');

  const pool = new pg.Pool({
    connectionString: getDbUrl(),
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    statement_timeout: 300000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });
  const client = await pool.connect();
  client.release();
  console.log('Postgres connected');

  const db = new Database(SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000');

  // Get time range from existing window_close_events
  const minMax = db.prepare('SELECT MIN(window_close_time) as mn, MAX(window_close_time) as mx FROM window_close_events').get();
  const startDate = new Date(new Date(minMax.mn).getTime() - 6 * 60 * 1000).toISOString();
  const endDate = new Date(new Date(minMax.mx).getTime() + 60 * 1000).toISOString();
  console.log(`Time range: ${startDate} to ${endDate}`);

  const t0 = Date.now();

  // 1. Finish rtds_ticks (resume from max id)
  const maxRtdsId = db.prepare('SELECT MAX(id) as m FROM rtds_ticks').get().m || 0;
  console.log(`\nResuming rtds_ticks from id ${maxRtdsId}...`);

  await batchExport(pool, db, {
    label: 'rtds_ticks (resume)',
    pgQuery: `SELECT id, timestamp, topic, symbol, price, received_at
              FROM rtds_ticks
              WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
              ORDER BY id ASC LIMIT $4`,
    pgParams: { base: [startDate, endDate], lastId: maxRtdsId },
    insertSql: `INSERT OR IGNORE INTO rtds_ticks (id, timestamp, topic, symbol, price, received_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
    mapRow: r => [r.id, toISOString(r.timestamp), r.topic, r.symbol, toReal(r.price), toISOString(r.received_at)],
  });

  // 2. clob_price_snapshots
  await batchExport(pool, db, {
    label: 'clob_price_snapshots',
    pgQuery: `SELECT id, timestamp, token_id, symbol, window_epoch,
              best_bid, best_ask, mid_price, spread, last_trade_price, bid_size_top, ask_size_top
              FROM clob_price_snapshots
              WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
              ORDER BY id ASC LIMIT $4`,
    pgParams: { base: [startDate, endDate] },
    insertSql: `INSERT INTO clob_price_snapshots (id, timestamp, token_id, symbol, window_epoch,
                best_bid, best_ask, mid_price, spread, last_trade_price, bid_size_top, ask_size_top)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mapRow: r => [
      r.id, toISOString(r.timestamp), r.token_id, r.symbol,
      r.window_epoch != null ? Number(r.window_epoch) : null,
      toReal(r.best_bid), toReal(r.best_ask), toReal(r.mid_price),
      toReal(r.spread), toReal(r.last_trade_price),
      toReal(r.bid_size_top), toReal(r.ask_size_top),
    ],
  });

  // 3. exchange_ticks
  await batchExport(pool, db, {
    label: 'exchange_ticks',
    pgQuery: `SELECT id, timestamp, exchange, symbol, price, bid, ask
              FROM exchange_ticks
              WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
              ORDER BY id ASC LIMIT $4`,
    pgParams: { base: [startDate, endDate] },
    insertSql: `INSERT INTO exchange_ticks (id, timestamp, exchange, symbol, price, bid, ask)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
    mapRow: r => [r.id, toISOString(r.timestamp), r.exchange, r.symbol, toReal(r.price), toReal(r.bid), toReal(r.ask)],
  });

  // 4. window_backtest_states
  await batchExport(pool, db, {
    label: 'window_backtest_states',
    pgQuery: `SELECT id, window_close_time, symbol, offset_ms,
              strike_price, chainlink_price, chainlink_ts,
              polyref_price, polyref_ts,
              clob_down_bid, clob_down_ask, clob_down_mid, clob_down_spread, clob_down_ts,
              clob_up_bid, clob_up_ask, clob_up_mid, clob_up_spread, clob_up_ts,
              exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
              resolved_direction, chainlink_at_close, created_at
              FROM window_backtest_states
              WHERE id > $1
              ORDER BY id ASC LIMIT $2`,
    pgParams: (lastId) => [lastId, BATCH_SIZE],
    insertSql: `INSERT INTO window_backtest_states (
                id, window_close_time, symbol, offset_ms,
                strike_price, chainlink_price, chainlink_ts,
                polyref_price, polyref_ts,
                clob_down_bid, clob_down_ask, clob_down_mid, clob_down_spread, clob_down_ts,
                clob_up_bid, clob_up_ask, clob_up_mid, clob_up_spread, clob_up_ts,
                exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
                resolved_direction, chainlink_at_close, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mapRow: r => [
      r.id, toISOString(r.window_close_time), r.symbol, r.offset_ms,
      toReal(r.strike_price), toReal(r.chainlink_price), toISOString(r.chainlink_ts),
      toReal(r.polyref_price), toISOString(r.polyref_ts),
      toReal(r.clob_down_bid), toReal(r.clob_down_ask), toReal(r.clob_down_mid),
      toReal(r.clob_down_spread), toISOString(r.clob_down_ts),
      toReal(r.clob_up_bid), toReal(r.clob_up_ask), toReal(r.clob_up_mid),
      toReal(r.clob_up_spread), toISOString(r.clob_up_ts),
      toReal(r.exchange_binance), toReal(r.exchange_coinbase), toReal(r.exchange_kraken),
      toReal(r.exchange_bybit), toReal(r.exchange_okx),
      r.resolved_direction, toReal(r.chainlink_at_close), toISOString(r.created_at),
    ],
  });

  // 5. Create indexes (idempotent)
  console.log('\nCreating indexes...');
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_rtds_timestamp ON rtds_ticks(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_rtds_symbol_topic ON rtds_ticks(symbol, topic)',
    'CREATE INDEX IF NOT EXISTS idx_clob_symbol_ts ON clob_price_snapshots(symbol, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_clob_epoch ON clob_price_snapshots(window_epoch)',
    'CREATE INDEX IF NOT EXISTS idx_clob_token_ts ON clob_price_snapshots(token_id, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_exch_exch_sym_ts ON exchange_ticks(exchange, symbol, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_exch_sym_ts ON exchange_ticks(symbol, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_wce_sym_time ON window_close_events(symbol, window_close_time)',
    'CREATE INDEX IF NOT EXISTS idx_wbs_time_offset ON window_backtest_states(window_close_time, symbol, offset_ms)',
  ];
  for (const sql of indexes) {
    const name = sql.match(/idx_\w+/)?.[0];
    process.stdout.write(`  ${name}...`);
    db.exec(sql);
    console.log(' done');
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const { statSync } = await import('fs');
  const fileSizeMB = (statSync(SQLITE_PATH).size / 1024 / 1024).toFixed(1);

  // Final counts
  const tables = ['window_close_events', 'rtds_ticks', 'clob_price_snapshots', 'exchange_ticks', 'window_backtest_states'];
  console.log('\n=== Export Complete ===');
  for (const t of tables) {
    const c = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c;
    console.log(`  ${t}: ${c} rows`);
  }
  console.log(`  Time: ${elapsed}s`);
  console.log(`  Size: ${fileSizeMB} MB`);

  db.close();
  await pool.end();
}

main().catch(err => {
  console.error('Resume failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
