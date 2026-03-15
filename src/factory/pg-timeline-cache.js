/**
 * PG Timeline Cache — High-Level API
 *
 * Wraps pg-timeline-store.js with batch-read and stats capabilities
 * for the pg-cache backtest path. Provides:
 *   - ensurePgCacheTable() — idempotent table creation
 *   - writePgTimeline() — upsert a single timeline
 *   - readPgTimeline() — read single, deserialize msgpack
 *   - readPgTimelines() — batch read (the key performance function)
 *   - listPgWindows() — metadata only, no blob
 *   - getPgCacheStats() — count, date range, coverage per symbol
 */

import { unpack, pack } from 'msgpackr';
import persistence from '../persistence/index.js';
import {
  ensurePgTimelineTable,
  insertPgTimeline,
  getPgTimeline,
  getPgWindowsForSymbol,
  getPgCacheSummary,
} from './pg-timeline-store.js';

// ─── Re-exports (delegate to existing store) ───

export { ensurePgTimelineTable as ensurePgCacheTable };

/**
 * Write a single timeline to the PG cache.
 * Serializes timeline array with MessagePack before storage.
 *
 * @param {Object} windowData
 * @param {Object[]} windowData.timeline - Array of timeline events to serialize
 */
export async function writePgTimeline(windowData) {
  const timelineBuffer = Buffer.from(pack(windowData.timeline));
  await insertPgTimeline({
    ...windowData,
    timeline: timelineBuffer,
    event_count: windowData.timeline.length,
    data_quality: windowData.data_quality
      ? (typeof windowData.data_quality === 'string'
        ? windowData.data_quality
        : JSON.stringify(windowData.data_quality))
      : null,
  });
}

// ─── Read (Single) ───

/**
 * Read a single timeline from the PG cache.
 * Deserializes MessagePack BYTEA blob back into an array of events.
 *
 * @param {string} windowId
 * @returns {Promise<{ timeline: Object[], meta: Object } | null>}
 */
export async function readPgTimeline(windowId) {
  const row = await getPgTimeline(windowId);
  if (!row) return null;
  return deserializeRow(row);
}

// ─── Read (Batch) — the key performance function ───

/**
 * Batch-read multiple timelines from PG cache.
 * Single query with ANY($1) for efficiency — avoids N+1 queries.
 *
 * @param {string[]} windowIds - Array of window IDs to read
 * @returns {Promise<Map<string, { timeline: Object[], meta: Object }>>}
 */
export async function readPgTimelines(windowIds) {
  if (windowIds.length === 0) return new Map();

  const rows = await persistence.all(
    `SELECT * FROM pg_timelines WHERE window_id = ANY($1) AND schema_version = 2`,
    [windowIds]
  );

  const result = new Map();
  for (const row of rows) {
    result.set(row.window_id, deserializeRow(row));
  }
  return result;
}

// ─── List (Metadata Only) ───

/**
 * List cached windows for a symbol. Returns metadata only — no timeline blob.
 * Delegates to pg-timeline-store's getPgWindowsForSymbol.
 *
 * @param {string} symbol - e.g. 'btc'
 * @param {Object} [options]
 * @param {string} [options.startDate]
 * @param {string} [options.endDate]
 * @param {number} [options.limit]
 * @returns {Promise<Object[]>}
 */
export async function listPgWindows(symbol, options = {}) {
  return getPgWindowsForSymbol(symbol, options);
}

// ─── Cache Stats ───

/**
 * Get summary statistics for the PG timeline cache.
 *
 * @returns {Promise<Object>} { totalWindows, dateRange, coverageBySymbol }
 */
export async function getPgCacheStats() {
  const summary = await getPgCacheSummary();

  let totalWindows = 0;
  let earliest = null;
  let latest = null;
  const coverageBySymbol = {};

  for (const row of summary) {
    const count = Number(row.total_windows);
    totalWindows += count;

    if (!earliest || row.earliest < earliest) earliest = row.earliest;
    if (!latest || row.latest > latest) latest = row.latest;

    coverageBySymbol[row.symbol] = {
      windowCount: count,
      earliest: row.earliest,
      latest: row.latest,
      avgEventCount: Number(row.avg_event_count || 0),
      withGroundTruth: Number(row.with_ground_truth || 0),
    };
  }

  return {
    totalWindows,
    dateRange: { earliest, latest },
    coverageBySymbol,
  };
}

// ─── Internal Helpers ───

/**
 * Deserialize a PG row into { timeline, meta }.
 * @param {Object} row - Raw PG row
 * @returns {{ timeline: Object[], meta: Object }}
 */
function deserializeRow(row) {
  const timeline = unpack(row.timeline);

  const meta = {
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
    data_quality: row.data_quality,
    schema_version: row.schema_version,
  };

  return { timeline, meta };
}
