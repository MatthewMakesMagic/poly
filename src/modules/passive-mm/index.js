/**
 * Passive Market Maker Module — Multi-Variant Support
 *
 * Wires the mm-cs-signal-skew strategy for live paper/live trading.
 * Supports multiple named strategy variants running simultaneously,
 * each with independent order tracking, fills, and P&L.
 *
 * Subscribes to CLOB WS for L2 book updates, feeds them through
 * per-variant LiveMarketState instances, evaluates the strategy
 * on each tick, and manages order lifecycle.
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
import * as signalSkewStrategy from '../../backtest/strategies/mm-cs-signal-skew.js';
import * as pairHedgeStrategy from '../../backtest/strategies/mm-cs-pair-hedge.js';
import { createLiveMarketState } from './live-market-state.js';
import { createOrderTracker } from './order-tracker.js';
import { createTickEvaluator } from './tick-evaluator.js';
import { createReconciler } from './reconciler.js';

// ── Module state ──

let log = null;
let initialized = false;
let config = null;
let scanIntervalId = null;
let strategy = null; // Selected strategy module (signal-skew or pair-hedge)

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
};

// Default variants: two signal-skew configs
const DEFAULT_VARIANTS = [
  { name: 'skew-002', strategyConfig: { skewPerDollar: 0.002 } },
  { name: 'skew-005', strategyConfig: { skewPerDollar: 0.005 } },
];

// ═══════════════════════════════════════════════════════════════════════════
// MODULE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the passive market maker module.
 *
 * @param {Object} cfg - Configuration
 * @param {Object} cfg.passiveMm - Module-specific config
 * @param {Array} cfg.passiveMm.variants - Named strategy variants
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'passive-mm' });
  log.info('module_init_start');

  const mmCfg = cfg.passiveMm || {};

  // Select strategy module
  const strategyName = mmCfg.strategy || 'signal-skew';
  strategy = strategyName === 'pair-hedge' ? pairHedgeStrategy : signalSkewStrategy;

  // Build variant configs: merge strategy defaults with each variant's overrides
  const rawVariants = mmCfg.variants || DEFAULT_VARIANTS;
  const variants = rawVariants.map(v => ({
    name: v.name,
    strategyConfig: { ...strategy.defaults, ...(v.strategyConfig || {}) },
  }));

  config = {
    crypto: mmCfg.crypto || DEFAULT_CONFIG.crypto,
    tradingMode: mmCfg.tradingMode || DEFAULT_CONFIG.tradingMode,
    scanIntervalMs: mmCfg.scanIntervalMs || DEFAULT_CONFIG.scanIntervalMs,
    settlementDelayMs: mmCfg.settlementDelayMs || DEFAULT_CONFIG.settlementDelayMs,
    variants,
  };

  // Ensure DB table exists (with variant_name column)
  await ensureTable();

  // Backfill payout/pnl for fills broken by case-mismatch bug
  try {
    const fixed = await persistence.run(`
      UPDATE passive_mm_trades SET
        payout = CASE
          WHEN UPPER(resolved_direction) = UPPER(side) THEN fill_size
          ELSE 0
        END,
        pnl = CASE
          WHEN UPPER(resolved_direction) = UPPER(side) THEN fill_size - capital
          ELSE -capital
        END
      WHERE payout = 0 AND resolved_direction IS NOT NULL
    `);
    if (fixed?.rowCount > 0) {
      log.info('backfill_payout_fixed', { rows: fixed.rowCount });
    }
  } catch (err) {
    log.warn('backfill_payout_error', { error: err.message });
  }

  // Load cumulative stats from DB so they survive redeploys
  try {
    const row = await persistence.get(`
      SELECT
        COUNT(DISTINCT window_id) as windows,
        COUNT(*) as fills,
        COUNT(DISTINCT CASE WHEN is_paired THEN window_id END) as paired,
        COALESCE(SUM(pnl), 0) as cumulative_pnl
      FROM passive_mm_trades
    `);
    if (row) {
      stats.windowsTracked = parseInt(row.windows) || 0;
      stats.fills = parseInt(row.fills) || 0;
      stats.pairedFills = parseInt(row.paired) || 0;
      stats.cumulativePnl = parseFloat(row.cumulative_pnl) || 0;
      log.info('stats_loaded_from_db', { ...stats });
    }
  } catch (err) {
    log.warn('stats_load_error', { error: err.message });
  }

  // Crash recovery: cancel any orphaned GTC orders from previous deploy
  if (config.tradingMode === 'LIVE') {
    try {
      await polymarketClient.cancelAll();
      log.info('startup_cancel_orphaned_orders');
    } catch (err) {
      log.warn('startup_cancel_error', { error: err.message });
    }
  }

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
    variants: config.variants.map(v => v.name),
    variantConfigs: config.variants.map(v => ({ name: v.name, ...v.strategyConfig })),
  });
}

/**
 * Get current module state.
 * Each variant appears as a separate entry per window for dashboard compatibility.
 *
 * @returns {Object}
 */
