/**
 * Feed Monitor Module
 *
 * Tracks the last tick timestamp for each feed+symbol pair and detects
 * gaps (>5s of silence). When a gap is detected, an open row is inserted
 * into the feed_gaps table. When the feed resumes, the row is closed
 * with gap_end and duration_seconds.
 *
 * Feeds monitored:
 * - RTDS: crypto_prices, crypto_prices_chainlink (per symbol)
 * - Exchange: binance, coinbaseexchange, kraken, bybit, okx (per symbol)
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/feed-monitor
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';

// Module state
let log = null;
let initialized = false;
let config = null;
let checkIntervalId = null;
let unsubscribers = [];

// Per-feed-symbol tracking: Map<"feed:symbol", { lastTickAt, inGap, gapId }>
const feedState = new Map();

// Exchanges we track
const EXCHANGES = ['binance', 'coinbaseexchange', 'kraken', 'bybit', 'okx'];

// RTDS feed topics
const RTDS_FEEDS = ['crypto_prices', 'crypto_prices_chainlink'];

const DEFAULT_CONFIG = {
  gapThresholdMs: 5000,     // 5s silence = gap
  checkIntervalMs: 2000,    // Check every 2s
  exchangePollMs: 10000,    // Poll exchange_ticks table every 10s
};

/**
 * Initialize the feed monitor module.
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.feedMonitor] - Feed monitor configuration
 * @param {number} [cfg.feedMonitor.gapThresholdMs=5000] - Silence threshold to declare a gap
 * @param {number} [cfg.feedMonitor.checkIntervalMs=2000] - How often to check for gaps
 * @param {number} [cfg.feedMonitor.exchangePollMs=10000] - How often to poll exchange_ticks
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'feed-monitor' });
  log.info('module_init_start');

  const feedMonitorCfg = cfg.feedMonitor || {};
  config = {
    gapThresholdMs: feedMonitorCfg.gapThresholdMs ?? DEFAULT_CONFIG.gapThresholdMs,
    checkIntervalMs: feedMonitorCfg.checkIntervalMs ?? DEFAULT_CONFIG.checkIntervalMs,
    exchangePollMs: feedMonitorCfg.exchangePollMs ?? DEFAULT_CONFIG.exchangePollMs,
  };

  // Initialize feed state entries for all known feed+symbol combos
  for (const feed of RTDS_FEEDS) {
    for (const sym of SUPPORTED_SYMBOLS) {
      feedState.set(`${feed}:${sym}`, { lastTickAt: null, inGap: false, gapId: null });
    }
  }
  for (const exchange of EXCHANGES) {
    for (const sym of SUPPORTED_SYMBOLS) {
      feedState.set(`${exchange}:${sym}`, { lastTickAt: null, inGap: false, gapId: null });
    }
  }

  // Subscribe to RTDS for real-time tick timestamps
  for (const sym of SUPPORTED_SYMBOLS) {
    try {
      const unsub = rtdsClient.subscribe(sym, (tick) => {
        if (tick.topic && tick.symbol) {
          recordTick(tick.topic, tick.symbol.toLowerCase());
        }
      });
      unsubscribers.push(unsub);
    } catch (err) {
      log.warn('rtds_subscribe_failed', { symbol: sym, error: err.message });
    }
  }

  // Close any open gaps from a previous run (crashed process)
  await closeStaleGaps();

  // Periodic gap check
  checkIntervalId = setInterval(() => checkAllFeeds(), config.checkIntervalMs);
  if (checkIntervalId.unref) checkIntervalId.unref();

  // Periodic exchange tick poll (exchange data comes from DB, not real-time subscription)
  pollExchangeTicks(); // fire once immediately
  const exchangePollId = setInterval(() => pollExchangeTicks(), config.exchangePollMs);
  if (exchangePollId.unref) exchangePollId.unref();
  unsubscribers.push(() => clearInterval(exchangePollId));

  initialized = true;
  log.info('feed_monitor_initialized', {
    gapThresholdMs: config.gapThresholdMs,
    feeds: feedState.size,
  });
}

/**
 * Record a tick for a feed+symbol pair.
 * Called from subscriptions and from exchange polling.
 *
 * @param {string} feed - Feed name (e.g. 'crypto_prices', 'binance')
 * @param {string} symbol - Normalized symbol (e.g. 'btc')
 */
function recordTick(feed, symbol) {
  const key = `${feed}:${symbol}`;
  let entry = feedState.get(key);
  if (!entry) {
    entry = { lastTickAt: null, inGap: false, gapId: null };
    feedState.set(key, entry);
  }
  entry.lastTickAt = Date.now();
}

/**
 * Check all feeds for gaps. Called periodically.
 */
function checkAllFeeds() {
  const now = Date.now();
  for (const [key, entry] of feedState.entries()) {
    if (!entry.lastTickAt) continue; // Never received a tick, skip

    const age = now - entry.lastTickAt;

    if (age > config.gapThresholdMs && !entry.inGap) {
      // Gap detected - open it
      openGap(key, entry).catch(err => {
        log.error('open_gap_failed', { key, error: err.message });
      });
    } else if (age <= config.gapThresholdMs && entry.inGap) {
      // Feed resumed - close the gap
      closeGap(key, entry).catch(err => {
        log.error('close_gap_failed', { key, error: err.message });
      });
    }
  }
}

