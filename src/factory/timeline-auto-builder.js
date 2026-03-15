/**
 * Timeline Auto-Builder
 *
 * Automatically builds and caches a timeline in pg_timelines when a window
 * resolves. Called by the window-close-event-recorder after resolution is
 * confirmed (onchain or self-resolved).
 *
 * Design:
 *   - Waits 5 seconds after being called to let final ticks settle
 *     (the T+65s on-chain wait is already handled upstream)
 *   - Reuses timeline-builder pipeline (loadWindowTickData, mergeTimeline, etc.)
 *   - Writes to pg_timelines with ON CONFLICT DO NOTHING (race-safe)
 *   - Never throws — logs errors but does not crash the main process
 *
 * Integration Point:
 *   Wire this into the window-close-event-recorder module at two places:
 *
 *   1. In persistWindowCloseEvent() — after the self-resolved direction is
 *      persisted, call onWindowResolved() with the capture data. This gives
 *      an immediate timeline build with the self-resolved ground truth.
 *
 *   2. In attemptOnchainResolutionCheck() — after the on-chain direction is
 *      confirmed and persisted, call onWindowResolved() again. The ON CONFLICT
 *      DO NOTHING means the second call is a no-op if the first already wrote.
 *
 *   Example integration in window-close-event-recorder/index.js:
 *
 *     import { onWindowResolved } from '../../factory/timeline-auto-builder.js';
 *
 *     // In persistWindowCloseEvent(), after the INSERT:
 *     onWindowResolved({
 *       symbol: capture.symbol,
 *       window_close_time: new Date(capture.closeTimeMs).toISOString(),
 *       strike_price: capture.strikePrice,
 *       oracle_price_at_open: capture.oracleOpenPrice,
 *       chainlink_price_at_close: capture.oraclePrices.close,
 *       resolved_direction: capture.resolvedDirection,
 *       onchain_resolved_direction: capture.onchainResolvedDirection,
 *     });
 *
 * @module factory/timeline-auto-builder
 */

import { pack } from 'msgpackr';
import persistence from '../persistence/index.js';

// ── Constants ─────────────────────────────────────────────────────────

const WINDOW_DURATION_MS = 15 * 60 * 1000;
const SETTLE_DELAY_MS = 5000;
const LOG_PREFIX = '[timeline-auto-builder]';

// ── Utilities (duplicated to avoid circular deps with timeline-builder) ──

function toISOString(ts) {
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string') return ts;
  return new Date(ts).toISOString();
}

function makeWindowId(symbol, closeTime) {
  return `${symbol}-${toISOString(closeTime)}`;
}

// ── Ground Truth Resolution ───────────────────────────────────────────

function resolveGroundTruth(windowEvent) {
  return (
    windowEvent.gamma_resolved_direction ||
    windowEvent.onchain_resolved_direction ||
    windowEvent.resolved_direction ||
    null
  );
}

// ── Timeline Merge (same logic as timeline-builder.js) ────────────────

function mergeTimeline({ rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks, openMs, closeMs }) {
  const events = [];

  for (const tick of rtdsTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    const source = tick.topic === 'crypto_prices_chainlink' ? 'chainlink' : 'polyRef';
    events.push({ source, timestamp: ts, price: parseFloat(tick.price), _ms: ms });
  }

  for (const snap of clobSnapshots) {
    const ts = toISOString(snap.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    const mid = parseFloat(snap.mid_price || 0);
    if (mid < 0.05 || mid > 0.95) continue;
    events.push({
      source, timestamp: ts,
      best_bid: parseFloat(snap.best_bid), best_ask: parseFloat(snap.best_ask),
      mid_price: parseFloat(snap.mid_price), spread: parseFloat(snap.spread),
      bid_size_top: parseFloat(snap.bid_size_top || 0), ask_size_top: parseFloat(snap.ask_size_top || 0),
      _ms: ms,
    });
  }

  for (const tick of exchangeTicks) {
    const ts = toISOString(tick.timestamp);
    const ms = new Date(ts).getTime();
    if (ms < openMs || ms >= closeMs) continue;
    events.push({
      source: `exchange_${tick.exchange}`, timestamp: ts,
      price: parseFloat(tick.price),
      bid: tick.bid != null ? parseFloat(tick.bid) : null,
      ask: tick.ask != null ? parseFloat(tick.ask) : null,
      _ms: ms,
    });
  }

  if (l2BookTicks) {
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
        source, timestamp: ts,
        best_bid: parseFloat(tick.best_bid), best_ask: parseFloat(tick.best_ask),
        mid_price: parseFloat(tick.mid_price), spread: parseFloat(tick.spread || 0),
        bid_depth_1pct: parseFloat(tick.bid_depth_1pct || 0), ask_depth_1pct: parseFloat(tick.ask_depth_1pct || 0),
        top_levels: tick.top_levels || null,
        _ms: ms,
      });
    }
  }

  if (coingeckoTicks) {
    for (const tick of coingeckoTicks) {
      const ts = toISOString(tick.timestamp);
      const ms = new Date(ts).getTime();
      if (ms < openMs || ms >= closeMs) continue;
      events.push({ source: 'coingecko', timestamp: ts, price: parseFloat(tick.price), _ms: ms });
    }
  }

  events.sort((a, b) => a._ms - b._ms);
  return events;
}

// ── Validation (simplified) ───────────────────────────────────────────

function validateWindow({ timeline, rtdsCount, clobCount, exchangeCount, l2Count, coingeckoCount = 0 }) {
  const flags = [];
  if (timeline.length < 10) {
    flags.push({ type: 'incomplete', message: `Only ${timeline.length} events` });
  }
  return {
    rtds_count: rtdsCount,
    clob_count: clobCount,
    exchange_count: exchangeCount,
    l2_count: l2Count,
    coingecko_count: coingeckoCount,
    event_count: timeline.length,
    flags,
  };
}

