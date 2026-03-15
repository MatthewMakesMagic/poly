/**
 * Timeline SQLite Store
 *
 * Manages the SQLite database for pre-computed timelines.
 * Schema follows architecture spec: Decision 1 — Pre-Computed SQLite Timelines.
 *
 * The timelines table stores one row per window:
 *   - window_id: unique key (e.g., "btc-2026-03-01T12:15:00Z")
 *   - timeline: MessagePack-encoded sorted event array
 *   - data_quality: JSON metadata about event counts and gaps
 */

import { resolve } from 'path';
import Database from 'better-sqlite3';

const DEFAULT_PATH = resolve(process.cwd(), 'data', 'timelines.sqlite');

let db = null;
let currentPath = null;

/**
 * SQL for creating the timelines table.
 * Matches architecture spec exactly.
 */
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS timelines (
    window_id TEXT NOT NULL PRIMARY KEY,
    symbol TEXT NOT NULL,
    window_close_time TEXT NOT NULL,
    window_open_time TEXT NOT NULL,
    ground_truth TEXT,
    strike_price REAL,
    oracle_price_at_open REAL,
    chainlink_price_at_close REAL,
    timeline BLOB NOT NULL,
    event_count INTEGER NOT NULL,
    data_quality TEXT,
    built_at TEXT NOT NULL
  );
`;

const CREATE_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_timelines_symbol ON timelines(symbol);
  CREATE INDEX IF NOT EXISTS idx_timelines_close ON timelines(window_close_time);
`;

/**
 * Open (or return existing) database connection.
 * Creates schema if the database is new.
 *
 * @param {Object} [options]
 * @param {string} [options.path] - Path to SQLite file
 * @param {boolean} [options.readonly] - Open in read-only mode
 * @returns {import('better-sqlite3').Database}
 */
export function getDb(options = {}) {
  const dbPath = options.path || process.env.TIMELINE_DB_PATH || DEFAULT_PATH;

  if (db && currentPath === dbPath) return db;

  // Close existing connection if path changed
  if (db) {
    db.close();
    db = null;
  }

  db = new Database(dbPath, { readonly: options.readonly || false });
  currentPath = dbPath;

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('synchronous = NORMAL');

  if (!options.readonly) {
    initSchema(db);
  }

  return db;
}

/**
 * Initialize schema (idempotent).
 * @param {import('better-sqlite3').Database} database
 */
function initSchema(database) {
  database.exec(CREATE_TABLE_SQL);
  database.exec(CREATE_INDEXES_SQL);
}

/**
 * Close the database connection.
 */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
    currentPath = null;
  }
}

/**
 * Insert or replace a timeline row.
 *
 * @param {Object} row
 * @param {string} row.window_id
 * @param {string} row.symbol
 * @param {string} row.window_close_time
 * @param {string} row.window_open_time
 * @param {string|null} row.ground_truth
 * @param {number|null} row.strike_price
 * @param {number|null} row.oracle_price_at_open
 * @param {number|null} row.chainlink_price_at_close
 * @param {Buffer} row.timeline - MessagePack-encoded blob
 * @param {number} row.event_count
 * @param {string|null} row.data_quality - JSON string
 * @param {string} row.built_at
 */
export function insertTimeline(row) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO timelines
      (window_id, symbol, window_close_time, window_open_time,
       ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
       timeline, event_count, data_quality, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    row.window_id,
    row.symbol,
    row.window_close_time,
    row.window_open_time,
    row.ground_truth,
    row.strike_price,
    row.oracle_price_at_open,
    row.chainlink_price_at_close,
    row.timeline,
    row.event_count,
    row.data_quality,
    row.built_at,
  );
}

/**
 * Batch insert timelines in a transaction.
 *
 * @param {Object[]} rows - Array of timeline rows
 */
export function insertTimelines(rows) {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO timelines
      (window_id, symbol, window_close_time, window_open_time,
       ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
       timeline, event_count, data_quality, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = database.transaction((items) => {
    for (const row of items) {
      stmt.run(
        row.window_id,
        row.symbol,
        row.window_close_time,
        row.window_open_time,
        row.ground_truth,
        row.strike_price,
        row.oracle_price_at_open,
        row.chainlink_price_at_close,
        row.timeline,
        row.event_count,
        row.data_quality,
        row.built_at,
      );
    }
  });

  tx(rows);
}

/**
 * Get a single timeline row by window_id.
 *
 * @param {string} windowId
 * @returns {Object|undefined}
 */
export function getTimelineRow(windowId) {
  const database = getDb();
  return database.prepare('SELECT * FROM timelines WHERE window_id = ?').get(windowId);
}

/**
 * Get window metadata (without timeline blob) for a symbol.
 *
 * @param {string} symbol
 * @param {Object} [options]
 * @param {string} [options.startDate]
 * @param {string} [options.endDate]
 * @returns {Object[]}
 */
export function getWindowsForSymbol(symbol, options = {}) {
  const database = getDb();
  let sql = `
    SELECT window_id, symbol, window_close_time, window_open_time,
           ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
           event_count, data_quality, built_at
    FROM timelines
    WHERE symbol = ?
  `;
  const params = [symbol];

  if (options.startDate) {
    sql += ' AND window_close_time >= ?';
    params.push(options.startDate);
  }
  if (options.endDate) {
    sql += ' AND window_close_time <= ?';
    params.push(options.endDate);
  }

  sql += ' ORDER BY window_close_time ASC';

  return database.prepare(sql).all(...params);
}

/**
 * Get the latest window_close_time for a symbol in the cache.
 * Used for incremental builds.
 *
 * @param {string} symbol
 * @returns {string|null}
 */
export function getLatestWindowTime(symbol) {
  const database = getDb();
  const row = database.prepare(
    'SELECT MAX(window_close_time) as latest FROM timelines WHERE symbol = ?'
  ).get(symbol);
  return row?.latest || null;
}

/**
 * Delete all timelines for a symbol.
 * Used by --rebuild flag.
 *
 * @param {string} symbol
 * @returns {number} Number of rows deleted
 */
export function deleteSymbolTimelines(symbol) {
  const database = getDb();
  const result = database.prepare('DELETE FROM timelines WHERE symbol = ?').run(symbol);
  return result.changes;
}

/**
 * Get summary statistics for the cache.
 *
 * @returns {Object[]} Per-symbol stats
 */
export function getCacheSummary() {
  const database = getDb();
  return database.prepare(`
    SELECT
      symbol,
      COUNT(*) as total_windows,
      MIN(window_close_time) as earliest,
      MAX(window_close_time) as latest,
      AVG(event_count) as avg_event_count,
      SUM(CASE WHEN ground_truth IS NOT NULL THEN 1 ELSE 0 END) as with_ground_truth
    FROM timelines
    GROUP BY symbol
    ORDER BY symbol
  `).all();
}

/**
 * Get all window IDs for a symbol (for incremental build checks).
 *
 * @param {string} symbol
 * @returns {Set<string>}
 */
export function getExistingWindowIds(symbol) {
  const database = getDb();
  const rows = database.prepare(
    'SELECT window_id FROM timelines WHERE symbol = ?'
  ).all(symbol);
  return new Set(rows.map(r => r.window_id));
}
