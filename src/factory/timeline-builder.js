/**
 * Timeline Builder — Core Pipeline
 *
 * Builds pre-computed timelines from PostgreSQL raw tables:
 *   PG window_close_events → per-window tick queries → merge → validate → serialize → SQLite
 *
 * Events are tagged by source and shaped to match MarketState.processEvent() exactly:
 *   - chainlink/polyRef: { source, timestamp, price, _ms }
 *   - clobUp/clobDown: { source, timestamp, best_bid, best_ask, mid_price, spread, bid_size_top, ask_size_top, _ms }
 *   - exchange_*: { source, timestamp, price, bid, ask, _ms }
 *   - l2Up/l2Down: { source, timestamp, best_bid, best_ask, mid_price, spread, bid_depth_1pct, ask_depth_1pct, top_levels, _ms }
 *   - coingecko: { source, timestamp, price, _ms }
 */

import { pack } from 'msgpackr';
import persistence from '../persistence/index.js';
import {
  insertTimelines,
  getLatestWindowTime,
  deleteSymbolTimelines,
  getExistingWindowIds,
  getDb,
} from './timeline-store.js';
import { validateWindow } from './timeline-validator.js';

// Window duration: 15 minutes
const WINDOW_DURATION_MS = 15 * 60 * 1000;

/**
 * Build timelines for a symbol (or all symbols).
 *
 * @param {Object} options
 * @param {string} options.symbol - Symbol to build ("btc", "eth", "all")
 * @param {boolean} [options.rebuild=false] - Force full rebuild
 * @param {boolean} [options.incremental=true] - Only build new windows
 * @param {Function} [options.onProgress] - Progress callback({ symbol, processed, total, inserted, skipped })
 * @returns {Promise<Object>} Build report
 */
export async function buildTimelines(options) {
  const { symbol, rebuild = false, incremental = true, onProgress } = options;

  if (symbol === 'all') {
    return buildAllSymbols(options);
  }

  return buildSymbolTimelines({ symbol, rebuild, incremental, onProgress });
}

/**
 * Build timelines for all supported symbols.
 */
async function buildAllSymbols(options) {
  const symbols = await getAvailableSymbols();
  const reports = {};

  for (const sym of symbols) {
    reports[sym] = await buildSymbolTimelines({
      ...options,
      symbol: sym,
    });
  }

  return { symbols: reports, totalSymbols: symbols.length };
}

/**
 * Get available symbols from window_close_events.
 */
async function getAvailableSymbols() {
  const rows = await persistence.all(
    'SELECT DISTINCT symbol FROM window_close_events ORDER BY symbol'
  );
  return rows.map(r => r.symbol);
}

/**
 * Core pipeline: build timelines for a single symbol.
 */
