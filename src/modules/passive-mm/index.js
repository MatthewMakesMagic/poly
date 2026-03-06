/**
 * Passive Market Maker Module
 *
 * Wires the mm-passive-polyref backtest strategy for live paper/live trading.
 * Subscribes to CLOB WS for L2 book updates, feeds them through LiveMarketState,
 * evaluates the strategy on each tick, and manages order lifecycle.
 *
 * Module interface: init(config), getState(), shutdown()
 *
 * @module modules/passive-mm
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as clobWs from '../../clients/clob-ws/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';
import * as windowManager from '../window-manager/index.js';
import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import * as polymarketClient from '../../clients/polymarket/index.js';
import * as strategy from '../../backtest/strategies/mm-passive-polyref.js';
import { createLiveMarketState } from './live-market-state.js';
import { createOrderTracker } from './order-tracker.js';
import { createTickEvaluator } from './tick-evaluator.js';

// ── Module state ──

let log = null;
let initialized = false;
let config = null;
let scanIntervalId = null;

/** @type {Map<string, WindowState>} */
let activeWindows = new Map();

let stats = {
  windowsTracked: 0,
  ordersPlaced: 0,
  fills: 0,
  pairedFills: 0,
  cumulativePnl: 0,
};

// ── Default config ──

const DEFAULT_CONFIG = {
  crypto: 'btc',
  tradingMode: 'PAPER',    // 'PAPER' or 'LIVE'
  scanIntervalMs: 10000,   // scan for new windows every 10s
  settlementDelayMs: 65000, // settle 65s after window close
  strategyConfig: {},       // override strategy defaults
};

// ═══════════════════════════════════════════════════════════════════════════
// MODULE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the passive market maker module.
 *
 * @param {Object} cfg - Configuration
 * @param {Object} cfg.passiveMm - Module-specific config
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'passive-mm' });
  log.info('module_init_start');

  const mmCfg = cfg.passiveMm || {};
  config = {
    crypto: mmCfg.crypto || DEFAULT_CONFIG.crypto,
    tradingMode: mmCfg.tradingMode || DEFAULT_CONFIG.tradingMode,
    scanIntervalMs: mmCfg.scanIntervalMs || DEFAULT_CONFIG.scanIntervalMs,
    settlementDelayMs: mmCfg.settlementDelayMs || DEFAULT_CONFIG.settlementDelayMs,
    strategyConfig: { ...strategy.defaults, ...(mmCfg.strategyConfig || {}) },
  };

  // Ensure DB table exists
  await ensureTable();

  initialized = true;

  // Start window scan loop
  scanIntervalId = setInterval(() => {
    scanAndTrack().catch(err => {
      if (log) log.warn('scan_error', { error: err.message });
    });
  }, config.scanIntervalMs);
  if (scanIntervalId.unref) scanIntervalId.unref();

  // Run initial scan immediately
  scanAndTrack().catch(err => {
    if (log) log.warn('initial_scan_error', { error: err.message });
  });

  log.info('module_initialized', {
    crypto: config.crypto,
    mode: config.tradingMode,
    strategyConfig: config.strategyConfig,
  });
}

/**
 * Get current module state.
 *
 * @returns {Object}
 */
export function getState() {
  if (!initialized) {
    return { initialized: false, activeWindows: [], stats: null, config: null };
  }

  const windowSummaries = [];
  for (const [windowId, ws] of activeWindows) {
    const orders = ws.orderTracker.getWindowOrders();
    const evalStats = ws.tickEvaluator.getStats();
    windowSummaries.push({
      windowId,
      timeToCloseMs: ws.liveState.state?.window?.timeToCloseMs ?? null,
      ticks: evalStats.tickCount,
      signals: evalStats.signalCount,
      resting: orders.restingOrders,
      fills: orders.fills,
      upCost: orders.upCost,
      downCost: orders.downCost,
      paired: orders.paired,
      pairEdge: orders.pairEdge,
    });
  }

  return {
    initialized: true,
    activeWindows: windowSummaries,
    stats: { ...stats },
    config: {
      crypto: config.crypto,
      tradingMode: config.tradingMode,
    },
  };
}

/**
 * Shutdown the module gracefully.
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  initialized = false;

  // Stop scan loop
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }

  // Shutdown all active windows
  for (const [windowId, ws] of activeWindows) {
    try {
      await ws.orderTracker.shutdown();
      for (const unsub of ws.unsubscribes) {
        unsub();
      }
      for (const timer of ws.timers) {
        clearTimeout(timer);
      }
    } catch (err) {
      if (log) log.warn('window_shutdown_error', { windowId, error: err.message });
    }
  }
  activeWindows = new Map();

  // Reset stats
  stats = { windowsTracked: 0, ordersPlaced: 0, fills: 0, pairedFills: 0, cumulativePnl: 0 };

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
  config = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// WINDOW SCAN & TRACK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan for active windows and start tracking new ones.
 */
