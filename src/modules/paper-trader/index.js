/**
 * Paper Trader V2 Module — Multi-Strategy, Multi-Asset
 *
 * Main coordinator for paper trading across 10 strategies, 4 instruments,
 * and 5 signal timings. Evaluates a grid of strategy × variation at each
 * signal time on every window.
 *
 * For each 15-minute window:
 * 1. Subscribe CLOB WS to UP/DOWN tokens
 * 2. Capture VWAP (composite, CoinGecko, VWAP20) at window open from DB
 * 3. At each signal time: build context, loop strategies + variations, simulate fills
 * 4. At T+65s: settle all trades for the window
 *
 * @module modules/paper-trader
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as clobWs from '../../clients/clob-ws/index.js';
import * as windowManager from '../window-manager/index.js';
import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import * as coingeckoClient from '../../clients/coingecko/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';
import { simulateFill } from './fill-simulator.js';
import * as latencyMeasurer from './latency-measurer.js';
import * as tickRecorder from './tick-recorder.js';
import { strategies } from './strategy-registry.js';
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
  windowsWon: 0,
  windowsLost: 0,
};

// Default variations if none configured
const DEFAULT_VARIATIONS = [
  { label: 'pct-3-sm', vwapDeltaThresholdPct: 0.03, positionSizeDollars: 100 },
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
    strategyVariations: ptConfig.strategyVariations ?? {},
  };

  // Initialize CLOB WS client (non-fatal — WS connects in background)
  try {
    await clobWs.init(cfg);
  } catch (err) {
    log.warn('clob_ws_init_failed_non_fatal', { error: err.message });
  }

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

  // Initial scan (non-fatal — will retry on interval)
  try {
    await scanAndTrack();
  } catch (err) {
    log.warn('initial_scan_failed_non_fatal', { error: err.message });
  }

  initialized = true;

  // Count total strategy × variation combos
  let totalVariations = 0;
  for (const s of strategies) {
    const vars = config.strategyVariations[s.name] || config.variations;
    totalVariations += vars.length;
  }

  console.log(
    `[paper-trader] initialized OK — ${strategies.length} strategies, ` +
    `${config.cryptos.length} cryptos, ` +
    `${config.signalTimesBeforeCloseSec.length} signal times, ` +
    `~${totalVariations} variations/signal`
  );
  log.info('paper_trader_initialized', {
    config: {
      cryptos: config.cryptos,
      feeRate: config.feeRate,
      signalTimes: config.signalTimesBeforeCloseSec,
      strategyCount: strategies.length,
      strategyNames: strategies.map(s => s.name),
      totalVariations,
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

  const totalWindows = stats.windowsWon + stats.windowsLost;
  const windowWinRate = totalWindows > 0
    ? ((stats.windowsWon / totalWindows) * 100).toFixed(1)
    : null;

  return {
    initialized: true,
    activeWindows: Array.from(activeWindows.keys()),
    clobWs: clobWs.getState(),
    latencyStats: latencyMeasurer.getStats(),
    tickRecorder: tickRecorder.getStats(),
    stats: { ...stats, windowWinRate },
    config: {
      cryptos: config.cryptos,
      feeRate: config.feeRate,
      signalTimes: config.signalTimesBeforeCloseSec,
      strategyCount: strategies.length,
      strategyNames: strategies.map(s => s.name),
      variationCount: config.variations.length,
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

  // Flush tick recorder buffers before cleanup
  await tickRecorder.flushAll();

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
    windowsWon: 0,
    windowsLost: 0,
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
      log.warn('market_fetch_failed', { crypto, epoch: currentEpoch, error: err.message });
      continue;
    }

    if (!market || !market.upTokenId) continue;

    // Subscribe CLOB WS to both UP and DOWN tokens
    clobWs.subscribeToken(market.upTokenId, `${crypto}-UP`);
    if (market.downTokenId) {
      clobWs.subscribeToken(market.downTokenId, `${crypto}-DOWN`);
    }

    // Start continuous L2 tick recording
    tickRecorder.startRecording(market.upTokenId, crypto, windowId, clobWs);
    if (market.downTokenId) {
      tickRecorder.startRecording(market.downTokenId, crypto, windowId, clobWs);
    }

    // Capture all open prices from DB — composite VWAP, CoinGecko, and VWAP20
    let vwapAtOpen = null;
    let cgAtOpen = null;
    let vwap20AtOpen = null;
    let vwapSource = 'none';

    try {
      const row = await persistence.get(`
        SELECT composite_vwap, coingecko_price, exchange_detail
        FROM vwap_snapshots
        WHERE symbol = $1
          AND timestamp >= to_timestamp($2) - interval '5 seconds'
          AND timestamp <= to_timestamp($2) + interval '5 seconds'
        ORDER BY ABS(EXTRACT(EPOCH FROM timestamp) - $2)
        LIMIT 1
      `, [crypto, currentEpoch]);

      if (row) {
        if (row.composite_vwap != null) {
          vwapAtOpen = parseFloat(row.composite_vwap);
          vwapSource = 'db';
        }
        if (row.coingecko_price != null) {
          cgAtOpen = parseFloat(row.coingecko_price);
        }
        // Recompute VWAP20 from exchange_detail JSONB (excluding LBank)
        if (row.exchange_detail) {
          try {
            const detail = typeof row.exchange_detail === 'string'
              ? JSON.parse(row.exchange_detail)
              : row.exchange_detail;
            let pv = 0, v = 0;
            for (const [exchange, data] of Object.entries(detail)) {
              if (exchange.toLowerCase() === 'lbank') continue;
              if (data.vwap && data.volume) {
                pv += data.vwap * data.volume;
                v += data.volume;
              }
            }
            if (v > 0) {
              vwap20AtOpen = pv / v;
            }
          } catch {
            // exchange_detail parse failed — non-fatal
          }
        }
      }
    } catch (err) {
      log.warn('vwap_at_open_db_query_failed', { window_id: windowId, error: err.message });
    }

    // Fallback to live VWAP only if DB had no data
    if (vwapAtOpen == null) {
      try {
        const composite = exchangeTradeCollector.getCompositeVWAP(crypto);
        if (composite) {
          vwapAtOpen = composite.vwap;
          vwapSource = 'live_fallback';
        }
      } catch (err) {
        log.warn('vwap_open_fallback_failed', { window_id: windowId, crypto, error: err.message });
      }
    }

    // Fallback for CG at open
    if (cgAtOpen == null) {
      try {
        const cgData = coingeckoClient.getCurrentPrice(crypto);
        if (cgData) cgAtOpen = cgData.price;
      } catch (err) {
        log.warn('cg_open_fallback_failed', { window_id: windowId, crypto, error: err.message });
      }
    }

    // Fallback for VWAP20 at open
    if (vwap20AtOpen == null) {
      try {
        const vwap20 = exchangeTradeCollector.getVWAP20(crypto);
        if (vwap20) vwap20AtOpen = vwap20.vwap;
      } catch (err) {
        log.warn('vwap20_open_fallback_failed', { window_id: windowId, crypto, error: err.message });
      }
    }

    // Create window state
    const windowState = {
      windowId,
      crypto,
      epoch: currentEpoch,
      closeTimeMs,
      market,
      vwapAtOpen,
      cgAtOpen,
      vwap20AtOpen,
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
      cg_at_open: cgAtOpen,
      vwap20_at_open: vwap20AtOpen,
      vwap_source: vwapSource,
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
// SIGNAL EVALUATION — MULTI-STRATEGY SWEEP AT EACH SIGNAL TIME
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate all strategies and their variations for a window at a specific signal time
 *
 * Called once per signal time (T-120s, T-90s, T-60s, T-30s, T-10s).
 * 1. Build strategy context (VWAP sources, CLOB book, Chainlink)
 * 2. Loop each strategy in registry
 * 3. For each: check appliesTo, evaluate market state, loop variations
 * 4. For each firing variation: simulate fill, persist trade
 *
 * @param {Object} windowState - Window tracking state
 * @param {number} signalOffsetSec - Seconds before close this eval runs (e.g., 60)
 */