async function buildSymbolTimelines({ symbol, rebuild, incremental, onProgress }) {
  const startTime = Date.now();

  // Handle rebuild: drop existing timelines for this symbol
  if (rebuild) {
    const deleted = deleteSymbolTimelines(symbol);
    console.log(`[timeline-builder] Rebuilt: deleted ${deleted} existing windows for ${symbol}`);
  }

  // Get windows from PostgreSQL
  let afterTime = null;
  if (incremental && !rebuild) {
    afterTime = getLatestWindowTime(symbol);
    if (afterTime) {
      console.log(`[timeline-builder] Incremental: building windows after ${afterTime} for ${symbol}`);
    }
  }

  const windows = await loadWindowsFromPg(symbol, afterTime);

  // Filter out windows already in cache (for safety)
  const existingIds = rebuild ? new Set() : getExistingWindowIds(symbol);
  const newWindows = windows.filter(w => {
    const windowId = makeWindowId(symbol, w.window_close_time);
    return !existingIds.has(windowId);
  });

  const report = {
    symbol,
    totalWindowsInPg: windows.length,
    alreadyCached: windows.length - newWindows.length,
    processed: 0,
    inserted: 0,
    skippedNoGroundTruth: 0,
    skippedNoEvents: 0,
    elapsedMs: 0,
    errors: [],
  };

  if (newWindows.length === 0) {
    report.elapsedMs = Date.now() - startTime;
    console.log(`[timeline-builder] ${symbol}: no new windows to build`);
    return report;
  }

  console.log(`[timeline-builder] ${symbol}: building ${newWindows.length} windows...`);

  // Process windows in batches to manage memory
  const BATCH_SIZE = 50;
  const batch = [];

  for (let i = 0; i < newWindows.length; i++) {
    const win = newWindows[i];
    report.processed++;

    try {
      const row = await buildSingleWindow(symbol, win);

      if (row === null) {
        report.skippedNoGroundTruth++;
        continue;
      }

      if (row.event_count === 0) {
        report.skippedNoEvents++;
        continue;
      }

      batch.push(row);

      // Flush batch
      if (batch.length >= BATCH_SIZE) {
        insertTimelines(batch);
        report.inserted += batch.length;
        batch.length = 0;
      }

      if (onProgress) {
        onProgress({
          symbol,
          processed: report.processed,
          total: newWindows.length,
          inserted: report.inserted,
          skipped: report.skippedNoGroundTruth + report.skippedNoEvents,
        });
      }
    } catch (err) {
      report.errors.push({
        windowId: makeWindowId(symbol, win.window_close_time),
        error: err.message,
      });
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    insertTimelines(batch);
    report.inserted += batch.length;
  }

  report.elapsedMs = Date.now() - startTime;
  console.log(
    `[timeline-builder] ${symbol}: done. ` +
    `Inserted ${report.inserted}, skipped ${report.skippedNoGroundTruth} (no truth) + ${report.skippedNoEvents} (no events). ` +
    `Took ${(report.elapsedMs / 1000).toFixed(1)}s`
  );

  return report;
}

/**
 * Load window close events from PostgreSQL.
 *
 * @param {string} symbol
 * @param {string|null} afterTime - Only load windows after this time (incremental)
 * @returns {Promise<Object[]>}
 */
async function loadWindowsFromPg(symbol, afterTime) {
  let sql = `
    SELECT window_close_time, symbol, strike_price,
           chainlink_price_at_close, oracle_price_at_open,
           resolved_direction, onchain_resolved_direction
    FROM window_close_events
    WHERE symbol = $1
  `;
  const params = [symbol];

  // Check for gamma column
  try {
    const colCheck = await persistence.get(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'window_close_events' AND column_name = 'gamma_resolved_direction'
    `);
    if (colCheck) {
      sql = sql.replace('onchain_resolved_direction', 'onchain_resolved_direction, gamma_resolved_direction');
    }
  } catch { /* ignore */ }

  if (afterTime) {
    sql += ` AND window_close_time > $2`;
    params.push(afterTime);
  }

  sql += ' ORDER BY window_close_time ASC';

  return persistence.all(sql, params);
}

/**
 * Build a single window's timeline.
 * Returns a row ready for SQLite insertion, or null if no ground truth.
 */
async function buildSingleWindow(symbol, windowEvent) {
  // Determine ground truth
  const groundTruth = resolveGroundTruth(windowEvent);
  if (!groundTruth) {
    return null; // Skip windows without ground truth
  }

  const closeTime = toISOString(windowEvent.window_close_time);
  const closeMs = new Date(closeTime).getTime();
  const openMs = closeMs - WINDOW_DURATION_MS;
  const openTime = new Date(openMs).toISOString();
  const windowId = makeWindowId(symbol, closeTime);

  // Load tick data from PostgreSQL
  const { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks } =
    await loadWindowTickData(symbol, openTime, closeTime, closeMs);

  // Build merged timeline with proper source tags
  const timeline = mergeTimeline({
    rtdsTicks,
    clobSnapshots,
    exchangeTicks,
    l2BookTicks,
    coingeckoTicks,
    openMs,
    closeMs,
  });

  // Validate and compute quality metadata
  const quality = validateWindow({
    timeline,
    rtdsCount: rtdsTicks.length,
    clobCount: clobSnapshots.length,
    exchangeCount: exchangeTicks.length,
    l2Count: l2BookTicks.length,
    coingeckoCount: coingeckoTicks.length,
    openMs,
    closeMs,
    symbol,
  });

  // Serialize timeline with MessagePack
  const blob = pack(timeline);

  return {
    window_id: windowId,
    symbol,
    window_close_time: closeTime,
    window_open_time: openTime,
    ground_truth: groundTruth,
    strike_price: windowEvent.strike_price != null ? parseFloat(windowEvent.strike_price) : null,
    oracle_price_at_open: windowEvent.oracle_price_at_open != null ? parseFloat(windowEvent.oracle_price_at_open) : null,
    chainlink_price_at_close: windowEvent.chainlink_price_at_close != null ? parseFloat(windowEvent.chainlink_price_at_close) : null,
    timeline: blob,
    event_count: timeline.length,
    data_quality: JSON.stringify(quality),
    built_at: new Date().toISOString(),
  };
}

/**
 * Resolve ground truth direction from window event.
 * Priority: gamma_resolved_direction > onchain_resolved_direction > resolved_direction
 *
 * @returns {string|null} 'UP' or 'DOWN', or null if no ground truth
 */
function resolveGroundTruth(windowEvent) {
  return (
    windowEvent.gamma_resolved_direction ||
    windowEvent.onchain_resolved_direction ||
    windowEvent.resolved_direction ||
    null
  );
}

/**
 * Load all tick data for a single window from PostgreSQL.
 */
async function loadWindowTickData(symbol, openTime, closeTime, closeMs) {
  const windowEpoch = Math.floor(closeMs / 1000);

  const [rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks] = await Promise.all([
    // Oracle ticks (chainlink + polyRef)
    persistence.all(`
      SELECT timestamp, topic, symbol, price, received_at
      FROM rtds_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
      ORDER BY timestamp ASC
    `, [openTime, closeTime]),

    // CLOB snapshots for this window
    persistence.all(`
      SELECT timestamp, symbol, token_id, best_bid, best_ask,
             mid_price, spread, bid_size_top, ask_size_top, window_epoch
      FROM clob_price_snapshots
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, `${symbol.toLowerCase()}%`]),

    // Exchange ticks
    persistence.all(`
      SELECT timestamp, exchange, symbol, price, bid, ask
      FROM exchange_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, symbol.toLowerCase()]),

    // L2 book ticks (may not exist)
    loadL2Ticks(symbol, openTime, closeTime).catch(() => []),

    // CoinGecko ticks (may not exist)
    loadCoingeckoTicks(symbol, openTime, closeTime).catch(() => []),
  ]);

  return { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks };
}

/**
 * Load L2 book ticks, handling missing table gracefully.
 */
async function loadL2Ticks(symbol, openTime, closeTime) {
  try {
    return await persistence.all(`
      SELECT timestamp, token_id, symbol, event_type,
             best_bid, best_ask, mid_price, spread,
             bid_depth_1pct, ask_depth_1pct, top_levels
      FROM l2_book_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, `${symbol.toLowerCase()}%`]);
  } catch {
    return [];
  }
}

