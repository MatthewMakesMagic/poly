/**
 * Paper Trader V2 Module
 *
 * Main coordinator for realistic VWAP edge testing with streaming L2 data.
 * Follows the window-close-event-recorder pattern (timer-based scheduling).
 *
 * For each 15-minute window:
 * 1. Subscribe CLOB WS to UP/DOWN tokens
 * 2. Capture VWAP at window open
 * 3. At T-60s: evaluate VWAP edge signal, simulate fill against L2 depth
 * 4. At T+65s: check settlement, compute P&L
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/paper-trader
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as clobWs from '../../clients/clob-ws/index.js';
import * as windowManager from '../window-manager/index.js';
import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import { simulateFill } from './fill-simulator.js';
import * as latencyMeasurer from './latency-measurer.js';
import * as vwapStrategy from './vwap-strategy.js';
import {
  PaperTraderError,
  PaperTraderErrorCodes,
  DEFAULT_CONFIG,
  WINDOW_DURATION_SECONDS,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;

// Active window states: Map<windowId, WindowState>
let activeWindows = new Map();

// Timers
let scanIntervalId = null;
let snapshotIntervalId = null;

// Statistics
let stats = {
  windowsTracked: 0,
  signalsEvaluated: 0,
  signalsFired: 0,
  tradesWon: 0,
  tradesLost: 0,
  tradesPending: 0,
  cumulativePnl: 0,
  snapshotsPersisted: 0,
  snapshotErrors: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// MODULE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the paper trader module
 *
 * @param {Object} cfg - Full application configuration
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) return;

  log = child({ module: 'paper-trader' });
  log.info('module_init_start');

  const ptConfig = cfg.paperTrader || {};
  config = {
    positionSizeDollars: ptConfig.positionSizeDollars ?? DEFAULT_CONFIG.positionSizeDollars,
    vwapDeltaThreshold: ptConfig.vwapDeltaThreshold ?? DEFAULT_CONFIG.vwapDeltaThreshold,
    snapshotIntervalMs: ptConfig.snapshotIntervalMs ?? DEFAULT_CONFIG.snapshotIntervalMs,
    scanIntervalMs: ptConfig.scanIntervalMs ?? DEFAULT_CONFIG.scanIntervalMs,
    feeRate: ptConfig.feeRate ?? DEFAULT_CONFIG.feeRate,
    cryptos: ptConfig.cryptos ?? DEFAULT_CONFIG.cryptos,
    signalTimeBeforeCloseMs: ptConfig.signalTimeBeforeCloseMs ?? DEFAULT_CONFIG.signalTimeBeforeCloseMs,
    settlementDelayAfterCloseMs: ptConfig.settlementDelayAfterCloseMs ?? DEFAULT_CONFIG.settlementDelayAfterCloseMs,
    latencyProbeTimeBeforeCloseMs: ptConfig.latencyProbeTimeBeforeCloseMs ?? DEFAULT_CONFIG.latencyProbeTimeBeforeCloseMs,
  };

  // Initialize CLOB WS client
  await clobWs.init(cfg);

  // Initialize latency measurer
  latencyMeasurer.init(child({ module: 'paper-trader-latency' }));

  // Start scan interval
  scanIntervalId = setInterval(() => {
    scanAndTrack().catch(err => {
      if (log) log.error('scan_failed', { error: err.message });
    });
  }, config.scanIntervalMs);
  if (scanIntervalId.unref) scanIntervalId.unref();

  // Start periodic L2 snapshot interval
  snapshotIntervalId = setInterval(() => {
    persistPeriodicSnapshots().catch(err => {
      if (log && (stats.snapshotErrors <= 5 || stats.snapshotErrors % 60 === 0)) {
        log.warn('periodic_snapshot_failed', { error: err.message });
      }
    });
  }, config.snapshotIntervalMs);
  if (snapshotIntervalId.unref) snapshotIntervalId.unref();

  // Initial scan
  await scanAndTrack();

  initialized = true;
  log.info('paper_trader_initialized', {
    config: {
      positionSizeDollars: config.positionSizeDollars,
      vwapDeltaThreshold: config.vwapDeltaThreshold,
      cryptos: config.cryptos,
      feeRate: config.feeRate,
    },
  });
}

/**
 * Get current module state
 *
 * @returns {Object}
 */
