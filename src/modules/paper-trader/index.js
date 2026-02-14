/**
 * Paper Trader V2 Module
 *
 * Main coordinator for realistic VWAP edge testing with streaming L2 data.
 * Evaluates a grid of parameter variations (threshold x position size) at
 * multiple signal times (T-10s, T-30s, T-60s, T-90s, T-120s) on every
 * window, so every window produces data across many combos and timings.
 *
 * For each 15-minute window:
 * 1. Subscribe CLOB WS to UP/DOWN tokens
 * 2. Capture VWAP at window open
 * 3. At each signal time: evaluate market state, loop variations, simulate fills
 * 4. At T+65s: settle all trades for the window
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
  variationsFired: 0,
  tradesWon: 0,
  tradesLost: 0,
  tradesPending: 0,
  cumulativePnl: 0,
  snapshotsPersisted: 0,
  snapshotErrors: 0,
};

// Default variations if none configured
const DEFAULT_VARIATIONS = [
  { label: 'base', vwapDeltaThreshold: 75, positionSizeDollars: 100 },
];

// Default signal evaluation times (seconds before window close)
const DEFAULT_SIGNAL_TIMES = [60];

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
    snapshotIntervalMs: ptConfig.snapshotIntervalMs ?? DEFAULT_CONFIG.snapshotIntervalMs,
    scanIntervalMs: ptConfig.scanIntervalMs ?? DEFAULT_CONFIG.scanIntervalMs,
    feeRate: ptConfig.feeRate ?? DEFAULT_CONFIG.feeRate,
    cryptos: ptConfig.cryptos ?? DEFAULT_CONFIG.cryptos,
    signalTimesBeforeCloseSec: ptConfig.signalTimesBeforeCloseSec ?? DEFAULT_SIGNAL_TIMES,
    settlementDelayAfterCloseMs: ptConfig.settlementDelayAfterCloseMs ?? DEFAULT_CONFIG.settlementDelayAfterCloseMs,
    latencyProbeTimeBeforeCloseMs: ptConfig.latencyProbeTimeBeforeCloseMs ?? DEFAULT_CONFIG.latencyProbeTimeBeforeCloseMs,
    variations: ptConfig.variations ?? DEFAULT_VARIATIONS,
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
      cryptos: config.cryptos,
      feeRate: config.feeRate,
      signalTimes: config.signalTimesBeforeCloseSec,
      variationCount: config.variations.length,
      variations: config.variations.map(v => v.label),
      maxTradesPerWindow: config.signalTimesBeforeCloseSec.length * config.variations.length,
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
    config: {
      cryptos: config.cryptos,
      feeRate: config.feeRate,
      signalTimes: config.signalTimesBeforeCloseSec,
      variationCount: config.variations.length,
      variations: config.variations.map(v => `${v.label}(d${v.vwapDeltaThreshold}/$${v.positionSizeDollars})`),
      maxTradesPerWindow: config.signalTimesBeforeCloseSec.length * config.variations.length,
    },
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
    variationsFired: 0,
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
      tradeIds: [],  // Multiple trades (one per fired variation)
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

    // Schedule signal evaluation at each configured time (T-120s, T-90s, T-60s, T-30s, T-10s)
    for (const offsetSec of config.signalTimesBeforeCloseSec) {
      const signalDelay = closeTimeMs - (offsetSec * 1000) - nowMs;
      if (signalDelay > 0) {
        const signalTimer = setTimeout(() => {
          evaluateSignal(windowState, offsetSec).catch(err => {
            if (log) log.error('signal_eval_error', { window_id: windowId, offset_sec: offsetSec, error: err.message });
          });
        }, signalDelay);
        if (signalTimer.unref) signalTimer.unref();
        windowState.timers.push(signalTimer);
      }
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
// SIGNAL EVALUATION — SWEEP ALL VARIATIONS AT EACH SIGNAL TIME
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate all parameter variations for a window at a specific signal time
 *
 * Called once per signal time (T-120s, T-90s, T-60s, T-30s, T-10s).
 * 1. Compute market state once (VWAP vs CLOB)
 * 2. Persist book snapshot once
 * 3. Loop each variation: check threshold, simulate fill at that size, persist trade
 *
 * @param {Object} windowState - Window tracking state
 * @param {number} signalOffsetSec - Seconds before close this eval runs (e.g., 60)
 */