/**
 * Open a new gap in the database.
 *
 * @param {string} key - Feed:symbol key
 * @param {Object} entry - Feed state entry
 */
async function openGap(key, entry) {
  const [feed, symbol] = key.split(':');
  entry.inGap = true;

  try {
    const result = await persistence.get(
      `INSERT INTO feed_gaps (feed_name, symbol, gap_start)
       VALUES ($1, $2, NOW())
       RETURNING id`,
      [feed, symbol]
    );
    entry.gapId = result?.id ?? null;
    log.warn('feed_gap_opened', { feed, symbol, gapId: entry.gapId });
  } catch (err) {
    log.error('feed_gap_insert_failed', { feed, symbol, error: err.message });
  }
}

/**
 * Close an existing gap in the database.
 *
 * @param {string} key - Feed:symbol key
 * @param {Object} entry - Feed state entry
 */
async function closeGap(key, entry) {
  const [feed, symbol] = key.split(':');
  entry.inGap = false;

  if (entry.gapId) {
    try {
      await persistence.run(
        `UPDATE feed_gaps
         SET gap_end = NOW(),
             duration_seconds = EXTRACT(EPOCH FROM (NOW() - gap_start))
         WHERE id = $1 AND gap_end IS NULL`,
        [entry.gapId]
      );
      log.info('feed_gap_closed', { feed, symbol, gapId: entry.gapId });
    } catch (err) {
      log.error('feed_gap_update_failed', { feed, symbol, gapId: entry.gapId, error: err.message });
    }
  }

  entry.gapId = null;
}

/**
 * Close any gaps that were left open from a previous process crash.
 * Sets gap_end to NOW() for any rows where gap_end IS NULL.
 */
async function closeStaleGaps() {
  try {
    const result = await persistence.run(
      `UPDATE feed_gaps
       SET gap_end = NOW(),
           duration_seconds = EXTRACT(EPOCH FROM (NOW() - gap_start))
       WHERE gap_end IS NULL`
    );
    if (result?.changes > 0) {
      log.info('closed_stale_gaps', { count: result.changes });
    }
  } catch (err) {
    log.warn('close_stale_gaps_failed', { error: err.message });
  }
}

/**
 * Poll exchange_ticks table for latest tick timestamps per exchange+symbol.
 * Exchange feeds are collected by exchange-feed-collector and written to DB,
 * not directly subscribed via WebSocket here.
 */
async function pollExchangeTicks() {
  try {
    const rows = await persistence.all(`
      SELECT DISTINCT ON (exchange, symbol)
        exchange, symbol, timestamp
      FROM exchange_ticks
      WHERE timestamp > NOW() - INTERVAL '60 seconds'
      ORDER BY exchange, symbol, timestamp DESC
    `);

    for (const row of rows) {
      const sym = row.symbol?.toLowerCase();
      const exchange = row.exchange?.toLowerCase();
      if (sym && exchange) {
        const key = `${exchange}:${sym}`;
        let entry = feedState.get(key);
        if (!entry) {
          entry = { lastTickAt: null, inGap: false, gapId: null };
          feedState.set(key, entry);
        }
        const tickTime = new Date(row.timestamp).getTime();
        if (!entry.lastTickAt || tickTime > entry.lastTickAt) {
          entry.lastTickAt = tickTime;
        }
      }
    }
  } catch {
    // exchange_ticks may not exist — silently skip
  }
}

/**
 * Get current module state.
 *
 * @returns {Object} Module state including per-feed health status
 */
export function getState() {
  if (!initialized) {
    return { initialized: false, feeds: {}, gapCount: 0, config: null };
  }

  const now = Date.now();
  const feeds = {};
  let activeGapCount = 0;

  for (const [key, entry] of feedState.entries()) {
    const ageMs = entry.lastTickAt ? now - entry.lastTickAt : null;
    let status = 'unknown';
    if (ageMs === null) {
      status = 'no_data';
    } else if (ageMs < 2000) {
      status = 'healthy';
    } else if (ageMs < 5000) {
      status = 'stale';
    } else {
      status = 'dead';
    }

    if (entry.inGap) activeGapCount++;

    feeds[key] = {
      lastTickAt: entry.lastTickAt ? new Date(entry.lastTickAt).toISOString() : null,
      ageMs,
      status,
      inGap: entry.inGap,
    };
  }

  return {
    initialized: true,
    feeds,
    activeGapCount,
    config: { ...config },
  };
}

/**
 * Shutdown the module gracefully.
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }

  for (const unsub of unsubscribers) {
    try {
      if (typeof unsub === 'function') unsub();
    } catch {
      // ignore
    }
  }
  unsubscribers = [];

  // Close any open gaps on shutdown
  try {
    await persistence.run(
      `UPDATE feed_gaps
       SET gap_end = NOW(),
           duration_seconds = EXTRACT(EPOCH FROM (NOW() - gap_start))
       WHERE gap_end IS NULL`
    );
  } catch {
    // best effort
  }

  feedState.clear();

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}