export function getState() {
  if (!initialized) {
    return { initialized: false, stats: null, config: null };
  }

  return {
    initialized: true,
    activeWindows: Array.from(activeWindows.keys()),
    clobWs: clobWs.getState(),
    latencyStats: latencyMeasurer.getStats(),
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

  // Stop intervals
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }

  // Clear all active window timers
  for (const [windowId, ws] of activeWindows) {
    for (const timer of ws.timers) {
      clearTimeout(timer);
    }
  }
  activeWindows = new Map();

  // Shutdown CLOB WS
  await clobWs.shutdown();

  if (log) {
    log.info('module_shutdown_complete', { stats });
    log = null;
  }

  config = null;
  stats = {
    windowsTracked: 0,
    signalsEvaluated: 0,
    signalsFired: 0,
    tradesWon: 0,
    tradesLost: 0,
    tradesPending: 0,
    cumulativePnl: 0,
    snapshotsPersisted: 0,
    snapshotErrors: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCAN AND TRACK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Scan for active windows and set up tracking
 *
 * Called every scanIntervalMs (10s). For each configured crypto:
 * - Compute current epoch and window close time
 * - Fetch market from window-manager
 * - Subscribe CLOB WS to UP/DOWN tokens
 * - Capture VWAP at window open
 * - Schedule signal evaluation at T-60s
 * - Schedule settlement at T+65s
 */
async function scanAndTrack() {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  for (const crypto of config.cryptos) {
    const currentEpoch = Math.floor(nowSec / WINDOW_DURATION_SECONDS) * WINDOW_DURATION_SECONDS;
    const closeTimeSec = currentEpoch + WINDOW_DURATION_SECONDS;
    const closeTimeMs = closeTimeSec * 1000;
    const windowId = `${crypto}-15m-${currentEpoch}`;

    // Skip if already tracking
    if (activeWindows.has(windowId)) continue;

    // Fetch market info
    let market;
    try {
      market = await windowManager.fetchMarket(crypto, currentEpoch);
    } catch (err) {
      // Retry next scan
      continue;
    }

    if (!market || !market.upTokenId) continue;

    // Subscribe CLOB WS to both UP and DOWN tokens
    clobWs.subscribeToken(market.upTokenId, `${crypto}-UP`);
    if (market.downTokenId) {
      clobWs.subscribeToken(market.downTokenId, `${crypto}-DOWN`);
    }

    // Capture VWAP at window open
    let vwapAtOpen = null;
    try {
      const composite = exchangeTradeCollector.getCompositeVWAP(crypto);
      if (composite) {
        vwapAtOpen = composite.vwap;
      }
    } catch {
      // VWAP may not be available yet
    }

    // Create window state
    const windowState = {
      windowId,
      crypto,
      epoch: currentEpoch,
      closeTimeMs,
      market,
      vwapAtOpen,
      signalResult: null,
      tradeId: null,
      timers: [],
    };

    activeWindows.set(windowId, windowState);
    stats.windowsTracked++;

    log.info('window_tracked', {
      window_id: windowId,
      crypto,
      close_time: new Date(closeTimeMs).toISOString(),
      vwap_at_open: vwapAtOpen,
      up_token: market.upTokenId?.substring(0, 16) + '...',
    });

    // Schedule latency probe at T-90s
    const latencyDelay = closeTimeMs - config.latencyProbeTimeBeforeCloseMs - nowMs;
    if (latencyDelay > 0) {
      const latencyTimer = setTimeout(() => {
        runLatencyProbe(windowState).catch(err => {
          if (log) log.warn('latency_probe_error', { window_id: windowId, error: err.message });
        });
      }, latencyDelay);
      if (latencyTimer.unref) latencyTimer.unref();
      windowState.timers.push(latencyTimer);
    }

    // Schedule signal evaluation at T-60s
    const signalDelay = closeTimeMs - config.signalTimeBeforeCloseMs - nowMs;
    if (signalDelay > 0) {
      const signalTimer = setTimeout(() => {
        evaluateSignal(windowState).catch(err => {
          if (log) log.error('signal_eval_error', { window_id: windowId, error: err.message });
        });
      }, signalDelay);
      if (signalTimer.unref) signalTimer.unref();
      windowState.timers.push(signalTimer);
    }

    // Schedule settlement at T+65s
    const settlementDelay = closeTimeMs + config.settlementDelayAfterCloseMs - nowMs;
    if (settlementDelay > 0) {
      const settlementTimer = setTimeout(() => {
        handleSettlement(windowState).catch(err => {
          if (log) log.error('settlement_error', { window_id: windowId, error: err.message });
        });
      }, settlementDelay);
      if (settlementTimer.unref) settlementTimer.unref();
      windowState.timers.push(settlementTimer);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL EVALUATION (T-60s)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate the VWAP edge signal for a window
 *
 * @param {Object} windowState - Window tracking state
 */
async function evaluateSignal(windowState) {
  const { windowId, crypto, market } = windowState;
  stats.signalsEvaluated++;

  log.info('signal_eval_start', { window_id: windowId, crypto });

  // 1. Get live book from CLOB WS
  const upBook = clobWs.getBook(market.upTokenId);
  if (!upBook) {
    log.warn('signal_eval_no_book', { window_id: windowId });
    return;
  }

  // 2. Evaluate VWAP strategy
  const signal = vwapStrategy.evaluate(windowState, upBook, config);

  if (!signal) {
    log.info('signal_eval_no_signal', {
      window_id: windowId,
      crypto,
      clob_mid: upBook.mid,
    });
    return;
  }

  stats.signalsFired++;
  windowState.signalResult = signal;

  log.info('vwap_edge_signal', {
    window_id: windowId,
    crypto,
    entry_side: signal.entrySide,
    vwap_direction: signal.vwapDirection,
    clob_direction: signal.clobDirection,
    vwap_delta: signal.vwapDelta,
    abs_vwap_delta: signal.absVwapDelta,
    vwap_price: signal.vwapPrice,
    chainlink_price: signal.chainlinkPrice,
    clob_up_price: signal.clobUpPrice,
    exchange_count: signal.exchangeCount,
  });

  // 3. Persist full book snapshot (signal type)
  const bookSnapshotId = await persistBookSnapshot(
    signal.entryTokenId,
    crypto,
    'signal',
    true // include full book
  );

  // 4. Probe API latency at signal time
  let latencyMs = null;
  try {
    latencyMs = await latencyMeasurer.probeRestLatency(signal.entryTokenId);
  } catch (err) {
    log.warn('signal_latency_probe_failed', { error: err.message });
  }

  // 5. Simulate fill against real L2 depth
  const entryBook = clobWs.getBook(signal.entryTokenId);
  if (!entryBook) {
    log.warn('signal_no_entry_book', {
      window_id: windowId,
      entry_token_id: signal.entryTokenId?.substring(0, 16),
    });
    return;
  }

  const fillResult = simulateFill(entryBook, config.positionSizeDollars, {
    feeRate: config.feeRate,
  });

  if (!fillResult.success) {
    log.warn('signal_fill_failed', {
      window_id: windowId,
      unfilled: fillResult.unfilled,
    });
    return;
  }

  // Adjust entry price for latency (price may have moved)
  const adjustedEntryPrice = fillResult.vwapPrice; // Conservative: use same price

  log.info('paper_trade_simulated', {
    window_id: windowId,
    entry_side: signal.entrySide,
    sim_entry_price: fillResult.vwapPrice,
    sim_shares: fillResult.totalShares,
    sim_cost: fillResult.totalCost,
    sim_slippage: fillResult.slippage,
    sim_levels_consumed: fillResult.levelsConsumed,
    sim_market_impact: fillResult.marketImpact,
    latency_ms: latencyMs,
    partial_fill: fillResult.partialFill,
  });

  // 6. Persist paper trade
  try {
    const result = await persistence.runReturningId(`
      INSERT INTO paper_trades_v2 (
        window_id, symbol, signal_time, signal_type,
        vwap_direction, clob_direction, vwap_delta, vwap_price, chainlink_price, clob_up_price,
        exchange_count, total_volume,
        entry_side, entry_token_id, entry_book_snapshot_id,
        sim_entry_price, sim_shares, sim_cost, sim_slippage,
        sim_levels_consumed, sim_market_impact, sim_fee,
        latency_ms, adjusted_entry_price
      ) VALUES (
        $1, $2, NOW(), 'vwap_edge',
        $3, $4, $5, $6, $7, $8,
        $9, $10,
        $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20,
        $21, $22
      )
      RETURNING id
    `, [
      windowId,                          // $1
      crypto,                            // $2
      signal.vwapDirection,              // $3
      signal.clobDirection,              // $4
      signal.vwapDelta,                  // $5
      signal.vwapPrice,                  // $6
      signal.chainlinkPrice,             // $7
      signal.clobUpPrice,                // $8
      signal.exchangeCount,              // $9
      signal.totalVolume,                // $10
      signal.entrySide,                  // $11
      signal.entryTokenId,               // $12
      bookSnapshotId,                    // $13
      fillResult.vwapPrice,              // $14
      fillResult.totalShares,            // $15
      fillResult.totalCost,              // $16
      fillResult.slippage,               // $17
      fillResult.levelsConsumed,         // $18
      fillResult.marketImpact,           // $19
      fillResult.fees,                   // $20
      latencyMs,                         // $21
      adjustedEntryPrice,                // $22
    ]);

    windowState.tradeId = result.lastInsertRowid;
    stats.tradesPending++;

    log.info('paper_trade_persisted', {
      window_id: windowId,
      trade_id: windowState.tradeId,
    });
  } catch (err) {
    log.error('paper_trade_persist_failed', {
      window_id: windowId,
      error: err.message,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT (T+65s)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handle settlement for a window
 *
 * Reads resolution from window_close_events table and computes P&L.
 *
 * @param {Object} windowState - Window tracking state
 */
async function handleSettlement(windowState) {
  const { windowId, tradeId } = windowState;

  try {
    // If no trade was placed, just cleanup
    if (!tradeId) {
      cleanupWindow(windowId);
      return;
    }

    // Read resolution from window_close_events
    const event = await persistence.get(`
      SELECT resolved_direction, onchain_resolved_direction
      FROM window_close_events
      WHERE window_id = $1
    `, [windowId]);

    // Use on-chain direction if available, else self-resolved
    const resolvedDirection = event?.onchain_resolved_direction || event?.resolved_direction || null;

    if (!resolvedDirection) {
      log.warn('settlement_no_resolution', { window_id: windowId });
      // Try again in 30s
      const retryTimer = setTimeout(() => {
        handleSettlementRetry(windowState).catch(err => {
          if (log) log.warn('settlement_retry_error', { window_id: windowId, error: err.message });
        });
      }, 30000);
      if (retryTimer.unref) retryTimer.unref();
      windowState.timers.push(retryTimer);
      return;
    }

    await settleTradeWithDirection(windowState, resolvedDirection);
  } catch (err) {
    log.error('settlement_failed', { window_id: windowId, error: err.message });
    cleanupWindow(windowId);
  }
}

/**
 * Retry settlement after initial attempt found no resolution
 *
 * @param {Object} windowState - Window state
 */
async function handleSettlementRetry(windowState) {
  const { windowId, tradeId } = windowState;

  if (!tradeId) {
    cleanupWindow(windowId);
    return;
  }

  const event = await persistence.get(`
    SELECT resolved_direction, onchain_resolved_direction
    FROM window_close_events
    WHERE window_id = $1
  `, [windowId]);

  const resolvedDirection = event?.onchain_resolved_direction || event?.resolved_direction || null;

  if (!resolvedDirection) {
    log.warn('settlement_still_no_resolution', { window_id: windowId });
    cleanupWindow(windowId);
    return;
  }

  await settleTradeWithDirection(windowState, resolvedDirection);
}

/**
 * Settle a paper trade with a known resolution direction
 *
 * @param {Object} windowState - Window state
 * @param {string} resolvedDirection - 'up' or 'down'
 */
async function settleTradeWithDirection(windowState, resolvedDirection) {
  const { windowId, tradeId, signalResult } = windowState;

  // Read the trade to get entry details
  const trade = await persistence.get(`
    SELECT entry_side, sim_shares, sim_cost, sim_fee
    FROM paper_trades_v2 WHERE id = $1
  `, [tradeId]);

  if (!trade) {
    log.warn('settlement_trade_not_found', { window_id: windowId, trade_id: tradeId });
    cleanupWindow(windowId);
    return;
  }

  // Determine win/loss
  const won = trade.entry_side === resolvedDirection;
  const shares = parseFloat(trade.sim_shares);
  const cost = parseFloat(trade.sim_cost);
  const fee = parseFloat(trade.sim_fee) || 0;

  // P&L: if won, each share pays $1; if lost, shares worth $0
  const payout = won ? shares * 1.0 : 0;
  const grossPnl = payout - cost;
  const netPnl = grossPnl - fee;

  // Update trade
  await persistence.run(`
    UPDATE paper_trades_v2
    SET settlement_time = NOW(),
        resolved_direction = $1,
        won = $2,
        gross_pnl = $3,
        net_pnl = $4
    WHERE id = $5
  `, [resolvedDirection, won, grossPnl, netPnl, tradeId]);

  // Update stats
  stats.tradesPending = Math.max(0, stats.tradesPending - 1);
  if (won) {
    stats.tradesWon++;
  } else {
    stats.tradesLost++;
  }
  stats.cumulativePnl += netPnl;

  log.info('paper_trade_settled', {
    window_id: windowId,
    trade_id: tradeId,
    entry_side: trade.entry_side,
    resolved_direction: resolvedDirection,
    won,
    shares,
    cost,
    payout,
    gross_pnl: grossPnl,
    net_pnl: netPnl,
    cumulative_pnl: stats.cumulativePnl,
    record: `${stats.tradesWon}W-${stats.tradesLost}L`,
  });

  // Persist settlement book snapshot
  if (signalResult?.entryTokenId) {
    persistBookSnapshot(signalResult.entryTokenId, windowState.crypto, 'settlement', false)
      .catch(() => {});
  }

  cleanupWindow(windowId);
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY PROBING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run a latency probe for a window (at T-90s)
 *
 * @param {Object} windowState - Window state
 */
async function runLatencyProbe(windowState) {
  const { windowId, market } = windowState;

  log.info('latency_probe_start', { window_id: windowId });

  const latencyMs = await latencyMeasurer.probeRestLatency(market.upTokenId);

  log.info('latency_probe_complete', {
    window_id: windowId,
    latency_ms: latencyMs,
    stats: latencyMeasurer.getStats(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PERIODIC L2 SNAPSHOTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Persist periodic L2 snapshots for all subscribed tokens
 *
 * Called every snapshotIntervalMs (5s).
 */
async function persistPeriodicSnapshots() {
  for (const [windowId, ws] of activeWindows) {
    if (!ws.market) continue;

    // Snapshot UP token
    if (ws.market.upTokenId) {
      await persistBookSnapshot(ws.market.upTokenId, ws.crypto, 'periodic', false);
    }
  }
}

/**
 * Persist a book snapshot to l2_book_snapshots table
 *
 * @param {string} tokenId - Token ID
 * @param {string} symbol - Crypto symbol
 * @param {string} snapshotType - 'periodic', 'signal', 'entry', 'settlement'
 * @param {boolean} includeFullBook - Whether to include full bids/asks JSON
 * @returns {Promise<number|null>} Inserted snapshot ID
 */
async function persistBookSnapshot(tokenId, symbol, snapshotType, includeFullBook) {
  try {
    const snapshot = clobWs.getBookSnapshot(tokenId);
    if (!snapshot) return null;

    const fullBookJson = includeFullBook ? JSON.stringify({
      bids: snapshot.bids,
      asks: snapshot.asks,
    }) : null;

    const result = await persistence.runReturningId(`
      INSERT INTO l2_book_snapshots (
        timestamp, token_id, symbol, snapshot_type,
        best_bid, best_ask, mid_price, spread,
        bid_depth_1pct, ask_depth_1pct, full_book_json
      ) VALUES (
        NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
      RETURNING id
    `, [
      tokenId,
      symbol,
      snapshotType,
      snapshot.bestBid,
      snapshot.bestAsk,
      snapshot.mid,
      snapshot.spread,
      snapshot.bidDepth1pct,
      snapshot.askDepth1pct,
      fullBookJson,
    ]);

    stats.snapshotsPersisted++;
    return result.lastInsertRowid;
  } catch (err) {
    stats.snapshotErrors++;
    if (stats.snapshotErrors <= 5 || stats.snapshotErrors % 60 === 0) {
      if (log) {
        log.warn('book_snapshot_persist_failed', {
          token_id: tokenId?.substring(0, 16),
          snapshot_type: snapshotType,
          error: err.message,
          error_count: stats.snapshotErrors,
        });
      }
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clean up a finished window (clear timers, unsubscribe tokens, remove from active map)
 *
 * @param {string} windowId - Window identifier
 */
function cleanupWindow(windowId) {
  const ws = activeWindows.get(windowId);
  if (ws) {
    for (const timer of ws.timers) {
      clearTimeout(timer);
    }
    ws.timers = [];

    // Unsubscribe tokens
    if (ws.market?.upTokenId) {
      clobWs.unsubscribeToken(ws.market.upTokenId);
    }
    if (ws.market?.downTokenId) {
      clobWs.unsubscribeToken(ws.market.downTokenId);
    }

    activeWindows.delete(windowId);
  }
}

// Re-export types
export { PaperTraderError, PaperTraderErrorCodes };
