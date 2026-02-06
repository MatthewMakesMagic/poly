/**
 * Order Book Snapshot Collector Module
 *
 * Periodically snapshots order books for active markets and persists
 * depth/spread data for analysis.
 *
 * V3 Philosophy Implementation - Phase 5: Data Capture Infrastructure (Task 5.2)
 *
 * Public interface:
 * - init(config) - Initialize with active token tracking
 * - getState() - Get current state
 * - shutdown() - Stop collection and cleanup
 * - addToken(tokenId, symbol) - Register a token for snapshotting
 * - removeToken(tokenId) - Stop snapshotting a token
 *
 * @module modules/order-book-collector
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as polymarket from '../../clients/polymarket/index.js';
import * as windowManager from '../window-manager/index.js';
import {
  OrderBookCollectorError,
  OrderBookCollectorErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;
let snapshotIntervalId = null;
let discoveryIntervalId = null;
let snapshotIdCounter = 0;
let snapshotCycleRunning = false;

/** @type {Map<string, { symbol: string, addedAt: string }>} */
let activeTokens = new Map();

// Statistics
let stats = {
  snapshotsTaken: 0,
  snapshotsInserted: 0,
  snapshotErrors: 0,
  l2LevelsInserted: 0,
  l2InsertErrors: 0,
  lastSnapshotAt: null,
};

/**
 * Calculate depth at a given percentage threshold from best price
 *
 * @param {Array<{price: string, size: string}>} orders - Bid or ask orders
 * @param {number} bestPrice - Best bid or best ask price
 * @param {number} thresholdPct - Percentage threshold (e.g., 0.01 for 1%)
 * @param {string} side - 'bid' or 'ask'
 * @returns {number} Total size within the threshold
 */
function calculateDepthAtThreshold(orders, bestPrice, thresholdPct, side) {
  if (!orders || orders.length === 0 || !bestPrice) {
    return 0;
  }

  let totalSize = 0;
  const limit = side === 'bid'
    ? bestPrice * (1 - thresholdPct)
    : bestPrice * (1 + thresholdPct);

  for (const order of orders) {
    const price = parseFloat(order.price);
    const size = parseFloat(order.size);

    if (side === 'bid' && price >= limit) {
      totalSize += size * price; // Dollar value
    } else if (side === 'ask' && price <= limit) {
      totalSize += size * price; // Dollar value
    }
  }

  return totalSize;
}

/**
 * Take a snapshot of a single token's order book
 *
 * @param {string} tokenId - Token ID
 * @param {string} symbol - Symbol name
 * @returns {Promise<Object|null>} Snapshot data or null on error
 */
async function takeSnapshot(tokenId, symbol) {
  try {
    const book = await polymarket.getOrderBook(tokenId);

    const bids = book.bids || [];
    const asks = book.asks || [];

    if (bids.length === 0 && asks.length === 0) {
      return null; // Empty book, skip
    }

    const bestBid = bids.length > 0
      ? bids.reduce((max, b) => { const p = parseFloat(b.price); return p > max ? p : max; }, -Infinity)
      : null;
    const bestAsk = asks.length > 0
      ? asks.reduce((min, a) => { const p = parseFloat(a.price); return p < min ? p : min; }, Infinity)
      : null;

    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const midPrice = bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : bestBid ?? bestAsk ?? null;

    // Calculate depth at 1% and 5% thresholds
    const bidDepth100 = bestBid ? calculateDepthAtThreshold(bids, bestBid, 0.01, 'bid') : 0;
    const askDepth100 = bestAsk ? calculateDepthAtThreshold(asks, bestAsk, 0.01, 'ask') : 0;
    const bidDepth500 = bestBid ? calculateDepthAtThreshold(bids, bestBid, 0.05, 'bid') : 0;
    const askDepth500 = bestAsk ? calculateDepthAtThreshold(asks, bestAsk, 0.05, 'ask') : 0;

    return {
      timestamp: new Date().toISOString(),
      symbol,
      token_id: tokenId,
      best_bid: bestBid,
      best_ask: bestAsk,
      spread,
      mid_price: midPrice,
      bid_depth_100: bidDepth100,
      ask_depth_100: askDepth100,
      bid_depth_500: bidDepth500,
      ask_depth_500: askDepth500,
      // Raw order book levels for L2 persistence
      rawBids: bids,
      rawAsks: asks,
    };
  } catch (err) {
    if (log) {
      log.warn('snapshot_fetch_failed', {
        token_id: tokenId,
        symbol,
        error: err.message,
      });
    }
    return null;
  }
}

