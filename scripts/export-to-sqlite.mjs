#!/usr/bin/env node

/**
 * Export Postgres backtest data to local SQLite file.
 *
 * Streams data from remote Postgres in batches and writes to
 * data/backtest.sqlite for fully-offline local backtesting.
 *
 * Usage:
 *   export $(grep DATABASE_URL .env.local | xargs)
 *   node scripts/export-to-sqlite.mjs
 */

import { readFileSync, statSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';
import Database from 'better-sqlite3';

const BATCH_SIZE = 10000;
const SQLITE_PATH = resolve(process.cwd(), 'data/backtest.sqlite');

// ─── Postgres Connection ───

function getDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const match = envContent.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  throw new Error('DATABASE_URL not set. Run: export $(grep DATABASE_URL .env.local | xargs)');
}

async function createPgPool() {
  const pool = new pg.Pool({
    connectionString: getDbUrl(),
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    statement_timeout: 600000,
  });
  // Verify connection
  const client = await pool.connect();
  client.release();
  return pool;
}

// ─── SQLite Schema ───

function createSqliteDb() {
  mkdirSync(resolve(process.cwd(), 'data'), { recursive: true });

  // Remove existing file for clean export
  const db = new Database(SQLITE_PATH);

  // Performance pragmas for bulk insert
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS window_close_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_close_time TEXT NOT NULL,
      symbol TEXT,
      strike_price REAL,
      chainlink_price_at_close REAL,
      oracle_price_at_open REAL,
      resolved_direction TEXT,
      onchain_resolved_direction TEXT,
      gamma_resolved_direction TEXT,
      polymarket_binance_at_close REAL,
      binance_price_at_close REAL,
      oracle_price_at_close REAL,
      pyth_price_at_close REAL,
      market_up_price_60s REAL,
      market_up_price_30s REAL,
      market_up_price_10s REAL,
      market_up_price_5s REAL,
      market_up_price_1s REAL,
      market_down_price_60s REAL,
      market_down_price_30s REAL,
      market_down_price_10s REAL,
      market_down_price_5s REAL,
      market_down_price_1s REAL,
      market_consensus_direction TEXT,
      market_consensus_confidence REAL,
      surprise_resolution INTEGER
    );

    CREATE TABLE IF NOT EXISTS rtds_ticks (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      topic TEXT,
      symbol TEXT,
      price REAL,
      received_at TEXT
    );

    CREATE TABLE IF NOT EXISTS clob_price_snapshots (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      token_id TEXT,
      symbol TEXT,
      window_epoch INTEGER,
      best_bid REAL,
      best_ask REAL,
      mid_price REAL,
      spread REAL,
      last_trade_price REAL,
      bid_size_top REAL,
      ask_size_top REAL
    );

    CREATE TABLE IF NOT EXISTS exchange_ticks (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      exchange TEXT,
      symbol TEXT,
      price REAL,
      bid REAL,
      ask REAL
    );

    CREATE TABLE IF NOT EXISTS l2_book_ticks (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      token_id TEXT,
      symbol TEXT,
      window_id TEXT,
      event_type TEXT,
      best_bid REAL,
      best_ask REAL,
      mid_price REAL,
      spread REAL,
      bid_depth_1pct REAL,
      ask_depth_1pct REAL,
      top_levels TEXT
    );

    CREATE TABLE IF NOT EXISTS window_backtest_states (
      id INTEGER PRIMARY KEY,
      window_close_time TEXT NOT NULL,
      symbol TEXT NOT NULL,
      offset_ms INTEGER NOT NULL,
      strike_price REAL,
      chainlink_price REAL,
      chainlink_ts TEXT,
      polyref_price REAL,
      polyref_ts TEXT,
      clob_down_bid REAL,
      clob_down_ask REAL,
      clob_down_mid REAL,
      clob_down_spread REAL,
      clob_down_ts TEXT,
      clob_up_bid REAL,
      clob_up_ask REAL,
      clob_up_mid REAL,
      clob_up_spread REAL,
      clob_up_ts TEXT,
      exchange_binance REAL,
      exchange_coinbase REAL,
      exchange_kraken REAL,
      exchange_bybit REAL,
      exchange_okx REAL,
      resolved_direction TEXT,
      chainlink_at_close REAL,
      created_at TEXT
    );
  `);

  return db;
}

function createIndexes(db) {
  console.log('\nCreating indexes...');

  const indexes = [
    // rtds_ticks
    'CREATE INDEX IF NOT EXISTS idx_rtds_timestamp ON rtds_ticks(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_rtds_symbol_topic ON rtds_ticks(symbol, topic)',
    // clob_price_snapshots
    'CREATE INDEX IF NOT EXISTS idx_clob_symbol_ts ON clob_price_snapshots(symbol, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_clob_epoch ON clob_price_snapshots(window_epoch)',
    'CREATE INDEX IF NOT EXISTS idx_clob_token_ts ON clob_price_snapshots(token_id, timestamp)',
    // exchange_ticks
    'CREATE INDEX IF NOT EXISTS idx_exch_exch_sym_ts ON exchange_ticks(exchange, symbol, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_exch_sym_ts ON exchange_ticks(symbol, timestamp)',
    // window_close_events
    'CREATE INDEX IF NOT EXISTS idx_wce_sym_time ON window_close_events(symbol, window_close_time)',
    // window_backtest_states
    'CREATE INDEX IF NOT EXISTS idx_wbs_time_offset ON window_backtest_states(window_close_time, symbol, offset_ms)',
    // l2_book_ticks
    'CREATE INDEX IF NOT EXISTS idx_l2_sym_ts ON l2_book_ticks(symbol, timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_l2_token_ts ON l2_book_ticks(token_id, timestamp)',
  ];

  for (const sql of indexes) {
    const name = sql.match(/idx_\w+/)?.[0] || 'unknown';
    process.stdout.write(`  ${name}...`);
    db.exec(sql);
    console.log(' done');
  }
}

// ─── Timestamp helpers ───

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

// ─── Export Functions ───

async function exportWindowCloseEvents(pool, db) {
  console.log('\n--- window_close_events ---');

  // Check for gamma column
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'window_close_events' AND column_name = 'gamma_resolved_direction'
  `);
  const hasGamma = colCheck.rows.length > 0;

  // Check for oracle_price_at_open column
  const oracleOpenCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'window_close_events' AND column_name = 'oracle_price_at_open'
  `);
  const hasOracleOpen = oracleOpenCheck.rows.length > 0;

  let sql = `
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close,
           ${hasOracleOpen ? 'oracle_price_at_open,' : ''}
           resolved_direction, onchain_resolved_direction,
           ${hasGamma ? 'gamma_resolved_direction,' : ''}
           polymarket_binance_at_close, binance_price_at_close,
           oracle_price_at_close, pyth_price_at_close,
           market_up_price_60s, market_up_price_30s, market_up_price_10s,
           market_up_price_5s, market_up_price_1s,
           market_down_price_60s, market_down_price_30s, market_down_price_10s,
           market_down_price_5s, market_down_price_1s,
           market_consensus_direction, market_consensus_confidence,
           surprise_resolution
    FROM window_close_events
    ORDER BY window_close_time ASC
  `;

  const result = await pool.query(sql);
  const rows = result.rows;
  console.log(`  Fetched ${rows.length} rows from Postgres`);

  const insert = db.prepare(`
    INSERT INTO window_close_events (
      window_close_time, symbol, strike_price,
      chainlink_price_at_close, oracle_price_at_open,
      resolved_direction, onchain_resolved_direction, gamma_resolved_direction,
      polymarket_binance_at_close, binance_price_at_close,
      oracle_price_at_close, pyth_price_at_close,
      market_up_price_60s, market_up_price_30s, market_up_price_10s,
      market_up_price_5s, market_up_price_1s,
      market_down_price_60s, market_down_price_30s, market_down_price_10s,
      market_down_price_5s, market_down_price_1s,
      market_consensus_direction, market_consensus_confidence,
      surprise_resolution
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(
        toISOString(r.window_close_time), r.symbol, toReal(r.strike_price),
        toReal(r.chainlink_price_at_close), toReal(r.oracle_price_at_open ?? null),
        r.resolved_direction, r.onchain_resolved_direction, r.gamma_resolved_direction ?? null,
        toReal(r.polymarket_binance_at_close), toReal(r.binance_price_at_close),
        toReal(r.oracle_price_at_close), toReal(r.pyth_price_at_close),
        toReal(r.market_up_price_60s), toReal(r.market_up_price_30s), toReal(r.market_up_price_10s),
        toReal(r.market_up_price_5s), toReal(r.market_up_price_1s),
        toReal(r.market_down_price_60s), toReal(r.market_down_price_30s), toReal(r.market_down_price_10s),
        toReal(r.market_down_price_5s), toReal(r.market_down_price_1s),
        r.market_consensus_direction, toReal(r.market_consensus_confidence),
        r.surprise_resolution ? 1 : 0
      );
    }
  });

  insertMany(rows);
  console.log(`  Inserted ${rows.length} rows into SQLite`);

  return rows;
}

