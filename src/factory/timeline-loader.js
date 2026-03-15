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
