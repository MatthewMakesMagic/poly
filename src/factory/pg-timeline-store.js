/**
 * PG Timeline Store
 *
 * Server-side timeline cache in PostgreSQL, mirroring the SQLite timeline store.
 * Stores MessagePack-serialized timeline blobs as BYTEA for fast reads on Railway.
 *
 * Includes schema_version filtering to handle future timeline format changes
 * (adversarial review requirement).
 */

import persistence from '../persistence/index.js';

// Current schema version — bump when timeline event format changes.
// Cache reads filter by this version to avoid serving stale cached data.
const CURRENT_SCHEMA_VERSION = 3; // v3: include extreme CLOB prices (v2 filtered mid < 0.05 || mid > 0.95)

/**
 * Ensure the pg_timelines table exists.
 * Called automatically — safe to call multiple times.
 */
export async function ensurePgTimelineTable() {
  await persistence.exec(`
    CREATE TABLE IF NOT EXISTS pg_timelines (
      window_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      window_close_time TIMESTAMPTZ NOT NULL,
      window_open_time TIMESTAMPTZ NOT NULL,
      ground_truth TEXT,
      strike_price REAL,
      oracle_price_at_open REAL,
      chainlink_price_at_close REAL,
      timeline BYTEA NOT NULL,
      event_count INTEGER NOT NULL,
      data_quality JSONB,
      schema_version INTEGER NOT NULL DEFAULT 1,
      built_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pg_timelines_symbol ON pg_timelines(symbol);
    CREATE INDEX IF NOT EXISTS idx_pg_timelines_close ON pg_timelines(window_close_time);
    CREATE INDEX IF NOT EXISTS idx_pg_timelines_symbol_close ON pg_timelines(symbol, window_close_time);
  `);
}

/**
 * Insert a single timeline into pg_timelines.
 * Uses ON CONFLICT DO UPDATE to handle re-builds.
 *
 * @param {Object} row - Timeline row (same shape as SQLite timeline-store)
 */
export async function insertPgTimeline(row) {
  await persistence.run(`
    INSERT INTO pg_timelines
      (window_id, symbol, window_close_time, window_open_time,
       ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
       timeline, event_count, data_quality, schema_version, built_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (window_id) DO UPDATE SET
      timeline = EXCLUDED.timeline,
      event_count = EXCLUDED.event_count,
      data_quality = EXCLUDED.data_quality,
      schema_version = EXCLUDED.schema_version,
      built_at = EXCLUDED.built_at
  `, [
    row.window_id,
    row.symbol,
    row.window_close_time,
    row.window_open_time,
    row.ground_truth,
    row.strike_price,
    row.oracle_price_at_open,
    row.chainlink_price_at_close,
    row.timeline, // Buffer (BYTEA)
    row.event_count,
    typeof row.data_quality === 'string' ? row.data_quality : JSON.stringify(row.data_quality),
    CURRENT_SCHEMA_VERSION,
    row.built_at || new Date().toISOString(),
  ]);
}

/**
 * Insert a timeline with ON CONFLICT DO NOTHING (for auto-build race safety).
 * Used by the window-close-event hook to avoid clobbering concurrent builds.
 *
 * @param {Object} row - Timeline row
 */
export async function insertPgTimelineIfNotExists(row) {
  await persistence.run(`
    INSERT INTO pg_timelines
      (window_id, symbol, window_close_time, window_open_time,
       ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
       timeline, event_count, data_quality, schema_version, built_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (window_id) DO NOTHING
  `, [
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
    typeof row.data_quality === 'string' ? row.data_quality : JSON.stringify(row.data_quality),
    CURRENT_SCHEMA_VERSION,
    row.built_at || new Date().toISOString(),
  ]);
}

/**
 * Batch insert timelines.
 *
 * @param {Object[]} rows - Array of timeline rows
 */
export async function insertPgTimelines(rows) {
  for (const row of rows) {
    await insertPgTimeline(row);
  }
}

/**
 * Get a single timeline by window_id.
 * Filters by current schema_version to avoid stale data.
 *
 * @param {string} windowId
 * @returns {Promise<Object|null>}
 */
export async function getPgTimeline(windowId) {
  const row = await persistence.get(`
    SELECT * FROM pg_timelines
    WHERE window_id = $1 AND schema_version = $2
  `, [windowId, CURRENT_SCHEMA_VERSION]);
  return row || null;
}

/**
 * Get window metadata (without timeline blob) for a symbol.
 * Used for sampling — pick windows first, then load full timelines for selected ones.
 *
 * @param {string} symbol
 * @param {Object} [options]
 * @param {string} [options.startDate]
 * @param {string} [options.endDate]
 * @returns {Promise<Object[]>}
 */
export async function getPgWindowsForSymbol(symbol, options = {}) {
  let sql = `
    SELECT window_id, symbol, window_close_time, window_open_time,
           ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close,
           event_count, data_quality, schema_version, built_at
    FROM pg_timelines
    WHERE symbol = $1 AND schema_version = $2
  `;
  const params = [symbol, CURRENT_SCHEMA_VERSION];

  if (options.startDate) {
    sql += ` AND window_close_time >= $${params.length + 1}`;
    params.push(options.startDate);
  }
  if (options.endDate) {
    sql += ` AND window_close_time <= $${params.length + 1}`;
    params.push(options.endDate);
  }

  sql += ' ORDER BY window_close_time ASC';

  return persistence.all(sql, params);
}

/**
 * Get latest window_close_time for a symbol (for incremental builds).
 *
 * @param {string} symbol
 * @returns {Promise<string|null>}
 */
/**
 * Get all cached window IDs for a symbol.
 * Used to find gaps — compare against window_close_events to find missing windows.
 */
export async function getExistingPgWindowIds(symbol) {
  const rows = await persistence.all(`
    SELECT window_id FROM pg_timelines
    WHERE symbol = $1 AND schema_version = $2
  `, [symbol, CURRENT_SCHEMA_VERSION]);
  return new Set(rows.map(r => r.window_id));
}

export async function getLatestPgWindowTime(symbol) {
  const row = await persistence.get(`
    SELECT MAX(window_close_time) as latest
    FROM pg_timelines
    WHERE symbol = $1 AND schema_version = $2
  `, [symbol, CURRENT_SCHEMA_VERSION]);
  return row?.latest || null;
}

/**
 * Get summary statistics for the PG cache.
 *
 * @returns {Promise<Object[]>}
 */
export async function getPgCacheSummary() {
  return persistence.all(`
    SELECT
      symbol,
      COUNT(*) as total_windows,
      MIN(window_close_time) as earliest,
      MAX(window_close_time) as latest,
      AVG(event_count) as avg_event_count,
      SUM(CASE WHEN ground_truth IS NOT NULL THEN 1 ELSE 0 END) as with_ground_truth,
      schema_version
    FROM pg_timelines
    GROUP BY symbol, schema_version
    ORDER BY symbol
  `);
}

/**
 * Get current schema version.
 */
export function getCurrentSchemaVersion() {
  return CURRENT_SCHEMA_VERSION;
}