/**
 * Load CoinGecko ticks, handling missing table gracefully.
 */
async function loadCoingeckoTicks(symbol, openTime, closeTime) {
  try {
    return await persistence.all(`
      SELECT timestamp, symbol, price
      FROM coingecko_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, symbol.toLowerCase()]);
  } catch {
    return [];
  }
}

/**
 * Merge all tick sources into a single sorted timeline.
 * Events are tagged with source and shaped for MarketState.processEvent().
 *
 * _ms field is pre-computed to avoid repeated Date parsing in the backtester.
 */
export function mergeTimeline({ rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks, openMs, closeMs }) {
  const events = [];

  // RTDS ticks → chainlink or polyRef
  for (const tick of rtdsTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue; // bounds check

    const source = tick.topic === 'crypto_prices_chainlink' ? 'chainlink' : 'polyRef';
    events.push({
      source,
      timestamp: ts,
      price: parseFloat(tick.price),
      _ms: ms,
    });
  }

  // CLOB snapshots → clobUp or clobDown
  for (const snap of clobSnapshots) {
    const ts = toISOString(snap.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;

    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';

    // Filter out stale CLOB data (mid outside tradeable range)
    const mid = parseFloat(snap.mid_price || 0);
    if (mid < 0.05 || mid > 0.95) continue;

    events.push({
      source,
      timestamp: ts,
      best_bid: parseFloat(snap.best_bid),
      best_ask: parseFloat(snap.best_ask),
      mid_price: parseFloat(snap.mid_price),
      spread: parseFloat(snap.spread),
      bid_size_top: parseFloat(snap.bid_size_top || 0),
      ask_size_top: parseFloat(snap.ask_size_top || 0),
      _ms: ms,
    });
  }

  // Exchange ticks
  for (const tick of exchangeTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;

    events.push({
      source: `exchange_${tick.exchange}`,
      timestamp: ts,
      price: parseFloat(tick.price),
      bid: tick.bid != null ? parseFloat(tick.bid) : null,
      ask: tick.ask != null ? parseFloat(tick.ask) : null,
      _ms: ms,
    });
  }

  // L2 book ticks → l2Up or l2Down
  if (l2BookTicks) {
    // Build token_id → direction map from CLOB snapshots
    const tokenDirMap = new Map();
    for (const snap of clobSnapshots) {
      if (snap.token_id && !tokenDirMap.has(snap.token_id)) {
        tokenDirMap.set(snap.token_id, snap.symbol?.toLowerCase().includes('down') ? 'down' : 'up');
      }
    }

    for (const tick of l2BookTicks) {
      const ts = toISOString(tick.timestamp);
      const ms = new Date(ts).getTime();
      if (ms < openMs || ms >= closeMs) continue;

      const direction = tokenDirMap.get(tick.token_id) ||
        (tick.symbol?.toLowerCase().includes('down') ? 'down' : 'up');
      const source = direction === 'down' ? 'l2Down' : 'l2Up';

      events.push({
        source,
        timestamp: ts,
        best_bid: parseFloat(tick.best_bid),
        best_ask: parseFloat(tick.best_ask),
        mid_price: parseFloat(tick.mid_price),
        spread: parseFloat(tick.spread || 0),
        bid_depth_1pct: parseFloat(tick.bid_depth_1pct || 0),
        ask_depth_1pct: parseFloat(tick.ask_depth_1pct || 0),
        top_levels: tick.top_levels || null,
        _ms: ms,
      });
    }
  }

  // CoinGecko ticks
  if (coingeckoTicks) {
    for (const tick of coingeckoTicks) {
      const ts = toISOString(tick.timestamp);
      const ms = new Date(ts).getTime();
      if (ms < openMs || ms >= closeMs) continue;

      events.push({
        source: 'coingecko',
        timestamp: ts,
        price: parseFloat(tick.price),
        _ms: ms,
      });
    }
  }

  // Sort by _ms (stable sort preserving insertion order for same-ms events)
  events.sort((a, b) => a._ms - b._ms);

  return events;
}

/**
 * Generate a deterministic window ID.
 */
export function makeWindowId(symbol, closeTime) {
  const iso = toISOString(closeTime);
  return `${symbol}-${iso}`;
}

/**
 * Convert various timestamp formats to ISO string.
 */
function toISOString(ts) {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string') return ts;
  return new Date(ts).toISOString();
}