// ── Tick Data Loading ─────────────────────────────────────────────────

async function loadWindowTickData(symbol, openTime, closeTime) {
  const [rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks] = await Promise.all([
    persistence.all(`
      SELECT timestamp, topic, symbol, price, received_at
      FROM rtds_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
      ORDER BY timestamp ASC
    `, [openTime, closeTime]),

    persistence.all(`
      SELECT timestamp, symbol, token_id, best_bid, best_ask,
             mid_price, spread, bid_size_top, ask_size_top, window_epoch
      FROM clob_price_snapshots
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, `${symbol.toLowerCase()}%`]),

    persistence.all(`
      SELECT timestamp, exchange, symbol, price, bid, ask
      FROM exchange_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, symbol.toLowerCase()]),

    persistence.all(`
      SELECT timestamp, token_id, symbol, event_type,
             best_bid, best_ask, mid_price, spread,
             bid_depth_1pct, ask_depth_1pct, top_levels
      FROM l2_book_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol LIKE $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, `${symbol.toLowerCase()}%`]).catch(() => []),

    persistence.all(`
      SELECT timestamp, symbol, price
      FROM coingecko_ticks
      WHERE timestamp >= $1 AND timestamp <= $2
        AND symbol = $3
      ORDER BY timestamp ASC
    `, [openTime, closeTime, symbol.toLowerCase()]).catch(() => []),
  ]);

  return { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks };
}

// ── PG Write ──────────────────────────────────────────────────────────

async function writeToPgTimelines(row) {
  await persistence.run(`
    INSERT INTO pg_timelines (window_id, symbol, window_close_time, window_open_time, ground_truth, strike_price, oracle_price_at_open, chainlink_price_at_close, timeline, event_count, data_quality, schema_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
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
    row.data_quality,
  ]);
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Called when a window resolves. Builds and caches the timeline.
 *
 * This function never throws. Errors are logged but swallowed to avoid
 * crashing the main trading process.
 *
 * @param {Object} windowEvent - The resolved window event
 * @param {string} windowEvent.symbol - Symbol (e.g., 'btc')
 * @param {string} windowEvent.window_close_time - ISO timestamp of window close
 * @param {number|null} windowEvent.strike_price
 * @param {number|null} windowEvent.oracle_price_at_open
 * @param {number|null} windowEvent.chainlink_price_at_close
 * @param {string|null} windowEvent.resolved_direction - 'up' or 'down'
 * @param {string|null} [windowEvent.onchain_resolved_direction]
 * @param {string|null} [windowEvent.gamma_resolved_direction]
 */
export async function onWindowResolved(windowEvent) {
  try {
    const groundTruth = resolveGroundTruth(windowEvent);
    if (!groundTruth) {
      console.log(`${LOG_PREFIX} Skipping — no ground truth for ${windowEvent.symbol} ${windowEvent.window_close_time}`);
      return;
    }

    const closeTime = toISOString(windowEvent.window_close_time);
    const windowId = makeWindowId(windowEvent.symbol, closeTime);

    console.log(`${LOG_PREFIX} Window resolved: ${windowId} (${groundTruth}). Waiting ${SETTLE_DELAY_MS}ms for ticks to settle...`);

    // Wait for ticks to settle
    await new Promise(resolve => setTimeout(resolve, SETTLE_DELAY_MS));

    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - WINDOW_DURATION_MS;
    const openTime = new Date(openMs).toISOString();

    // Load tick data
    const { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks } =
      await loadWindowTickData(windowEvent.symbol, openTime, closeTime);

    // Build timeline
    const timeline = mergeTimeline({
      rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks, coingeckoTicks,
      openMs, closeMs,
    });

    if (timeline.length === 0) {
      console.log(`${LOG_PREFIX} Skipping ${windowId} — 0 events in timeline`);
      return;
    }

    // Validate
    const quality = validateWindow({
      timeline,
      rtdsCount: rtdsTicks.length,
      clobCount: clobSnapshots.length,
      exchangeCount: exchangeTicks.length,
      l2Count: l2BookTicks.length,
      coingeckoCount: coingeckoTicks.length,
    });

    // Serialize
    const blob = pack(timeline);

    // Write
    const row = {
      window_id: windowId,
      symbol: windowEvent.symbol,
      window_close_time: closeTime,
      window_open_time: openTime,
      ground_truth: groundTruth,
      strike_price: windowEvent.strike_price != null ? parseFloat(windowEvent.strike_price) : null,
      oracle_price_at_open: windowEvent.oracle_price_at_open != null ? parseFloat(windowEvent.oracle_price_at_open) : null,
      chainlink_price_at_close: windowEvent.chainlink_price_at_close != null ? parseFloat(windowEvent.chainlink_price_at_close) : null,
      timeline: blob,
      event_count: timeline.length,
      data_quality: JSON.stringify(quality),
    };

    await writeToPgTimelines(row);

    console.log(`${LOG_PREFIX} Cached ${windowId}: ${timeline.length} events, ground truth: ${groundTruth}`);
  } catch (err) {
    // Never throw — just log
    console.error(`${LOG_PREFIX} Failed to auto-build timeline for ${windowEvent?.symbol} ${windowEvent?.window_close_time}: ${err.message}`);
  }
}

// Export internals for testing
export const _testing = {
  makeWindowId,
  resolveGroundTruth,
  mergeTimeline,
  validateWindow,
  writeToPgTimelines,
  loadWindowTickData,
  SETTLE_DELAY_MS,
};