async function evaluateSignal(windowState, signalOffsetSec) {
  const { windowId, crypto, market } = windowState;
  stats.signalsEvaluated++;

  // 1. Get live book from CLOB WS
  const upBook = clobWs.getBook(market.upTokenId);
  if (!upBook) {
    log.warn('signal_eval_no_book', { window_id: windowId, crypto });
    return;
  }

  // 2. Gather all VWAP sources
  let compositeVwap = null;
  try {
    compositeVwap = exchangeTradeCollector.getCompositeVWAP(crypto);
  } catch (err) {
    log.warn('vwap_composite_fetch_failed', { window_id: windowId, crypto, error: err.message });
  }

  let coingeckoPrice = null;
  try {
    const cgData = coingeckoClient.getCurrentPrice(crypto);
    if (cgData) coingeckoPrice = cgData;
  } catch (err) {
    log.warn('coingecko_fetch_failed', { window_id: windowId, crypto, error: err.message });
  }

  let vwap20 = null;
  try {
    vwap20 = exchangeTradeCollector.getVWAP20(crypto);
  } catch (err) {
    log.warn('vwap20_fetch_failed', { window_id: windowId, crypto, error: err.message });
  }

  let chainlinkPrice = null;
  try {
    const clData = rtdsClient.getCurrentPrice(crypto, TOPICS.CRYPTO_PRICES_CHAINLINK);
    if (clData) chainlinkPrice = clData.price;
  } catch (err) {
    log.warn('chainlink_fetch_failed', { window_id: windowId, crypto, error: err.message });
  }

  // 3. Build strategy context
  const ctx = {
    windowState,
    upBook,
    signalOffsetSec,
    vwapSources: {
      composite: compositeVwap,
      coingecko: coingeckoPrice,
      vwap20: vwap20,
    },
    openPrices: {
      composite: windowState.vwapAtOpen,
      coingecko: windowState.cgAtOpen,
      vwap20: windowState.vwap20AtOpen,
    },
    chainlinkPrice,
  };

  // Cache for book snapshots and latency probes per entryTokenId
  const bookSnapshotCache = new Map();
  const latencyCache = new Map();
  const entryBookCache = new Map();

  let totalFired = 0;
  let strategiesEvaluated = 0;

  // 4. Loop each strategy
  for (const strategy of strategies) {
    // Check if strategy applies to this crypto/timing
    if (!strategy.appliesTo(crypto, signalOffsetSec)) continue;

    // Evaluate market state
    const marketState = strategy.evaluateMarketState(ctx);
    if (!marketState) continue;

    strategiesEvaluated++;

    // Get variations for this strategy
    const variations = config.strategyVariations[strategy.name] || config.variations;

    // Loop variations
    for (const variation of variations) {
      if (!strategy.shouldFire(marketState, variation)) continue;

      const { entryTokenId } = marketState;
      const { positionSizeDollars, label } = variation;

      // Guard: entryTokenId must exist (DOWN tokens can be null for some markets)
      if (!entryTokenId) {
        log.warn('signal_eval_null_entry_token', {
          window_id: windowId,
          crypto,
          strategy: strategy.name,
          entry_side: marketState.entrySide,
          variant: label,
        });
        continue;
      }

      // Get/cache book snapshot for this entryTokenId
      if (!bookSnapshotCache.has(entryTokenId)) {
        const snapId = await persistBookSnapshot(entryTokenId, crypto, 'signal', true);
        bookSnapshotCache.set(entryTokenId, snapId);
      }
      const bookSnapshotId = bookSnapshotCache.get(entryTokenId);

      // Get/cache latency probe for this entryTokenId
      if (!latencyCache.has(entryTokenId)) {
        let latMs = null;
        try {
          latMs = await latencyMeasurer.probeRestLatency(entryTokenId);
        } catch (err) {
          log.warn('latency_probe_failed', { window_id: windowId, token_id: entryTokenId?.substring(0, 16), error: err.message });
        }
        latencyCache.set(entryTokenId, latMs);
      }
      const latencyMs = latencyCache.get(entryTokenId);

      // Get/cache entry book for this entryTokenId
      if (!entryBookCache.has(entryTokenId)) {
        entryBookCache.set(entryTokenId, clobWs.getBook(entryTokenId));
      }
      const entryBook = entryBookCache.get(entryTokenId);

      if (!entryBook) continue;

      // Simulate fill
      const fillResult = simulateFill(entryBook, positionSizeDollars, {
        feeRate: config.feeRate,
      });

      if (!fillResult.success) continue;

      totalFired++;
      stats.variationsFired++;

      // Build strategy metadata
      const strategyMetadata = {};
      if (marketState.vwapSource) strategyMetadata.vwapSource = marketState.vwapSource;
      if (marketState.vwapDeltaPct != null) strategyMetadata.vwapDeltaPct = marketState.vwapDeltaPct;
      if (marketState.stalenessMs != null) strategyMetadata.stalenessMs = marketState.stalenessMs;
      if (marketState.imbalanceRatio != null) strategyMetadata.imbalanceRatio = marketState.imbalanceRatio;
      // Compute CLOB conviction (distance from fair value) for all strategies
      if (marketState.clobUpPrice != null) {
        strategyMetadata.clobConviction = Math.abs(marketState.clobUpPrice - 0.50);
      }
      if (marketState.agreeingSignals) strategyMetadata.agreeingSignals = marketState.agreeingSignals.map(s => s.name);
      if (marketState.spread != null) strategyMetadata.spread = marketState.spread;

      const vwapSourceLabel = marketState.vwapSource || 'composite';

      // Persist paper trade
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
            latency_ms, adjusted_entry_price,
            strategy_metadata, vwap_source
          ) VALUES (
            $1, $2, NOW(), $3,
            $4, $5, $6,
            $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15,
            $16, $17, $18,
            $19, $20, $21, $22,
            $23, $24, $25,
            $26, $27,
            $28, $29
          )
          ON CONFLICT (window_id, signal_type, signal_offset_sec, variant_label) DO NOTHING
          RETURNING id
        `, [
          windowId,                                // $1
          crypto,                                  // $2
          strategy.name,                           // $3 signal_type
          label,                                   // $4
          positionSizeDollars,                     // $5
          marketState.absVwapDeltaPct ?? marketState.vwapDeltaPct ?? null, // $6
          signalOffsetSec,                         // $7
          marketState.vwapDirection ?? null,        // $8
          marketState.clobDirection ?? null,        // $9
          marketState.vwapDelta ?? null,            // $10
          marketState.vwapPrice ?? null,            // $11
          marketState.chainlinkPrice ?? null,       // $12
          marketState.clobUpPrice ?? null,          // $13
          marketState.exchangeCount ?? null,        // $14
          marketState.totalVolume ?? null,          // $15
          marketState.entrySide,                   // $16
          marketState.entryTokenId,                // $17
          bookSnapshotId,                          // $18
          fillResult.vwapPrice,                    // $19
          fillResult.totalShares,                  // $20
          fillResult.totalCost,                    // $21
          fillResult.slippage,                     // $22
          fillResult.levelsConsumed,               // $23
          fillResult.marketImpact,                 // $24
          fillResult.fees,                         // $25
          latencyMs,                               // $26
          fillResult.vwapPrice,                    // $27 adjusted_entry_price
          JSON.stringify(strategyMetadata),         // $28 strategy_metadata
          vwapSourceLabel,                         // $29 vwap_source
        ]);

        if (result.lastInsertRowid) {
          windowState.tradeIds.push(result.lastInsertRowid);
          stats.tradesPending++;
        }
      } catch (err) {
        log.error('paper_trade_persist_failed', {
          window_id: windowId,
          strategy: strategy.name,
          variant: label,
          error: err.message,
        });
      }
    }
  }

  if (totalFired > 0 || strategiesEvaluated > 0) {
    log.info('signal_eval_complete', {
      window_id: windowId,
      crypto,
      signal_offset_sec: signalOffsetSec,
      strategies_evaluated: strategiesEvaluated,
      variations_fired: totalFired,
      clob_mid: upBook.mid,
    });
  }
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
    SELECT id, entry_side, sim_shares, sim_cost, sim_fee, variant_label, signal_type
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

  // Window-level aggregation: group by strategy, check if any trade won per strategy
  const byStrategy = new Map();
  for (const trade of trades) {
    const key = trade.signal_type;
    if (!byStrategy.has(key)) byStrategy.set(key, { anyWon: false });
    if (trade.entry_side === resolvedDirection) byStrategy.get(key).anyWon = true;
  }
  for (const [, result] of byStrategy) {
    if (result.anyWon) {
      stats.windowsWon++;
    } else {
      stats.windowsLost++;
    }
  }

  const totalWindows = stats.windowsWon + stats.windowsLost;
  const windowWinRate = totalWindows > 0
    ? ((stats.windowsWon / totalWindows) * 100).toFixed(1)
    : null;

  log.info('window_settled', {
    window_id: windowId,
    resolved_direction: resolvedDirection,
    trades_settled: trades.length,
    window_wins: windowWins,
    window_losses: windowLosses,
    window_pnl: windowPnl,
    cumulative_pnl: stats.cumulativePnl,
    record: `${stats.tradesWon}W-${stats.tradesLost}L`,
    cumulative_window_record: `${stats.windowsWon}W-${stats.windowsLost}L`,
    window_win_rate: windowWinRate,
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
async function cleanupWindow(windowId) {
  const ws = activeWindows.get(windowId);
  if (ws) {
    for (const timer of ws.timers) {
      clearTimeout(timer);
    }
    ws.timers = [];

    // Stop tick recording before unsubscribing (flushes remaining buffer)
    if (ws.market?.upTokenId) {
      await tickRecorder.stopRecording(ws.market.upTokenId);
    }
    if (ws.market?.downTokenId) {
      await tickRecorder.stopRecording(ws.market.downTokenId);
    }

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