async function getTimeRange(windowEvents) {
  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const w of windowEvents) {
    const t = new Date(w.window_close_time).getTime();
    if (t < minTime) minTime = t;
    if (t > maxTime) maxTime = t;
  }
  // 6 minutes before earliest window close, 1 minute after latest
  const startDate = new Date(minTime - 6 * 60 * 1000).toISOString();
  const endDate = new Date(maxTime + 1 * 60 * 1000).toISOString();
  console.log(`\nTime range: ${startDate} to ${endDate}`);
  return { startDate, endDate };
}

async function exportRtdsTicks(pool, db, startDate, endDate) {
  console.log('\n--- rtds_ticks ---');

  const insert = db.prepare(`
    INSERT INTO rtds_ticks (id, timestamp, topic, symbol, price, received_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await pool.query(
      `SELECT id, timestamp, topic, symbol, price, received_at
       FROM rtds_ticks
       WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
       ORDER BY id ASC LIMIT $4`,
      [startDate, endDate, lastId, BATCH_SIZE]
    );

    const rows = result.rows;
    if (rows.length > 0) {
      const insertBatch = db.transaction((batch) => {
        for (const r of batch) {
          insert.run(r.id, toISOString(r.timestamp), r.topic, r.symbol, toReal(r.price), toISOString(r.received_at));
        }
      });
      insertBatch(rows);
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
      process.stdout.write(`\r  Exported ${totalRows} rows...`);
    }

    hasMore = rows.length === BATCH_SIZE;
  }

  console.log(`\r  Exported ${totalRows} rows total    `);
  return totalRows;
}

async function exportClobSnapshots(pool, db, startDate, endDate) {
  console.log('\n--- clob_price_snapshots ---');

  const insert = db.prepare(`
    INSERT INTO clob_price_snapshots (id, timestamp, token_id, symbol, window_epoch,
      best_bid, best_ask, mid_price, spread, last_trade_price, bid_size_top, ask_size_top)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await pool.query(
      `SELECT id, timestamp, token_id, symbol, window_epoch,
              best_bid, best_ask, mid_price, spread, last_trade_price, bid_size_top, ask_size_top
       FROM clob_price_snapshots
       WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
       ORDER BY id ASC LIMIT $4`,
      [startDate, endDate, lastId, BATCH_SIZE]
    );

    const rows = result.rows;
    if (rows.length > 0) {
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
      process.stdout.write(`\r  Exported ${totalRows} rows...`);
    }

    hasMore = rows.length === BATCH_SIZE;
  }

  console.log(`\r  Exported ${totalRows} rows total    `);
  return totalRows;
}