async function evaluateSignal(windowState, signalOffsetSec) {
  const { windowId, crypto, market } = windowState;
  stats.signalsEvaluated++;

  log.info('signal_eval_start', {
    window_id: windowId,
    crypto,
    signal_offset_sec: signalOffsetSec,
    variation_count: config.variations.length,
  });

  // 1. Get live book from CLOB WS
  const upBook = clobWs.getBook(market.upTokenId);
  if (!upBook) {
    log.warn('signal_eval_no_book', { window_id: windowId });
    return;
  }

  // 2. Evaluate market state once
  const marketState = vwapStrategy.evaluateMarketState(windowState, upBook);
  if (!marketState) {
    log.info('signal_eval_no_market_state', {
      window_id: windowId,
      crypto,
      clob_mid: upBook.mid,
    });
    return;
  }

  // Log the market state regardless of whether any variation fires
  log.info('signal_eval_market_state', {
    window_id: windowId,
    vwap_direction: marketState.vwapDirection,
    clob_direction: marketState.clobDirection,
    directions_disagree: marketState.directionsDisagree,
    vwap_delta: marketState.vwapDelta,
    abs_vwap_delta: marketState.absVwapDelta,
    vwap_price: marketState.vwapPrice,
    chainlink_price: marketState.chainlinkPrice,
    clob_up_price: marketState.clobUpPrice,
    exchange_count: marketState.exchangeCount,
  });

  // 3. Persist full book snapshot once (shared across all variations)
  const bookSnapshotId = await persistBookSnapshot(
    marketState.entryTokenId,
    crypto,
    'signal',
    true
  );

  // 4. Probe API latency once
  let latencyMs = null;
  try {
    latencyMs = await latencyMeasurer.probeRestLatency(marketState.entryTokenId);
  } catch (err) {
    log.warn('signal_latency_probe_failed', { error: err.message });
  }

  // 5. Get the entry book for fill simulation
  const entryBook = clobWs.getBook(marketState.entryTokenId);
  if (!entryBook) {
    log.warn('signal_no_entry_book', {
      window_id: windowId,
      entry_token_id: marketState.entryTokenId?.substring(0, 16),
    });
    return;
  }

  // 6. Loop each variation
  let firedCount = 0;
  for (const variation of config.variations) {
    const { label, vwapDeltaThreshold, positionSizeDollars } = variation;

    // Check if this variation's threshold is met
    if (!vwapStrategy.shouldFire(marketState, vwapDeltaThreshold)) {
      continue;
    }

    // Simulate fill at this variation's position size
    const fillResult = simulateFill(entryBook, positionSizeDollars, {
      feeRate: config.feeRate,
    });

    if (!fillResult.success) {
      log.warn('variation_fill_failed', {
        window_id: windowId,
        variant: label,
        position_size: positionSizeDollars,
        unfilled: fillResult.unfilled,
      });
      continue;
    }

    firedCount++;
    stats.variationsFired++;

    const adjustedEntryPrice = fillResult.vwapPrice;

    // Persist paper trade for this variation
    try {
      const result = await persistence.runReturningId(`
        INSERT INTO paper_trades_v2 (
          window_id, symbol, signal_time, signal_type,
          variant_label, position_size_dollars, vwap_delta_threshold,
          signal_offset_sec,
          vwap_direction, clob_direction, vwap_delta, vwap_price, chainlink_price, clob_up_price,
          exchange_count, total_volume,
          entry_side, entry_token_id, entry_book_snapshot_id,
          sim_entry_price, sim_shares, sim_cost, sim_slippage,
          sim_levels_consumed, sim_market_impact, sim_fee,
          latency_ms, adjusted_entry_price
        ) VALUES (
          $1, $2, NOW(), 'vwap_edge',
          $3, $4, $5,
          $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14,
          $15, $16, $17,
          $18, $19, $20, $21,
          $22, $23, $24,
          $25, $26
        )
        RETURNING id
      `, [
        windowId,                          // $1
        crypto,                            // $2
        label,                             // $3
        positionSizeDollars,               // $4
        vwapDeltaThreshold,                // $5
        signalOffsetSec,                   // $6
        marketState.vwapDirection,         // $7
        marketState.clobDirection,          // $8
        marketState.vwapDelta,             // $9
        marketState.vwapPrice,             // $10
        marketState.chainlinkPrice,        // $11
        marketState.clobUpPrice,           // $12
        marketState.exchangeCount,         // $13
        marketState.totalVolume,           // $14
        marketState.entrySide,             // $15
        marketState.entryTokenId,          // $16
        bookSnapshotId,                    // $17
        fillResult.vwapPrice,              // $18
        fillResult.totalShares,            // $19
        fillResult.totalCost,              // $20
        fillResult.slippage,               // $21
        fillResult.levelsConsumed,         // $22
        fillResult.marketImpact,           // $23
        fillResult.fees,                   // $24
        latencyMs,                         // $25
        adjustedEntryPrice,                // $26
      ]);

      windowState.tradeIds.push(result.lastInsertRowid);
      stats.tradesPending++;
    } catch (err) {
      log.error('paper_trade_persist_failed', {
        window_id: windowId,
        variant: label,
        error: err.message,
      });
    }
  }

  log.info('signal_eval_complete', {
    window_id: windowId,
    signal_offset_sec: signalOffsetSec,
    variations_checked: config.variations.length,
    variations_fired: firedCount,
    trade_ids: windowState.tradeIds,
    directions_disagree: marketState.directionsDisagree,
    abs_vwap_delta: marketState.absVwapDelta,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTLEMENT (T+65s) — SETTLE ALL TRADES FOR WINDOW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handle settlement for a window — settles ALL variation trades at once
 */
async function handleSettlement(windowState) {
  const { windowId, tradeIds } = windowState;

  try {
    // If no trades were placed, just cleanup
    if (tradeIds.length === 0) {
      cleanupWindow(windowId);
      return;
    }

    // Read resolution from window_close_events
    const event = await persistence.get(`
      SELECT resolved_direction, onchain_resolved_direction
      FROM window_close_events
      WHERE window_id = $1
    `, [windowId]);

    const resolvedDirection = event?.onchain_resolved_direction || event?.resolved_direction || null;

    if (!resolvedDirection) {
      log.warn('settlement_no_resolution', { window_id: windowId, trade_count: tradeIds.length });
      // Retry in 30s
      const retryTimer = setTimeout(() => {
        handleSettlementRetry(windowState).catch(err => {
          if (log) log.warn('settlement_retry_error', { window_id: windowId, error: err.message });
        });
      }, 30000);
      if (retryTimer.unref) retryTimer.unref();
      windowState.timers.push(retryTimer);
      return;
    }

    await settleAllTrades(windowState, resolvedDirection);
  } catch (err) {
    log.error('settlement_failed', { window_id: windowId, error: err.message });
    cleanupWindow(windowId);
  }
}

/**
 * Retry settlement after initial attempt found no resolution
 */
async function handleSettlementRetry(windowState) {
  const { windowId, tradeIds } = windowState;

  if (tradeIds.length === 0) {
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

  await settleAllTrades(windowState, resolvedDirection);
}

/**
 * Settle all paper trades for a window with a known resolution direction
 */
async function settleAllTrades(windowState, resolvedDirection) {
  const { windowId, tradeIds, crypto } = windowState;

  // Fetch all unsettled trades for this window
  const trades = await persistence.all(`
    SELECT id, entry_side, sim_shares, sim_cost, sim_fee, variant_label
    FROM paper_trades_v2
    WHERE window_id = $1 AND settlement_time IS NULL
  `, [windowId]);

  if (trades.length === 0) {
    log.warn('settlement_no_unsettled_trades', { window_id: windowId });
    cleanupWindow(windowId);
    return;
  }

  let windowWins = 0;
  let windowLosses = 0;
  let windowPnl = 0;

  for (const trade of trades) {
    const won = trade.entry_side === resolvedDirection;
    const shares = parseFloat(trade.sim_shares);
    const cost = parseFloat(trade.sim_cost);
    const fee = parseFloat(trade.sim_fee) || 0;
    const payout = won ? shares * 1.0 : 0;
    const grossPnl = payout - cost;
    const netPnl = grossPnl - fee;

    await persistence.run(`
      UPDATE paper_trades_v2
      SET settlement_time = NOW(),
          resolved_direction = $1,
          won = $2,
          gross_pnl = $3,
          net_pnl = $4
      WHERE id = $5
    `, [resolvedDirection, won, grossPnl, netPnl, trade.id]);

    stats.tradesPending = Math.max(0, stats.tradesPending - 1);
    if (won) {
      stats.tradesWon++;
      windowWins++;
    } else {
      stats.tradesLost++;
      windowLosses++;
    }
    stats.cumulativePnl += netPnl;
    windowPnl += netPnl;
  }

  log.info('window_settled', {
    window_id: windowId,
    resolved_direction: resolvedDirection,
    trades_settled: trades.length,
    variants_settled: trades.map(t => t.variant_label),
    window_wins: windowWins,
    window_losses: windowLosses,
    window_pnl: windowPnl,
    cumulative_pnl: stats.cumulativePnl,
    record: `${stats.tradesWon}W-${stats.tradesLost}L`,
  });

  // Persist settlement book snapshot
  if (windowState.market?.upTokenId) {
    persistBookSnapshot(windowState.market.upTokenId, crypto, 'settlement', false)
      .catch(() => {});
  }

  cleanupWindow(windowId);
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY PROBING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run a latency probe for a window (at T-90s)
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
 */
async function persistPeriodicSnapshots() {
  for (const [windowId, ws] of activeWindows) {
    if (!ws.market) continue;

    if (ws.market.upTokenId) {
      await persistBookSnapshot(ws.market.upTokenId, ws.crypto, 'periodic', false);
    }
  }
}

/**
 * Persist a book snapshot to l2_book_snapshots table
 *
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
 * Clean up a finished window
 */
function cleanupWindow(windowId) {
  const ws = activeWindows.get(windowId);
  if (ws) {
    for (const timer of ws.timers) {
      clearTimeout(timer);
    }
    ws.timers = [];

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