export function getState() {
  if (!initialized) {
    return { initialized: false, activeWindows: [], stats: null, config: null };
  }

  const windowSummaries = [];
  for (const [windowId, ws] of activeWindows) {
    for (const vi of ws.variants) {
      const orders = vi.orderTracker.getWindowOrders();
      const evalStats = vi.tickEvaluator.getStats();
      const st = vi.liveState.state;
      windowSummaries.push({
        windowId,
        variantName: vi.name,
        timeToCloseMs: st?.window?.timeToCloseMs ?? null,
        ticks: evalStats.tickCount,
        signals: evalStats.signalCount,
        resting: orders.restingOrders,
        fills: orders.fills,
        upCost: orders.upCost,
        downCost: orders.downCost,
        paired: orders.paired,
        pairEdge: orders.pairEdge,
        restingOrderDetails: orders.restingOrderDetails || [],
        fillDetails: (orders.fillDetails || []).map(f => ({
          side: f.side,
          price: f.price,
          size: f.size,
          capital: f.capital,
          filledAt: f.filledAt,
        })),
        // Debug: market data visibility
        debug: {
          tokenUp: ws.windowData?.token_id_up?.slice(0, 16) ?? null,
          tokenDown: ws.windowData?.token_id_down?.slice(0, 16) ?? null,
          upBid: st?.clobUp?.bestBid ?? null,
          upAsk: st?.clobUp?.bestAsk ?? null,
          downBid: st?.clobDown?.bestBid ?? null,
          downAsk: st?.clobDown?.bestAsk ?? null,
          strike: st?.strike ?? null,
          exchangeMedian: st?.getExchangeMedian?.() ?? null,
          mm: st?._mm ? {
            upInvCost: st._mm.upInv?.cost ?? st._mm.upCost ?? 0,
            downInvCost: st._mm.downInv?.cost ?? st._mm.downCost ?? 0,
          } : null,
        },
      });
    }
  }

  return {
    initialized: true,
    activeWindows: windowSummaries,
    stats: { ...stats },
    config: {
      crypto: config.crypto,
      tradingMode: config.tradingMode,
      variants: config.variants.map(v => v.name),
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
      for (const vi of ws.variants) {
        if (vi.reconciler) vi.reconciler.stop();
        await vi.orderTracker.shutdown();
      }
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
  strategy = null;
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
 * Set up tracking for a new window, creating one pipeline per variant.
 *
 * Each variant gets its own:
 *   - LiveMarketState (because state._mm is variant-specific inventory)
 *   - OrderTracker (independent order map and fills)
 *   - Reconciler (desired-state latch)
 *   - TickEvaluator (strategy eval + reconcile trigger)
 *
 * Shared across variants:
 *   - CLOB WS subscription (one per token, callbacks fan out)
 *   - RTDS subscription (fan out to all liveStates)
 *   - Window timers (settlement, pre-close cancel)
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
    variants: config.variants.map(v => v.name),
  });

  const tokenIds = {
    up: windowData.token_id_up,
    down: windowData.token_id_down,
  };

  // ── Create one pipeline per variant ──
  const variantInstances = [];
  for (const variantCfg of config.variants) {
    const vLog = child({ module: 'passive-mm', variant: variantCfg.name });

    const liveState = createLiveMarketState({ log: vLog });
    liveState.setWindowContext(windowData);
    strategy.onWindowOpen(liveState.state);

    const orderTracker = createOrderTracker({
      mode: config.tradingMode,
      polymarketClient,
      tokenIds,
      liveState,
      log: vLog,
      crypto: config.crypto,
    });

    const reconciler = createReconciler({
      orderTracker,
      config: variantCfg.strategyConfig,
      log: vLog,
    });

    const tickEvaluator = createTickEvaluator({
      liveState,
      reconciler,
      orderTracker,
      strategy,
      strategyConfig: variantCfg.strategyConfig,
      mode: config.tradingMode,
      windowId,
      log: vLog,
    });

    // LIVE mode: start 250ms reconcile timer per variant
    if (config.tradingMode === 'LIVE') {
      reconciler.start(() => liveState.state);
    }

    variantInstances.push({
      name: variantCfg.name,
      strategyConfig: variantCfg.strategyConfig,
      liveState,
      orderTracker,
      reconciler,
      tickEvaluator,
    });
  }

  const unsubscribes = [];
  const timers = [];

  // ── Subscribe CLOB WS — fan out to all variants ──
  if (windowData.token_id_up) {
    clobWs.subscribeToken(windowData.token_id_up, `${config.crypto}-UP`);
    const unsub = clobWs.subscribe(windowData.token_id_up, (event) => {
      if (event.book) {
        for (const vi of variantInstances) {
          vi.tickEvaluator.onBookUpdate('up', event.book);
        }
      }
    });
    unsubscribes.push(unsub);
  }

  if (windowData.token_id_down) {
    clobWs.subscribeToken(windowData.token_id_down, `${config.crypto}-DOWN`);
    const unsub = clobWs.subscribe(windowData.token_id_down, (event) => {
      if (event.book) {
        for (const vi of variantInstances) {
          vi.tickEvaluator.onBookUpdate('down', event.book);
        }
      }
    });
    unsubscribes.push(unsub);
  }

  // ── Subscribe RTDS — fan out to all variants' liveStates ──
  let rtdsUnsub = null;
  try {
    rtdsUnsub = rtdsClient.subscribe(config.crypto, (tick) => {
      for (const vi of variantInstances) {
        if (tick.topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
          vi.liveState.updateChainlink(tick.price);
        } else if (tick.topic === TOPICS.CRYPTO_PRICES) {
          vi.liveState.updatePolyRef(tick.price);
        }
      }
    });
    unsubscribes.push(rtdsUnsub);
  } catch {
    log.debug('rtds_subscribe_skipped', { reason: 'not available' });
  }

  // ── Feed initial exchange prices to all variants ──
  try {
    const composite = exchangeTradeCollector.getCompositeVWAP(config.crypto);
    if (composite?.vwap) {
      for (const vi of variantInstances) {
        vi.liveState.updateExchange('composite', composite.vwap);
      }
    }
  } catch {
    // Non-critical
  }

  // ── Store window state ──
  const windowState = {
    windowId,
    windowData,
    variants: variantInstances,
    unsubscribes,
    timers,
    settled: false,
  };
  activeWindows.set(windowId, windowState);
  stats.windowsTracked++;

  // ── Schedule settlement ──
  const settlementDelay = windowData.time_remaining_ms + config.settlementDelayMs;
  const settlementTimer = setTimeout(() => {
    settleWindow(windowState).catch(err => {
      if (log) log.error('settlement_error', { windowId, error: err.message });
    });
  }, settlementDelay);
  if (settlementTimer.unref) settlementTimer.unref();
  timers.push(settlementTimer);

  // ── Schedule pre-close cancel (at T-5s) — stop all variants ──
  const cancelDelay = Math.max(0, windowData.time_remaining_ms - 5000);
  const cancelTimer = setTimeout(async () => {
    try {
      for (const vi of variantInstances) {
        vi.reconciler.stop();
        await vi.orderTracker.cancelAllByOrderId();
      }
    } catch (err) {
      if (log) log.warn('pre_close_cancel_error', { windowId, error: err.message });
    }
  }, cancelDelay);
  if (cancelTimer.unref) cancelTimer.unref();
  timers.push(cancelTimer);
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Settle a window: query resolution, calculate P&L per variant, persist.
 *
 * @param {Object} ws - Window state
 */
async function settleWindow(ws) {
  if (ws.settled) return;
  ws.settled = true;

  const { windowId } = ws;

  // Stop all variant reconcilers and cancel remaining orders
  for (const vi of ws.variants) {
    if (vi.reconciler) vi.reconciler.stop();
    await vi.orderTracker.cancelAllByOrderId();
  }

  // Check if any variant has fills
  const totalFills = ws.variants.reduce((sum, vi) => sum + vi.orderTracker.getWindowOrders().fills, 0);
  if (totalFills === 0) {
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
    const raw = event?.onchain_resolved_direction || event?.resolved_direction || null;
    resolvedDirection = raw ? raw.toUpperCase() : null;
  } catch (err) {
    log.warn('settlement_query_error', { windowId, error: err.message });
  }

  if (!resolvedDirection) {
    // Retry in 30s, max 10 retries (5 minutes total)
    ws.settlementRetries = (ws.settlementRetries || 0) + 1;
    if (ws.settlementRetries > 10) {
      log.error('settlement_max_retries', { windowId, fills: totalFills, retries: ws.settlementRetries });
      cleanupWindow(windowId);
      return;
    }
    log.warn('settlement_no_resolution', { windowId, fills: totalFills, retry: ws.settlementRetries });
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

  // ── Settle each variant independently ──
  for (const vi of ws.variants) {
    const orders = vi.orderTracker.getWindowOrders();
    if (orders.fills === 0) continue;

    const isPaired = orders.upTokens > 0 && orders.downTokens > 0;
    const totalCost = orders.upCost + orders.downCost;

    let payout = 0;
    if (resolvedDirection === 'UP') {
      payout = orders.upTokens * 1.0;
    } else {
      payout = orders.downTokens * 1.0;
    }

    const pnl = payout - totalCost;

    // Update aggregate stats
    stats.fills += orders.fills;
    if (isPaired) stats.pairedFills++;
    stats.cumulativePnl += pnl;

    log.info('window_settled', {
      windowId,
      variant: vi.name,
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

    // Persist each fill to DB with variant_name
    try {
      for (const fill of orders.fillDetails) {
        await persistence.run(`
          INSERT INTO passive_mm_trades (
            window_id, trading_mode, variant_name, side, token, fill_price, fill_size,
            capital, filled_at, resolved_direction, payout, pnl, is_paired
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::numeric / 1000), $10, $11, $12, $13)
        `, [
          windowId,
          config.tradingMode,
          vi.name,
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
      log.warn('persist_trades_error', { windowId, variant: vi.name, error: err.message });
    }
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
 * Ensure the passive_mm_trades table exists with variant_name column.
 */
async function ensureTable() {
  await persistence.run(`
    CREATE TABLE IF NOT EXISTS passive_mm_trades (
      id SERIAL PRIMARY KEY,
      window_id TEXT NOT NULL,
      trading_mode TEXT NOT NULL DEFAULT 'PAPER',
      variant_name TEXT,
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

  // Add variant_name column if table already existed without it
  try {
    await persistence.run(`
      ALTER TABLE passive_mm_trades ADD COLUMN IF NOT EXISTS variant_name TEXT
    `);
  } catch {
    // Column already exists or DB doesn't support IF NOT EXISTS — safe to ignore
  }
}