async function exportExchangeTicks(pool, db, startDate, endDate) {
  console.log('\n--- exchange_ticks ---');

  const insert = db.prepare(`
    INSERT INTO exchange_ticks (id, timestamp, exchange, symbol, price, bid, ask)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await pool.query(
      `SELECT id, timestamp, exchange, symbol, price, bid, ask
       FROM exchange_ticks
       WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
       ORDER BY id ASC LIMIT $4`,
      [startDate, endDate, lastId, BATCH_SIZE]
    );

    const rows = result.rows;
    if (rows.length > 0) {
      const insertBatch = db.transaction((batch) => {
        for (const r of batch) {
          insert.run(r.id, toISOString(r.timestamp), r.exchange, r.symbol, toReal(r.price), toReal(r.bid), toReal(r.ask));
        }
      });
      insertBatch(rows);
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
      process.stdout.write(`\r  Exported ${totalRows} rows...`);
    }

    hasMore = rows.length === BATCH_SIZE;
  }

  console.log(`\r  Exported ${totalRows} rows total    `);
  return totalRows;
}

async function exportL2BookTicks(pool, db, startDate, endDate) {
  console.log('\n--- l2_book_ticks ---');

  const insert = db.prepare(`
    INSERT INTO l2_book_ticks (id, timestamp, token_id, symbol, window_id, event_type,
      best_bid, best_ask, mid_price, spread, bid_depth_1pct, ask_depth_1pct, top_levels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await pool.query(
      `SELECT id, timestamp, token_id, symbol, window_id, event_type,
              best_bid, best_ask, mid_price, spread, bid_depth_1pct, ask_depth_1pct, top_levels
       FROM l2_book_ticks
       WHERE timestamp >= $1 AND timestamp <= $2 AND id > $3
       ORDER BY id ASC LIMIT $4`,
      [startDate, endDate, lastId, BATCH_SIZE]
    );

    const rows = result.rows;
    if (rows.length > 0) {
      const insertBatch = db.transaction((batch) => {
        for (const r of batch) {
          insert.run(
            r.id, toISOString(r.timestamp), r.token_id, r.symbol,
            r.window_id, r.event_type,
            toReal(r.best_bid), toReal(r.best_ask), toReal(r.mid_price),
            toReal(r.spread), toReal(r.bid_depth_1pct), toReal(r.ask_depth_1pct),
            r.top_levels != null ? JSON.stringify(r.top_levels) : null
          );
        }
      });
      insertBatch(rows);
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
      process.stdout.write(`\r  Exported ${totalRows} rows...`);
    }

    hasMore = rows.length === BATCH_SIZE;
  }

  console.log(`\r  Exported ${totalRows} rows total    `);
  return totalRows;
}

async function exportWindowBacktestStates(pool, db) {
  console.log('\n--- window_backtest_states ---');

  const insert = db.prepare(`
    INSERT INTO window_backtest_states (
      id, window_close_time, symbol, offset_ms,
      strike_price, chainlink_price, chainlink_ts,
      polyref_price, polyref_ts,
      clob_down_bid, clob_down_ask, clob_down_mid, clob_down_spread, clob_down_ts,
      clob_up_bid, clob_up_ask, clob_up_mid, clob_up_spread, clob_up_ts,
      exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
      resolved_direction, chainlink_at_close, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let lastId = 0;
  let totalRows = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await pool.query(
      `SELECT id, window_close_time, symbol, offset_ms,
              strike_price, chainlink_price, chainlink_ts,
              polyref_price, polyref_ts,
              clob_down_bid, clob_down_ask, clob_down_mid, clob_down_spread, clob_down_ts,
              clob_up_bid, clob_up_ask, clob_up_mid, clob_up_spread, clob_up_ts,
              exchange_binance, exchange_coinbase, exchange_kraken, exchange_bybit, exchange_okx,
              resolved_direction, chainlink_at_close, created_at
       FROM window_backtest_states
       WHERE id > $1
       ORDER BY id ASC LIMIT $2`,
      [lastId, BATCH_SIZE]
    );

    const rows = result.rows;
    if (rows.length > 0) {
      const insertBatch = db.transaction((batch) => {
        for (const r of batch) {
          insert.run(
            r.id, toISOString(r.window_close_time), r.symbol, r.offset_ms,
            toReal(r.strike_price), toReal(r.chainlink_price), toISOString(r.chainlink_ts),
            toReal(r.polyref_price), toISOString(r.polyref_ts),
            toReal(r.clob_down_bid), toReal(r.clob_down_ask), toReal(r.clob_down_mid),
            toReal(r.clob_down_spread), toISOString(r.clob_down_ts),
            toReal(r.clob_up_bid), toReal(r.clob_up_ask), toReal(r.clob_up_mid),
            toReal(r.clob_up_spread), toISOString(r.clob_up_ts),
            toReal(r.exchange_binance), toReal(r.exchange_coinbase), toReal(r.exchange_kraken),
            toReal(r.exchange_bybit), toReal(r.exchange_okx),
            r.resolved_direction, toReal(r.chainlink_at_close), toISOString(r.created_at)
          );
        }
      });
      insertBatch(rows);
      lastId = rows[rows.length - 1].id;
      totalRows += rows.length;
      process.stdout.write(`\r  Exported ${totalRows} rows...`);
    }

    hasMore = rows.length === BATCH_SIZE;
  }

  console.log(`\r  Exported ${totalRows} rows total    `);
  return totalRows;
}

// ─── Main ───

async function main() {
  console.log('=== Export Postgres to SQLite ===\n');
  console.log(`Target: ${SQLITE_PATH}`);

  const pool = await createPgPool();
  console.log('Postgres connected');

  const db = createSqliteDb();
  console.log('SQLite database created');

  const t0 = Date.now();

  // 1. Export window_close_events first (need time range)
  const windowEvents = await exportWindowCloseEvents(pool, db);

  if (windowEvents.length === 0) {
    console.log('\nNo window events found. Nothing to export.');
    db.close();
    await pool.end();
    return;
  }

  // 2. Compute time range
  const { startDate, endDate } = await getTimeRange(windowEvents);

  // 3. Export tick tables
  const rtdsCount = await exportRtdsTicks(pool, db, startDate, endDate);
  const clobCount = await exportClobSnapshots(pool, db, startDate, endDate);
  const l2Count = await exportL2BookTicks(pool, db, startDate, endDate);
  const exchCount = await exportExchangeTicks(pool, db, startDate, endDate);

  // 4. Export window_backtest_states (all rows, no time filter needed)
  const wbsCount = await exportWindowBacktestStates(pool, db);

  // 5. Create indexes
  createIndexes(db);

  // 6. Final stats
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const fileSize = statSync(SQLITE_PATH).size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

  console.log('\n=== Export Complete ===');
  console.log(`  window_close_events:    ${windowEvents.length} rows`);
  console.log(`  rtds_ticks:             ${rtdsCount} rows`);
  console.log(`  clob_price_snapshots:   ${clobCount} rows`);
  console.log(`  l2_book_ticks:          ${l2Count} rows`);
  console.log(`  exchange_ticks:         ${exchCount} rows`);
  console.log(`  window_backtest_states: ${wbsCount} rows`);
  console.log(`  Total time:             ${elapsed}s`);
  console.log(`  File size:              ${fileSizeMB} MB`);
  console.log(`  Path:                   ${SQLITE_PATH}`);

  db.close();
  await pool.end();
}

main().catch(err => {
  console.error('\nExport failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