async function scanAndTrack() {
  if (!initialized) return;

  let windows;
  try {
    windows = await windowManager.getActiveWindows();
  } catch (err) {
    log.warn('get_active_windows_failed', { error: err.message });
    return;
  }

  for (const win of windows) {
    if (win.crypto !== config.crypto) continue;
    if (activeWindows.has(win.window_id)) continue;
    if (win.time_remaining_ms < 30000) continue; // skip nearly-closed windows

    await startTrackingWindow(win);
  }
}

/**
 * Set up tracking for a new window.
 *
 * @param {Object} windowData - Window from getActiveWindows()
 */
async function startTrackingWindow(windowData) {
  const windowId = windowData.window_id;
  log.info('tracking_window_start', {
    windowId,
    tokenUp: windowData.token_id_up?.slice(0, 16),
    tokenDown: windowData.token_id_down?.slice(0, 16),
    timeRemainingMs: windowData.time_remaining_ms,
  });

  // Create LiveMarketState
  const liveState = createLiveMarketState({ log });
  liveState.setWindowContext(windowData);

  // Notify strategy of window open
  strategy.onWindowOpen(liveState.state);

  // Create OrderTracker
  const orderTracker = createOrderTracker({
    mode: config.tradingMode,
    polymarketClient,
    strategy,
    tokenIds: {
      up: windowData.token_id_up,
      down: windowData.token_id_down,
    },
    log,
  });

  // Create TickEvaluator
  const tickEvaluator = createTickEvaluator({
    liveState,
    orderTracker,
    strategy,
    strategyConfig: config.strategyConfig,
    mode: config.tradingMode,
    windowId,
    log,
  });

  const unsubscribes = [];
  const timers = [];

  // Subscribe CLOB WS to UP token
  if (windowData.token_id_up) {
    clobWs.subscribeToken(windowData.token_id_up, `${config.crypto}-UP`);
    const unsub = clobWs.subscribe(windowData.token_id_up, () => {
      const book = clobWs.getBook(windowData.token_id_up);
      if (book) tickEvaluator.onBookUpdate('up', book);
    });
    unsubscribes.push(unsub);
  }

  // Subscribe CLOB WS to DOWN token
  if (windowData.token_id_down) {
    clobWs.subscribeToken(windowData.token_id_down, `${config.crypto}-DOWN`);
    const unsub = clobWs.subscribe(windowData.token_id_down, () => {
      const book = clobWs.getBook(windowData.token_id_down);
      if (book) tickEvaluator.onBookUpdate('down', book);
    });
    unsubscribes.push(unsub);
  }

  // Subscribe to RTDS Chainlink for oracle updates
  let rtdsUnsub = null;
  try {
    rtdsUnsub = rtdsClient.subscribe(config.crypto, (tick) => {
      if (tick.topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
        liveState.updateChainlink(tick.price);
      } else if (tick.topic === TOPICS.CRYPTO_PRICES) {
        liveState.updatePolyRef(tick.price);
      }
    });
    unsubscribes.push(rtdsUnsub);
  } catch {
    log.debug('rtds_subscribe_skipped', { reason: 'not available' });
  }

  // Feed initial exchange prices
  try {
    const composite = exchangeTradeCollector.getCompositeVWAP(config.crypto);
    if (composite?.vwap) {
      liveState.updateExchange('composite', composite.vwap);
    }
  } catch {
    // Non-critical
  }

  // Store window state
  const windowState = {
    windowId,
    windowData,
    liveState,
    orderTracker,
    tickEvaluator,
    unsubscribes,
    timers,
    settled: false,
  };
  activeWindows.set(windowId, windowState);
  stats.windowsTracked++;

  // Schedule settlement
  const settlementDelay = windowData.time_remaining_ms + config.settlementDelayMs;
  const settlementTimer = setTimeout(() => {
    settleWindow(windowState).catch(err => {
      if (log) log.error('settlement_error', { windowId, error: err.message });
    });
  }, settlementDelay);
  if (settlementTimer.unref) settlementTimer.unref();
  timers.push(settlementTimer);

  // Schedule pre-close cancel (at T-5s for safety margin)
  const cancelDelay = Math.max(0, windowData.time_remaining_ms - 5000);
  const cancelTimer = setTimeout(() => {
    orderTracker.cancelAllOrders().catch(err => {
      if (log) log.warn('pre_close_cancel_error', { windowId, error: err.message });
    });
  }, cancelDelay);
  if (cancelTimer.unref) cancelTimer.unref();
  timers.push(cancelTimer);
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Settle a window: query resolution, calculate P&L, persist.
 *
 * @param {Object} ws - Window state
 */
async function settleWindow(ws) {
  if (ws.settled) return;
  ws.settled = true;

  const { windowId, orderTracker, liveState } = ws;

  // Cancel any remaining orders
  await orderTracker.cancelAllOrders();

  const orders = orderTracker.getWindowOrders();

  // If no fills, just cleanup
  if (orders.fills === 0) {
    log.info('window_no_fills', { windowId });
    cleanupWindow(windowId);
    return;
  }

  // Query resolution
  let resolvedDirection = null;
  try {
    const event = await persistence.get(`
      SELECT resolved_direction, onchain_resolved_direction
      FROM window_close_events
      WHERE window_id = $1
    `, [windowId]);
    resolvedDirection = event?.onchain_resolved_direction || event?.resolved_direction || null;
  } catch (err) {
    log.warn('settlement_query_error', { windowId, error: err.message });
  }

  if (!resolvedDirection) {
    // Retry in 30s
    log.warn('settlement_no_resolution', { windowId, fills: orders.fills });
    const retryTimer = setTimeout(() => {
      ws.settled = false;
      settleWindow(ws).catch(err => {
        if (log) log.warn('settlement_retry_error', { windowId, error: err.message });
        cleanupWindow(windowId);
      });
    }, 30000);
    if (retryTimer.unref) retryTimer.unref();
    ws.timers.push(retryTimer);
    return;
  }

  // Calculate P&L
  const isPaired = orders.upTokens > 0 && orders.downTokens > 0;
  const totalCost = orders.upCost + orders.downCost;

  let payout = 0;
  if (resolvedDirection === 'UP') {
    payout = orders.upTokens * 1.0; // UP tokens pay $1 each
  } else {
    payout = orders.downTokens * 1.0; // DOWN tokens pay $1 each
  }

  const pnl = payout - totalCost;

  // Update stats
  stats.fills += orders.fills;
  if (isPaired) stats.pairedFills++;
  stats.cumulativePnl += pnl;

  log.info('window_settled', {
    windowId,
    resolvedDirection,
    fills: orders.fills,
    paired: isPaired,
    upCost: orders.upCost.toFixed(4),
    downCost: orders.downCost.toFixed(4),
    totalCost: totalCost.toFixed(4),
    payout: payout.toFixed(4),
    pnl: pnl.toFixed(4),
    cumulativePnl: stats.cumulativePnl.toFixed(4),
  });

  // Persist each fill to DB
  try {
    for (const fill of orders.fillDetails) {
      await persistence.run(`
        INSERT INTO passive_mm_trades (
          window_id, trading_mode, side, token, fill_price, fill_size,
          capital, filled_at, resolved_direction, payout, pnl, is_paired
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::numeric / 1000), $9, $10, $11, $12)
      `, [
        windowId,
        config.tradingMode,
        fill.side,
        fill.token,
        fill.price,
        fill.size,
        fill.capital,
        fill.filledAt,
        resolvedDirection,
        resolvedDirection === (fill.side === 'up' ? 'UP' : 'DOWN') ? fill.size : 0,
        resolvedDirection === (fill.side === 'up' ? 'UP' : 'DOWN') ? fill.size - fill.capital : -fill.capital,
        isPaired,
      ]);
    }
  } catch (err) {
    log.warn('persist_trades_error', { windowId, error: err.message });
  }

  cleanupWindow(windowId);
}

/**
 * Clean up a tracked window.
 *
 * @param {string} windowId
 */
function cleanupWindow(windowId) {
  const ws = activeWindows.get(windowId);
  if (!ws) return;

  // Unsubscribe from CLOB WS
  for (const unsub of ws.unsubscribes) {
    try { unsub(); } catch { /* ok */ }
  }

  // Clear timers
  for (const timer of ws.timers) {
    clearTimeout(timer);
  }

  // Unsubscribe tokens from CLOB WS
  if (ws.windowData.token_id_up) {
    try { clobWs.unsubscribeToken(ws.windowData.token_id_up); } catch { /* ok */ }
  }
  if (ws.windowData.token_id_down) {
    try { clobWs.unsubscribeToken(ws.windowData.token_id_down); } catch { /* ok */ }
  }

  activeWindows.delete(windowId);
  log.info('window_cleaned_up', { windowId, remaining: activeWindows.size });
}

// ═══════════════════════════════════════════════════════════════════════════
// DB TABLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ensure the passive_mm_trades table exists.
 */
async function ensureTable() {
  await persistence.run(`
    CREATE TABLE IF NOT EXISTS passive_mm_trades (
      id SERIAL PRIMARY KEY,
      window_id TEXT NOT NULL,
      trading_mode TEXT NOT NULL DEFAULT 'PAPER',
      side TEXT NOT NULL,
      token TEXT NOT NULL,
      fill_price NUMERIC NOT NULL,
      fill_size NUMERIC NOT NULL,
      capital NUMERIC NOT NULL,
      filled_at TIMESTAMPTZ,
      resolved_direction TEXT,
      payout NUMERIC,
      pnl NUMERIC,
      is_paired BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await persistence.run(`
    CREATE INDEX IF NOT EXISTS idx_pmm_trades_window
    ON passive_mm_trades (window_id)
  `);
}