/**
 * Run a snapshot cycle for all active tokens
 *
 * @returns {Promise<void>}
 */
async function runSnapshotCycle() {
  if (activeTokens.size === 0 || snapshotCycleRunning) {
    return;
  }
  snapshotCycleRunning = true;

  try {
  const tokenEntries = [...activeTokens.entries()];
  const results = await Promise.allSettled(
    tokenEntries.map(([tokenId, info]) => takeSnapshot(tokenId, info.symbol))
  );
  const snapshots = results
    .filter(r => r.status === 'fulfilled' && r.value != null)
    .map(r => r.value);

  stats.snapshotsTaken += snapshots.length;

  if (snapshots.length === 0) {
    return;
  }

  // Batch insert aggregated snapshots
  try {
    const insertSQL = `
      INSERT INTO order_book_snapshots (
        timestamp, symbol, token_id, best_bid, best_ask, spread,
        mid_price, bid_depth_100, ask_depth_100, bid_depth_500, ask_depth_500
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;

    await persistence.transaction(async (client) => {
      for (const snap of snapshots) {
        await client.run(insertSQL, [
          snap.timestamp,
          snap.symbol,
          snap.token_id,
          snap.best_bid,
          snap.best_ask,
          snap.spread,
          snap.mid_price,
          snap.bid_depth_100,
          snap.ask_depth_100,
          snap.bid_depth_500,
          snap.ask_depth_500,
        ]);
      }
    });

    stats.snapshotsInserted += snapshots.length;
    stats.lastSnapshotAt = new Date().toISOString();

    if (config.verboseLogging && log) {
      log.debug('snapshots_persisted', {
        count: snapshots.length,
        tokens: snapshots.map(s => s.symbol),
      });
    }
  } catch (err) {
    stats.snapshotErrors++;
    if (log) {
      log.error('snapshot_persistence_failed', {
        error: err.message,
        count: snapshots.length,
      });
    }
  }

  // Batch insert L2 order book levels
  try {
    const l2InsertSQL = `
      INSERT INTO order_book_levels (
        timestamp, token_id, symbol, side, price, size, level_index, snapshot_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;

    const l2Levels = [];
    for (const snap of snapshots) {
      const snapshotId = ++snapshotIdCounter;

      // Sort bids descending (best first), take top 10
      const sortedBids = (snap.rawBids || [])
        .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a, b) => b.price - a.price)
        .slice(0, 10);

      // Sort asks ascending (best first), take top 10
      const sortedAsks = (snap.rawAsks || [])
        .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a, b) => a.price - b.price)
        .slice(0, 10);

      sortedBids.forEach((bid, idx) => {
        l2Levels.push([
          snap.timestamp, snap.token_id, snap.symbol,
          'bid', bid.price, bid.size, idx, snapshotId,
        ]);
      });

      sortedAsks.forEach((ask, idx) => {
        l2Levels.push([
          snap.timestamp, snap.token_id, snap.symbol,
          'ask', ask.price, ask.size, idx, snapshotId,
        ]);
      });
    }

    if (l2Levels.length > 0) {
      const colCount = 8;
      const values = [];
      const params = [];
      l2Levels.forEach((level, i) => {
        const offset = i * colCount;
        values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8})`);
        params.push(...level);
      });

      const bulkInsertSQL = `
        INSERT INTO order_book_levels (
          timestamp, token_id, symbol, side, price, size, level_index, snapshot_id
        ) VALUES ${values.join(', ')}
      `;

      await persistence.run(bulkInsertSQL, params);
      stats.l2LevelsInserted += l2Levels.length;
    }
  } catch (err) {
    stats.l2InsertErrors++;
    if (log) {
      log.error('l2_persistence_failed', {
        error: err.message,
        count: snapshots.length,
      });
    }
  }
  } finally {
    snapshotCycleRunning = false;
  }
}

/**
 * Add a token for periodic snapshotting
 *
 * @param {string} tokenId - Polymarket token ID
 * @param {string} symbol - Symbol name (e.g., 'btc', 'eth')
 */
export function addToken(tokenId, symbol) {
  if (!initialized) {
    throw new OrderBookCollectorError(
      OrderBookCollectorErrorCodes.NOT_INITIALIZED,
      'Order book collector not initialized'
    );
  }

  if (activeTokens.size >= config.maxActiveTokens) {
    log.warn('max_active_tokens_reached', {
      max: config.maxActiveTokens,
      token_id: tokenId,
    });
    return;
  }

  activeTokens.set(tokenId, {
    symbol,
    addedAt: new Date().toISOString(),
  });

  log.info('token_added', { token_id: tokenId, symbol });
}

/**
 * Remove a token from snapshotting
 *
 * @param {string} tokenId - Token ID to remove
 */
export function removeToken(tokenId) {
  if (activeTokens.delete(tokenId) && log) {
    log.info('token_removed', { token_id: tokenId });
  }
}

/**
 * Initialize the order book collector module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.orderBookCollector] - Module config
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  log = child({ module: 'order-book-collector' });
  log.info('module_init_start');

  const obcConfig = cfg.orderBookCollector || {};
  config = {
    snapshotIntervalMs: obcConfig.snapshotIntervalMs ?? DEFAULT_CONFIG.snapshotIntervalMs,
    maxActiveTokens: obcConfig.maxActiveTokens ?? DEFAULT_CONFIG.maxActiveTokens,
    verboseLogging: obcConfig.verboseLogging ?? DEFAULT_CONFIG.verboseLogging,
  };

  initialized = true;

  // Start snapshot interval
  if (config.snapshotIntervalMs > 0) {
    snapshotIntervalId = setInterval(() => {
      runSnapshotCycle().catch(err => {
        if (log) {
          log.error('snapshot_cycle_failed', { error: err.message });
        }
      });
    }, config.snapshotIntervalMs);

    if (snapshotIntervalId.unref) {
      snapshotIntervalId.unref();
    }
  }

  // Auto-discover tokens from window-manager
  discoveryIntervalId = setInterval(async () => {
    try {
      const windows = await windowManager.getActiveWindows();
      const activeWindowTokenIds = new Set();

      for (const w of windows) {
        if (w.token_id_up) {
          activeWindowTokenIds.add(w.token_id_up);
          if (!activeTokens.has(w.token_id_up)) {
            addToken(w.token_id_up, `${w.crypto}-up`);
          }
        }
        if (w.token_id_down) {
          activeWindowTokenIds.add(w.token_id_down);
          if (!activeTokens.has(w.token_id_down)) {
            addToken(w.token_id_down, `${w.crypto}-down`);
          }
        }
      }

      // Remove tokens no longer in active windows — collect first to avoid mutating during iteration
      const tokensToRemove = [];
      for (const [tokenId] of activeTokens) {
        if (!activeWindowTokenIds.has(tokenId)) {
          tokensToRemove.push(tokenId);
        }
      }
      for (const tokenId of tokensToRemove) {
        removeToken(tokenId);
      }
    } catch (err) {
      if (log) {
        log.warn('token_discovery_failed', { error: err.message });
      }
    }
  }, 5000);
  if (discoveryIntervalId.unref) {
    discoveryIntervalId.unref();
  }

  log.info('order_book_collector_initialized', {
    config: {
      snapshotIntervalMs: config.snapshotIntervalMs,
      maxActiveTokens: config.maxActiveTokens,
    },
  });
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized) {
    return {
      initialized: false,
      activeTokens: 0,
      stats: null,
      config: null,
    };
  }

  return {
    initialized: true,
    activeTokens: activeTokens.size,
    tokens: Array.from(activeTokens.entries()).map(([id, info]) => ({
      token_id: id,
      symbol: info.symbol,
      added_at: info.addedAt,
    })),
    stats: { ...stats },
    config: { ...config },
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }

  if (discoveryIntervalId) {
    clearInterval(discoveryIntervalId);
    discoveryIntervalId = null;
  }

  activeTokens.clear();

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  snapshotIdCounter = 0;
  snapshotCycleRunning = false;
  stats = {
    snapshotsTaken: 0,
    snapshotsInserted: 0,
    snapshotErrors: 0,
    l2LevelsInserted: 0,
    l2InsertErrors: 0,
    lastSnapshotAt: null,
  };
}

export { OrderBookCollectorError, OrderBookCollectorErrorCodes };
