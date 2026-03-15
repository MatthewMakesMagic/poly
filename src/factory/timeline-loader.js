/**
 * Timeline Loader
 *
 * Loads pre-computed timelines from the SQLite cache.
 * Deserializes MessagePack blobs into event arrays that MarketState can process.
 *
 * This is the read-path counterpart to timeline-store.js (write-path).
 * The turbo backtester uses this instead of querying PostgreSQL.
 */

import { unpack } from 'msgpackr';
import { getDb, getWindowsForSymbol as storeGetWindows } from './timeline-store.js';
import { getPgTimeline, getPgWindowsForSymbol } from './pg-timeline-store.js';

/**
 * Load a single timeline by window ID.
 * Returns the window metadata + deserialized event array + quality info.
 *
 * @param {string} windowId - e.g., "btc-2026-03-01T12:15:00Z"
 * @returns {{ window: Object, timeline: Object[], quality: Object|null } | null}
 *   - window: { window_id, symbol, window_close_time, window_open_time, ground_truth, strike_price, ... }
 *   - timeline: sorted array of events matching MarketState.processEvent() schema
 *   - quality: parsed data_quality JSON or null
 */
export function loadTimeline(windowId) {
  const database = getDb();
  const row = database.prepare('SELECT * FROM timelines WHERE window_id = ?').get(windowId);

  if (!row) return null;

  const timeline = unpack(row.timeline);

  const quality = row.data_quality ? JSON.parse(row.data_quality) : null;

  const window = {
    window_id: row.window_id,
    symbol: row.symbol,
    window_close_time: row.window_close_time,
    window_open_time: row.window_open_time,
    ground_truth: row.ground_truth,
    strike_price: row.strike_price,
    oracle_price_at_open: row.oracle_price_at_open,
    chainlink_price_at_close: row.chainlink_price_at_close,
    event_count: row.event_count,
    built_at: row.built_at,
  };

  return { window, timeline, quality };
}

/**
 * Load window metadata for a symbol (without timeline blobs).
 * Used for sampling — pick windows first, then load full timelines for selected ones.
 *
 * @param {string} symbol - e.g., "btc"
 * @param {Object} [options]
 * @param {string} [options.startDate] - Filter: earliest window_close_time
 * @param {string} [options.endDate] - Filter: latest window_close_time
 * @returns {Object[]} Array of window metadata objects (no timeline field)
 */
export function loadWindowsForSymbol(symbol, options = {}) {
  return storeGetWindows(symbol, options);
}

/**
 * Load multiple timelines by window IDs.
 * Efficient batch loading for backtest runs.
 *
 * @param {string[]} windowIds
 * @returns {Map<string, { window: Object, timeline: Object[], quality: Object|null }>}
 */
export function loadTimelines(windowIds) {
  const results = new Map();
  const database = getDb();

  // Use a prepared statement for repeated lookups
  const stmt = database.prepare('SELECT * FROM timelines WHERE window_id = ?');

  for (const windowId of windowIds) {
    const row = stmt.get(windowId);
    if (!row) continue;

    const timeline = unpack(row.timeline);
    const quality = row.data_quality ? JSON.parse(row.data_quality) : null;

    results.set(windowId, {
      window: {
        window_id: row.window_id,
        symbol: row.symbol,
        window_close_time: row.window_close_time,
        window_open_time: row.window_open_time,
        ground_truth: row.ground_truth,
        strike_price: row.strike_price,
        oracle_price_at_open: row.oracle_price_at_open,
        chainlink_price_at_close: row.chainlink_price_at_close,
        event_count: row.event_count,
        built_at: row.built_at,
      },
      timeline,
      quality,
    });
  }

  return results;
}

// ─── PG Timeline Cache Read Path ───

/**
 * Load a single timeline from PG cache by window ID.
 * Returns the same shape as loadTimeline() for drop-in compatibility.
 *
 * @param {string} windowId
 * @returns {Promise<{ window: Object, timeline: Object[], quality: Object|null, source: string } | null>}
 */
export async function loadTimelinePg(windowId) {
  const row = await getPgTimeline(windowId);
  if (!row) return null;

  // PG returns timeline as Buffer (BYTEA) — unpack with MessagePack
  const timeline = unpack(row.timeline);
  const quality = row.data_quality || null;

  const window = {
    window_id: row.window_id,
    symbol: row.symbol,
    window_close_time: row.window_close_time instanceof Date
      ? row.window_close_time.toISOString()
      : row.window_close_time,
    window_open_time: row.window_open_time instanceof Date
      ? row.window_open_time.toISOString()
      : row.window_open_time,
    ground_truth: row.ground_truth,
    strike_price: row.strike_price,
    oracle_price_at_open: row.oracle_price_at_open,
    chainlink_price_at_close: row.chainlink_price_at_close,
    event_count: row.event_count,
    built_at: row.built_at,
  };

  return { window, timeline, quality, source: 'pg_cache' };
}

/**
 * Load window metadata for a symbol from PG cache.
 * Same interface as loadWindowsForSymbol but reads from pg_timelines.
 *
 * @param {string} symbol
 * @param {Object} [options]
 * @returns {Promise<Object[]>}
 */
export async function loadWindowsForSymbolPg(symbol, options = {}) {
  const rows = await getPgWindowsForSymbol(symbol, options);
  // Normalize timestamps to ISO strings
  return rows.map(r => ({
    ...r,
    window_close_time: r.window_close_time instanceof Date
      ? r.window_close_time.toISOString()
      : r.window_close_time,
    window_open_time: r.window_open_time instanceof Date
      ? r.window_open_time.toISOString()
      : r.window_open_time,
  }));
}
