/**
 * CLOB Price Logger Module
 *
 * Continuously captures UP/DOWN token prices from the Polymarket CLOB WebSocket
 * throughout full 15-minute windows. Maintains local order book state and
 * persists snapshots (best_bid, best_ask, mid_price, spread) at 1s intervals.
 *
 * Auto-discovers active tokens via window-manager polling.
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/clob-price-logger
 */

import WebSocket from 'ws';
import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as windowManager from '../window-manager/index.js';
import {
  ClobPriceLoggerError,
  ClobPriceLoggerErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;
let ws = null;
let snapshotIntervalId = null;
let discoveryIntervalId = null;
let flushIntervalId = null;
let cleanupIntervalId = null;
let reconnectTimer = null;
let reconnectDelay = 0;

/**
 * Per-token order book and price state
 * @type {Map<string, { symbol: string, epoch: number, bids: Map<string, number>, asks: Map<string, number>, lastTradePrice: number|null }>}
 */
let tokenBooks = new Map();

/** Buffer for pending snapshot inserts */
let snapshotBuffer = [];

// Statistics
let stats = {
  wsConnections: 0,
  wsDisconnections: 0,
  wsMessages: 0,
  snapshotsCaptured: 0,
  snapshotsInserted: 0,
  insertErrors: 0,
  lastSnapshotAt: null,
  tokensDiscovered: 0,
  tokensRemoved: 0,
};

/**
 * Get best bid/ask/mid from a token's order book
 */
function getBookMetrics(book) {
  const bidPrices = [...book.bids.keys()].map(Number);
  const askPrices = [...book.asks.keys()].map(Number);

  if (bidPrices.length === 0 && askPrices.length === 0) {
    return null;
  }

  const bestBid = bidPrices.length > 0 ? bidPrices.reduce((a, b) => a > b ? a : b) : null;
  const bestAsk = askPrices.length > 0 ? askPrices.reduce((a, b) => a < b ? a : b) : null;

  const midPrice = bestBid != null && bestAsk != null
    ? (bestBid + bestAsk) / 2
    : bestBid ?? bestAsk ?? null;

  const spread = bestBid != null && bestAsk != null
    ? bestAsk - bestBid
    : null;

  const bidSizeTop = bestBid != null ? book.bids.get(String(bestBid)) || 0 : null;
  const askSizeTop = bestAsk != null ? book.asks.get(String(bestAsk)) || 0 : null;

  return {
    bestBid,
    bestAsk,
    midPrice,
    spread,
    bidSizeTop,
    askSizeTop,
    lastTradePrice: book.lastTradePrice,
  };
}

/**
 * Handle incoming WebSocket message
 */
function handleWsMessage(data) {
  stats.wsMessages++;

  try {
    const msg = JSON.parse(data.toString());

    // Determine which token this message is for
    const assetId = msg.asset_id;
    if (!assetId || !tokenBooks.has(assetId)) {
      return;
    }

    const book = tokenBooks.get(assetId);

    switch (msg.event_type) {
      case 'book': {
        // Full order book snapshot
        book.bids.clear();
        book.asks.clear();
        for (const b of (msg.bids || [])) {
          book.bids.set(b.price, parseFloat(b.size));
        }
        for (const a of (msg.asks || [])) {
          book.asks.set(a.price, parseFloat(a.size));
        }
        break;
      }
      case 'price_change': {
        // Incremental order book update
        if (msg.changes) {
          for (const change of msg.changes) {
            const side = change.side === 'BUY' ? book.bids : book.asks;
            if (parseFloat(change.size) === 0) {
              side.delete(change.price);
            } else {
              side.set(change.price, parseFloat(change.size));
            }
          }
        }
        break;
      }
      case 'last_trade_price': {
        book.lastTradePrice = parseFloat(msg.price);
        break;
      }
    }
  } catch {
    // Ignore parse errors
  }
}

/**
 * Connect to CLOB WebSocket and subscribe to all active tokens
 */
function connectWebSocket() {
  if (!initialized) return;

  const tokenIds = [...tokenBooks.keys()];
  if (tokenIds.length === 0) {
    // No tokens to track yet - schedule retry
    reconnectTimer = setTimeout(connectWebSocket, config.discoveryIntervalMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
    return;
  }

  try {
    ws = new WebSocket(config.wsUrl);

    ws.on('open', () => {
      stats.wsConnections++;
      reconnectDelay = 0;
      log.info('ws_connected', { tokenCount: tokenIds.length });

      // Subscribe to all active tokens
      ws.send(JSON.stringify({
        type: 'market',
        assets_ids: tokenIds,
      }));
    });

    ws.on('message', handleWsMessage);

    ws.on('close', () => {
      stats.wsDisconnections++;
      log.warn('ws_disconnected');
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.error('ws_error', { error: err.message });
      // Force close so the 'close' handler triggers reconnect
      try { ws.close(); } catch { /* ignore */ }
    });
  } catch (err) {
    log.error('ws_connect_failed', { error: err.message });
    scheduleReconnect();
  }
}

/**
 * Schedule WebSocket reconnection with exponential backoff
 */
function scheduleReconnect() {
  if (!initialized) return;

  reconnectDelay = reconnectDelay === 0
    ? config.reconnectBaseMs
    : Math.min(reconnectDelay * 2, config.reconnectMaxMs);

  log.info('ws_reconnect_scheduled', { delayMs: reconnectDelay });
  reconnectTimer = setTimeout(connectWebSocket, reconnectDelay);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

/**
 * Reconnect WebSocket with updated token subscriptions
 */
function reconnectWithTokens() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Close existing connection - onClose handler will reconnect
    ws.close();
  } else if (!reconnectTimer) {
    // No connection and no pending reconnect - connect now
    connectWebSocket();
  }
}

/**
 * Capture snapshots for all active tokens and buffer for persistence
 */
function captureSnapshots() {
  const now = new Date().toISOString();

  for (const [tokenId, book] of tokenBooks) {
    const metrics = getBookMetrics(book);
    if (!metrics) continue;

    snapshotBuffer.push({
      timestamp: now,
      token_id: tokenId,
      symbol: book.symbol,
      window_epoch: book.epoch,
      best_bid: metrics.bestBid,
      best_ask: metrics.bestAsk,
      mid_price: metrics.midPrice,
      spread: metrics.spread,
      last_trade_price: metrics.lastTradePrice,
      bid_size_top: metrics.bidSizeTop,
      ask_size_top: metrics.askSizeTop,
    });

    stats.snapshotsCaptured++;
  }

  // Flush buffer if it reaches batch size
  if (snapshotBuffer.length >= config.batchSize) {
    flushBuffer();
  }
}

/**
 * Flush snapshot buffer to database
 */
async function flushBuffer() {
  if (snapshotBuffer.length === 0) return;

  const batch = snapshotBuffer.splice(0, snapshotBuffer.length);

  try {
    const colCount = 11;
    const values = [];
    const params = [];
    batch.forEach((snap, i) => {
      const offset = i * colCount;
      values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9}, $${offset+10}, $${offset+11})`);
      params.push(
        snap.timestamp, snap.token_id, snap.symbol, snap.window_epoch,
        snap.best_bid, snap.best_ask, snap.mid_price, snap.spread,
        snap.last_trade_price, snap.bid_size_top, snap.ask_size_top,
      );
    });

    const insertSQL = `
      INSERT INTO clob_price_snapshots (
        timestamp, token_id, symbol, window_epoch,
        best_bid, best_ask, mid_price, spread,
        last_trade_price, bid_size_top, ask_size_top
      ) VALUES ${values.join(', ')}
    `;

    await persistence.run(insertSQL, params);

    stats.snapshotsInserted += batch.length;
    stats.lastSnapshotAt = new Date().toISOString();
  } catch (err) {
    stats.insertErrors++;
    log.error('snapshot_insert_failed', {
      error: err.message,
      count: batch.length,
    });

    // Re-queue if buffer has space
    if (snapshotBuffer.length + batch.length <= config.maxBufferSize) {
      snapshotBuffer.push(...batch);
    }
  }
}

/**
 * Discover active tokens from window-manager and update tracking
 */
async function discoverTokens() {
  try {
    const windows = await windowManager.getActiveWindows();
    const activeTokenIds = new Set();
    let tokenSetChanged = false;

    for (const w of windows) {
      if (w.token_id_up) {
        activeTokenIds.add(w.token_id_up);
        if (!tokenBooks.has(w.token_id_up) && tokenBooks.size < config.maxActiveTokens) {
          tokenBooks.set(w.token_id_up, {
            symbol: `${w.crypto}-up`,
            epoch: w.epoch,
            bids: new Map(),
            asks: new Map(),
            lastTradePrice: null,
          });
          stats.tokensDiscovered++;
          tokenSetChanged = true;
          log.info('token_discovered', {
            token_id: w.token_id_up.slice(0, 20) + '...',
            symbol: `${w.crypto}-up`,
            epoch: w.epoch,
          });
        }
      }

      if (w.token_id_down) {
        activeTokenIds.add(w.token_id_down);
        if (!tokenBooks.has(w.token_id_down) && tokenBooks.size < config.maxActiveTokens) {
          tokenBooks.set(w.token_id_down, {
            symbol: `${w.crypto}-down`,
            epoch: w.epoch,
            bids: new Map(),
            asks: new Map(),
            lastTradePrice: null,
          });
          stats.tokensDiscovered++;
          tokenSetChanged = true;
          log.info('token_discovered', {
            token_id: w.token_id_down.slice(0, 20) + '...',
            symbol: `${w.crypto}-down`,
            epoch: w.epoch,
          });
        }
      }
    }

    // Remove tokens no longer active — collect keys first to avoid mutating during iteration
    const tokensToRemove = [];
    for (const [tokenId] of tokenBooks) {
      if (!activeTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      tokenBooks.delete(tokenId);
      stats.tokensRemoved++;
      tokenSetChanged = true;
      log.info('token_removed', { token_id: tokenId.slice(0, 20) + '...' });
    }

    // If token set changed, reconnect WebSocket to update subscriptions
    if (tokenSetChanged) {
      reconnectWithTokens();
    }
  } catch (err) {
    log.warn('token_discovery_failed', { error: err.message });
  }
}

/**
 * Cleanup old snapshots based on retention policy
 */
async function cleanupOldSnapshots(days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    await persistence.run('DELETE FROM clob_price_snapshots WHERE timestamp < $1', [cutoff]);
    log.info('cleanup_complete', { table: 'clob_price_snapshots', cutoff });
  } catch (err) {
    log.warn('cleanup_failed', { error: err.message });
  }
}

/**
 * Initialize the CLOB price logger module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.clobPriceLogger] - Module config
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'clob-price-logger' });
  log.info('module_init_start');

  const cplConfig = cfg.clobPriceLogger || {};
  config = {
    snapshotIntervalMs: cplConfig.snapshotIntervalMs ?? DEFAULT_CONFIG.snapshotIntervalMs,
    wsUrl: cplConfig.wsUrl ?? DEFAULT_CONFIG.wsUrl,
    restUrl: cplConfig.restUrl ?? DEFAULT_CONFIG.restUrl,
    reconnectBaseMs: cplConfig.reconnectBaseMs ?? DEFAULT_CONFIG.reconnectBaseMs,
    reconnectMaxMs: cplConfig.reconnectMaxMs ?? DEFAULT_CONFIG.reconnectMaxMs,
    maxActiveTokens: cplConfig.maxActiveTokens ?? DEFAULT_CONFIG.maxActiveTokens,
    discoveryIntervalMs: cplConfig.discoveryIntervalMs ?? DEFAULT_CONFIG.discoveryIntervalMs,
    batchSize: cplConfig.batchSize ?? DEFAULT_CONFIG.batchSize,
    maxBufferSize: cplConfig.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
    retentionDays: cplConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
    cleanupIntervalHours: cplConfig.cleanupIntervalHours ?? DEFAULT_CONFIG.cleanupIntervalHours,
  };

  initialized = true;

  // Initial token discovery
  await discoverTokens();

  // Start snapshot interval
  snapshotIntervalId = setInterval(() => {
    captureSnapshots();
  }, config.snapshotIntervalMs);
  if (snapshotIntervalId.unref) snapshotIntervalId.unref();

  // Periodic buffer flush to ensure no data sits too long
  flushIntervalId = setInterval(() => {
    flushBuffer().catch(err => {
      if (log) log.error('periodic_flush_failed', { error: err.message });
    });
  }, 5000);
  if (flushIntervalId.unref) flushIntervalId.unref();

  // Start token discovery polling
  discoveryIntervalId = setInterval(() => {
    discoverTokens().catch(err => {
      if (log) log.warn('discovery_poll_failed', { error: err.message });
    });
  }, config.discoveryIntervalMs);
  if (discoveryIntervalId.unref) discoveryIntervalId.unref();

  // Start retention cleanup interval
  if (config.cleanupIntervalHours > 0) {
    const cleanupMs = config.cleanupIntervalHours * 60 * 60 * 1000;
    cleanupIntervalId = setInterval(() => {
      cleanupOldSnapshots(config.retentionDays).catch(() => {});
    }, cleanupMs);
    if (cleanupIntervalId.unref) cleanupIntervalId.unref();
  }

  // Connect WebSocket
  connectWebSocket();

  log.info('clob_price_logger_initialized', {
    config: {
      snapshotIntervalMs: config.snapshotIntervalMs,
      maxActiveTokens: config.maxActiveTokens,
      discoveryIntervalMs: config.discoveryIntervalMs,
    },
    initialTokens: tokenBooks.size,
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
      wsConnected: false,
      stats: null,
      config: null,
    };
  }

  return {
    initialized: true,
    activeTokens: tokenBooks.size,
    tokens: [...tokenBooks.entries()].map(([id, book]) => ({
      token_id: id.slice(0, 24) + '...',
      symbol: book.symbol,
      epoch: book.epoch,
      bidLevels: book.bids.size,
      askLevels: book.asks.size,
    })),
    wsConnected: ws !== null && ws.readyState === WebSocket.OPEN,
    bufferSize: snapshotBuffer.length,
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
  if (log) log.info('module_shutdown_start');

  initialized = false;

  // Clear intervals
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }
  if (discoveryIntervalId) {
    clearInterval(discoveryIntervalId);
    discoveryIntervalId = null;
  }
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Final flush
  await flushBuffer();

  // Close WebSocket
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }

  // Clear state
  tokenBooks.clear();
  snapshotBuffer = [];
  reconnectDelay = 0;

  stats = {
    wsConnections: 0,
    wsDisconnections: 0,
    wsMessages: 0,
    snapshotsCaptured: 0,
    snapshotsInserted: 0,
    insertErrors: 0,
    lastSnapshotAt: null,
    tokensDiscovered: 0,
    tokensRemoved: 0,
  };

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  config = null;
}

export { ClobPriceLoggerError, ClobPriceLoggerErrorCodes };
