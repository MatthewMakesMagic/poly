/**
 * Window Close Event Recorder Module
 *
 * Captures price data around Polymarket 15-minute window closes for
 * Edge 2 analysis: oracle resolution pattern discovery.
 *
 * For each active window, this module:
 * 1. Starts capture 90 seconds before close
 * 2. Records oracle/feed/market prices at 60s, 30s, 10s, 5s, 1s before close
 * 3. Records all feed prices at close
 * 4. Attempts to capture resolution outcome with retry
 * 5. Detects "surprise" resolutions (market consensus wrong)
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * V3 Philosophy Implementation - Stage 3: Data Capture Running
 *
 * @module modules/window-close-event-recorder
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';
import * as windowManager from '../window-manager/index.js';
import {
  WindowCloseEventRecorderError,
  WindowCloseEventRecorderErrorCodes,
  DEFAULT_CONFIG,
  WINDOW_DURATION_SECONDS,
  SUPPORTED_CRYPTOS,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let config = null;

// Active window captures: Map<windowId, WindowCaptureState>
let activeCaptures = new Map();

// Timers for scheduling
let scanIntervalId = null;

// Statistics
let stats = {
  windowsCaptured: 0,
  windowsFailed: 0,
  resolutionsRecorded: 0,
  resolutionTimeouts: 0,
  capturesInProgress: 0,
};

/**
 * Initialize the window close event recorder module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.windowCloseEventRecorder] - Module configuration
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  log = child({ module: 'window-close-event-recorder' });
  log.info('module_init_start');

  const recorderConfig = cfg.windowCloseEventRecorder || {};
  config = {
    captureStartBeforeCloseMs: recorderConfig.captureStartBeforeCloseMs ?? DEFAULT_CONFIG.captureStartBeforeCloseMs,
    captureIntervalsMs: recorderConfig.captureIntervalsMs ?? DEFAULT_CONFIG.captureIntervalsMs,
    resolutionFirstAttemptDelayMs: recorderConfig.resolutionFirstAttemptDelayMs ?? DEFAULT_CONFIG.resolutionFirstAttemptDelayMs,
    resolutionRetryIntervalMs: recorderConfig.resolutionRetryIntervalMs ?? DEFAULT_CONFIG.resolutionRetryIntervalMs,
    resolutionMaxWaitMs: recorderConfig.resolutionMaxWaitMs ?? DEFAULT_CONFIG.resolutionMaxWaitMs,
    surpriseThresholdConfidence: recorderConfig.surpriseThresholdConfidence ?? DEFAULT_CONFIG.surpriseThresholdConfidence,
    maxSampleRatePerSecond: recorderConfig.maxSampleRatePerSecond ?? DEFAULT_CONFIG.maxSampleRatePerSecond,
  };

  // Scan for upcoming windows every 10 seconds
  scanIntervalId = setInterval(() => {
    scanForUpcomingWindows().catch(err => {
      log.error('scan_failed', { error: err.message });
    });
  }, 10000);

  if (scanIntervalId.unref) {
    scanIntervalId.unref();
  }

  // Initial scan
  await scanForUpcomingWindows();

  initialized = true;
  log.info('window_close_event_recorder_initialized', { config });
}

/**
 * Scan for windows approaching close and schedule captures
 *
 * @returns {Promise<void>}
 */
async function scanForUpcomingWindows() {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  for (const crypto of SUPPORTED_CRYPTOS) {
    // Calculate current window epoch and close time
    const currentEpoch = Math.floor(nowSec / WINDOW_DURATION_SECONDS) * WINDOW_DURATION_SECONDS;
    const closeTimeSec = currentEpoch + WINDOW_DURATION_SECONDS;
    const closeTimeMs = closeTimeSec * 1000;
    const timeToCloseMs = closeTimeMs - nowMs;
    const windowId = `${crypto}-15m-${currentEpoch}`;

    // If within capture window and not already capturing
    if (timeToCloseMs > 0 && timeToCloseMs <= config.captureStartBeforeCloseMs && !activeCaptures.has(windowId)) {
      startCapture(windowId, crypto, currentEpoch, closeTimeMs);
    }
  }
}

/**
 * Start capturing data for a window
 *
 * @param {string} windowId - Window identifier
 * @param {string} symbol - Crypto symbol
 * @param {number} epoch - Window start epoch in seconds
 * @param {number} closeTimeMs - Window close time in ms
 */
function startCapture(windowId, symbol, epoch, closeTimeMs) {
  if (activeCaptures.has(windowId)) {
    return;
  }

  log.info('capture_started', { window_id: windowId, symbol, close_time: new Date(closeTimeMs).toISOString() });

  const capture = {
    windowId,
    symbol,
    epoch,
    closeTimeMs,
    strikePrice: null,
    oraclePrices: {},
    feedPricesAtClose: {},
    marketUpPrices: {},
    marketDownPrices: {},
    captureStarted: true,
    captureComplete: false,
    resolvedDirection: null,
    timers: [],
  };

  activeCaptures.set(windowId, capture);
  stats.capturesInProgress++;

  // Schedule price captures at each interval
  scheduleIntervalCaptures(capture);

  // Schedule close-time capture
  scheduleCloseCapture(capture);
}

/**
 * Schedule price captures at defined intervals before close
 *
 * @param {Object} capture - Capture state object
 */
function scheduleIntervalCaptures(capture) {
  const nowMs = Date.now();

  for (const intervalMs of config.captureIntervalsMs) {
    const captureTimeMs = capture.closeTimeMs - intervalMs;
    const delayMs = captureTimeMs - nowMs;

    if (delayMs > 0) {
      const timer = setTimeout(() => {
        captureIntervalPrices(capture, intervalMs).catch(err => {
          log.warn('interval_capture_failed', {
            window_id: capture.windowId,
            interval_ms: intervalMs,
            error: err.message,
          });
        });
      }, delayMs);

      if (timer.unref) {
        timer.unref();
      }
      capture.timers.push(timer);
    } else if (delayMs > -1000) {
      // Just missed it (within 1 second), capture now
      captureIntervalPrices(capture, intervalMs).catch(err => {
        log.warn('interval_capture_failed', {
          window_id: capture.windowId,
          interval_ms: intervalMs,
          error: err.message,
        });
      });
    }
  }
}

/**
 * Capture prices at a specific interval before close
 *
 * @param {Object} capture - Capture state object
 * @param {number} intervalMs - Interval in ms before close
 * @returns {Promise<void>}
 */
async function captureIntervalPrices(capture, intervalMs) {
  const intervalLabel = `${intervalMs / 1000}s`;

  // Capture oracle price (Chainlink)
  const oracleData = rtdsClient.getCurrentPrice(capture.symbol, TOPICS.CRYPTO_PRICES_CHAINLINK);
  if (oracleData) {
    capture.oraclePrices[intervalMs] = oracleData.price;
  }

  // Capture market prices (UP/DOWN tokens) via window-manager
  try {
    const market = await windowManager.fetchMarket(capture.symbol, capture.epoch);
    if (market) {
      capture.marketUpPrices[intervalMs] = market.upPrice;
      capture.marketDownPrices[intervalMs] = market.downPrice;

      // Capture strike price if we don't have it yet
      if (capture.strikePrice === null && market.referencePrice) {
        capture.strikePrice = market.referencePrice;
      }
    }
  } catch (err) {
    log.debug('market_fetch_failed_at_interval', {
      window_id: capture.windowId,
      interval: intervalLabel,
      error: err.message,
    });
  }

  log.info('interval_captured', {
    window_id: capture.windowId,
    interval: intervalLabel,
    oracle_price: capture.oraclePrices[intervalMs] ?? null,
    market_up: capture.marketUpPrices[intervalMs] ?? null,
    market_down: capture.marketDownPrices[intervalMs] ?? null,
  });
}

/**
 * Schedule the close-time capture and resolution tracking
 *
 * @param {Object} capture - Capture state object
 */
function scheduleCloseCapture(capture) {
  const nowMs = Date.now();
  const delayMs = Math.max(0, capture.closeTimeMs - nowMs);

  const timer = setTimeout(() => {
    captureAtClose(capture).catch(err => {
      log.error('close_capture_failed', {
        window_id: capture.windowId,
        error: err.message,
      });
    });
  }, delayMs);

  if (timer.unref) {
    timer.unref();
  }
  capture.timers.push(timer);
}

/**
 * Capture all feed prices at window close and start resolution tracking
 *
 * @param {Object} capture - Capture state object
 * @returns {Promise<void>}
 */
async function captureAtClose(capture) {
  log.info('close_capture_started', { window_id: capture.windowId });

  // Capture oracle price at close (Chainlink)
  const oracleData = rtdsClient.getCurrentPrice(capture.symbol, TOPICS.CRYPTO_PRICES_CHAINLINK);
  if (oracleData) {
    capture.oraclePrices.close = oracleData.price;
  }

  // Capture Binance price at close
  const binanceData = rtdsClient.getCurrentPrice(capture.symbol, TOPICS.CRYPTO_PRICES);
  if (binanceData) {
    capture.feedPricesAtClose.binance = binanceData.price;
  }

  // Chainlink at close is same as oracle
  if (oracleData) {
    capture.feedPricesAtClose.chainlink = oracleData.price;
  }

  // Capture final market prices
  try {
    const market = await windowManager.fetchMarket(capture.symbol, capture.epoch);
    if (market) {
      capture.marketUpPrices.close = market.upPrice;
      capture.marketDownPrices.close = market.downPrice;

      if (capture.strikePrice === null && market.referencePrice) {
        capture.strikePrice = market.referencePrice;
      }
    }
  } catch (err) {
    log.debug('market_fetch_failed_at_close', {
      window_id: capture.windowId,
      error: err.message,
    });
  }

  log.info('close_captured', {
    window_id: capture.windowId,
    oracle_price: capture.oraclePrices.close ?? null,
    binance_price: capture.feedPricesAtClose.binance ?? null,
  });

  // Start resolution tracking
  scheduleResolutionCapture(capture);
}

/**
 * Schedule resolution capture with retry logic
 *
 * @param {Object} capture - Capture state object
 */
function scheduleResolutionCapture(capture) {
  const firstAttemptTimer = setTimeout(() => {
    attemptResolutionCapture(capture, 0).catch(err => {
      log.error('resolution_capture_error', {
        window_id: capture.windowId,
        error: err.message,
      });
    });
  }, config.resolutionFirstAttemptDelayMs);

  if (firstAttemptTimer.unref) {
    firstAttemptTimer.unref();
  }
  capture.timers.push(firstAttemptTimer);
}

/**
 * Attempt to capture window resolution
 *
 * Checks if the market has resolved and records the outcome.
 * Retries every 10s for up to 60s if not resolved yet.
 *
 * @param {Object} capture - Capture state object
 * @param {number} elapsedMs - Time elapsed since first attempt
 * @returns {Promise<void>}
 */
async function attemptResolutionCapture(capture, elapsedMs) {
  try {
    const market = await windowManager.fetchMarket(capture.symbol, capture.epoch);

    if (market && market.closed) {
      // Market has resolved
      const resolvedDirection = determineResolution(capture, market);
      capture.resolvedDirection = resolvedDirection;

      log.info('resolution_captured', {
        window_id: capture.windowId,
        resolved_direction: resolvedDirection,
        elapsed_ms: elapsedMs,
      });

      await persistWindowCloseEvent(capture);
      return;
    }
  } catch (err) {
    log.warn('resolution_check_failed', {
      window_id: capture.windowId,
      elapsed_ms: elapsedMs,
      error: err.message,
    });
  }

  // Not resolved yet - retry if within max wait
  if (elapsedMs + config.resolutionRetryIntervalMs <= config.resolutionMaxWaitMs) {
    const retryTimer = setTimeout(() => {
      attemptResolutionCapture(capture, elapsedMs + config.resolutionRetryIntervalMs).catch(err => {
        log.error('resolution_retry_error', {
          window_id: capture.windowId,
          error: err.message,
        });
      });
    }, config.resolutionRetryIntervalMs);

    if (retryTimer.unref) {
      retryTimer.unref();
    }
    capture.timers.push(retryTimer);
  } else {
    // Timed out waiting for resolution
    stats.resolutionTimeouts++;
    log.error('resolution_timeout', {
      window_id: capture.windowId,
      max_wait_ms: config.resolutionMaxWaitMs,
    });

    // Still persist what we have (without resolution)
    await persistWindowCloseEvent(capture);
  }
}

/**
 * Determine resolved direction from market data
 *
 * For Polymarket binary windows:
 * - If oracle price > strike: resolved UP
 * - If oracle price <= strike: resolved DOWN
 *
 * @param {Object} capture - Capture state object
 * @param {Object} market - Market data from window-manager
 * @returns {string|null} 'up', 'down', or null
 */
function determineResolution(capture, market) {
  const oraclePrice = capture.oraclePrices.close;
  const strike = capture.strikePrice;

  if (oraclePrice != null && strike != null) {
    return oraclePrice > strike ? 'up' : 'down';
  }

  // If we can determine from market prices (UP token near 1 = resolved up)
  if (market.upPrice > 0.9) {
    return 'up';
  }
  if (market.downPrice > 0.9) {
    return 'down';
  }

  return null;
}

/**
 * Calculate market consensus and detect surprise resolutions
 *
 * Uses the last captured UP token price as market consensus.
 * If consensus > surpriseThreshold and resolution disagrees, it's a surprise.
 *
 * @param {Object} capture - Capture state object
 * @returns {{ direction: string|null, confidence: number, isSurprise: boolean }}
 */
function calculateMarketConsensus(capture) {
  // Use 1-second-before-close UP price as market consensus
  const upPrice1s = capture.marketUpPrices[1000] ?? capture.marketUpPrices[5000] ?? null;

  if (upPrice1s === null) {
    return { direction: null, confidence: 0, isSurprise: false };
  }

  const consensusDirection = upPrice1s > 0.5 ? 'up' : 'down';
  const confidence = Math.max(upPrice1s, 1 - upPrice1s); // How confident the market is

  const isSurprise = (
    capture.resolvedDirection !== null &&
    confidence >= config.surpriseThresholdConfidence &&
    consensusDirection !== capture.resolvedDirection
  );

  return { direction: consensusDirection, confidence, isSurprise };
}

/**
 * Persist the window close event to database
 *
 * V3 Philosophy: Uses async PostgreSQL API.
 * Upserts on window_id to handle re-captures gracefully.
 *
 * @param {Object} capture - Capture state object
 * @returns {Promise<void>}
 */
async function persistWindowCloseEvent(capture) {
  const consensus = calculateMarketConsensus(capture);

  const closeTimeISO = new Date(capture.closeTimeMs).toISOString();
  const resolutionTimeISO = capture.resolvedDirection ? new Date().toISOString() : null;

  try {
    await persistence.run(`
      INSERT INTO window_close_events (
        window_id, symbol, window_close_time, oracle_resolution_time,
        oracle_price_60s_before, oracle_price_30s_before, oracle_price_10s_before,
        oracle_price_5s_before, oracle_price_1s_before, oracle_price_at_close,
        binance_price_at_close, pyth_price_at_close, chainlink_price_at_close,
        polymarket_binance_at_close,
        market_up_price_60s, market_up_price_30s, market_up_price_10s,
        market_up_price_5s, market_up_price_1s,
        market_down_price_60s, market_down_price_30s, market_down_price_10s,
        market_down_price_5s, market_down_price_1s,
        strike_price, resolved_direction,
        market_consensus_direction, market_consensus_confidence, surprise_resolution
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24,
        $25, $26, $27, $28, $29
      )
      ON CONFLICT (window_id) DO UPDATE SET
        oracle_resolution_time = COALESCE(EXCLUDED.oracle_resolution_time, window_close_events.oracle_resolution_time),
        oracle_price_60s_before = COALESCE(EXCLUDED.oracle_price_60s_before, window_close_events.oracle_price_60s_before),
        oracle_price_30s_before = COALESCE(EXCLUDED.oracle_price_30s_before, window_close_events.oracle_price_30s_before),
        oracle_price_10s_before = COALESCE(EXCLUDED.oracle_price_10s_before, window_close_events.oracle_price_10s_before),
        oracle_price_5s_before = COALESCE(EXCLUDED.oracle_price_5s_before, window_close_events.oracle_price_5s_before),
        oracle_price_1s_before = COALESCE(EXCLUDED.oracle_price_1s_before, window_close_events.oracle_price_1s_before),
        oracle_price_at_close = COALESCE(EXCLUDED.oracle_price_at_close, window_close_events.oracle_price_at_close),
        resolved_direction = COALESCE(EXCLUDED.resolved_direction, window_close_events.resolved_direction),
        market_consensus_direction = COALESCE(EXCLUDED.market_consensus_direction, window_close_events.market_consensus_direction),
        market_consensus_confidence = COALESCE(EXCLUDED.market_consensus_confidence, window_close_events.market_consensus_confidence),
        surprise_resolution = COALESCE(EXCLUDED.surprise_resolution, window_close_events.surprise_resolution),
        updated_at = NOW()
    `, [
      capture.windowId,                                          // $1
      capture.symbol,                                            // $2
      closeTimeISO,                                              // $3
      resolutionTimeISO,                                         // $4
      capture.oraclePrices[60000] ?? null,                       // $5
      capture.oraclePrices[30000] ?? null,                       // $6
      capture.oraclePrices[10000] ?? null,                       // $7
      capture.oraclePrices[5000] ?? null,                        // $8
      capture.oraclePrices[1000] ?? null,                        // $9
      capture.oraclePrices.close ?? null,                        // $10
      capture.feedPricesAtClose.binance ?? null,                 // $11
      capture.feedPricesAtClose.pyth ?? null,                    // $12
      capture.feedPricesAtClose.chainlink ?? null,               // $13
      capture.feedPricesAtClose.polymarket_binance ?? null,      // $14
      capture.marketUpPrices[60000] ?? null,                     // $15
      capture.marketUpPrices[30000] ?? null,                     // $16
      capture.marketUpPrices[10000] ?? null,                     // $17
      capture.marketUpPrices[5000] ?? null,                      // $18
      capture.marketUpPrices[1000] ?? null,                      // $19
      capture.marketDownPrices[60000] ?? null,                   // $20
      capture.marketDownPrices[30000] ?? null,                   // $21
      capture.marketDownPrices[10000] ?? null,                   // $22
      capture.marketDownPrices[5000] ?? null,                    // $23
      capture.marketDownPrices[1000] ?? null,                    // $24
      capture.strikePrice ?? 0,                                  // $25
      capture.resolvedDirection,                                 // $26
      consensus.direction,                                       // $27
      consensus.confidence,                                      // $28
      consensus.isSurprise,                                      // $29
    ]);

    capture.captureComplete = true;
    stats.windowsCaptured++;
    stats.capturesInProgress = Math.max(0, stats.capturesInProgress - 1);

    if (capture.resolvedDirection) {
      stats.resolutionsRecorded++;
    }

    log.info('window_close_event_persisted', {
      window_id: capture.windowId,
      symbol: capture.symbol,
      resolved_direction: capture.resolvedDirection,
      surprise: consensus.isSurprise,
    });

    // Cleanup active capture
    cleanupCapture(capture.windowId);

  } catch (err) {
    stats.windowsFailed++;
    stats.capturesInProgress = Math.max(0, stats.capturesInProgress - 1);

    log.error('persist_failed', {
      window_id: capture.windowId,
      error: err.message,
    });

    throw new WindowCloseEventRecorderError(
      WindowCloseEventRecorderErrorCodes.DATABASE_ERROR,
      `Failed to persist window close event: ${err.message}`,
      { windowId: capture.windowId }
    );
  }
}

/**
 * Cleanup a finished capture (clear timers, remove from active map)
 *
 * @param {string} windowId - Window identifier
 */
function cleanupCapture(windowId) {
  const capture = activeCaptures.get(windowId);
  if (capture) {
    for (const timer of capture.timers) {
      clearTimeout(timer);
    }
    capture.timers = [];
    activeCaptures.delete(windowId);
  }
}

/**
 * Get current module state
 *
 * V3 Philosophy: Returns only in-memory state (no DB queries).
 *
 * @returns {Object} Module state
 */
export function getState() {
  if (!initialized) {
    return {
      initialized: false,
      stats: {
        windows_captured: 0,
        windows_failed: 0,
        resolutions_recorded: 0,
        resolution_timeouts: 0,
        captures_in_progress: 0,
      },
      activeCaptures: [],
      config: null,
    };
  }

  return {
    initialized: true,
    stats: {
      windows_captured: stats.windowsCaptured,
      windows_failed: stats.windowsFailed,
      resolutions_recorded: stats.resolutionsRecorded,
      resolution_timeouts: stats.resolutionTimeouts,
      captures_in_progress: stats.capturesInProgress,
    },
    activeCaptures: Array.from(activeCaptures.keys()),
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

  // Clear scan interval
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }

  // Clear all active capture timers
  for (const [windowId] of activeCaptures) {
    cleanupCapture(windowId);
  }
  activeCaptures = new Map();

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  stats = {
    windowsCaptured: 0,
    windowsFailed: 0,
    resolutionsRecorded: 0,
    resolutionTimeouts: 0,
    capturesInProgress: 0,
  };
}

/**
 * Internal: Ensure module is initialized
 * @throws {WindowCloseEventRecorderError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new WindowCloseEventRecorderError(
      WindowCloseEventRecorderErrorCodes.NOT_INITIALIZED,
      'Window close event recorder not initialized. Call init() first.'
    );
  }
}

// Re-export types
export { WindowCloseEventRecorderError, WindowCloseEventRecorderErrorCodes };

// Export internal functions for testing
export const _testing = {
  scanForUpcomingWindows,
  startCapture,
  captureIntervalPrices,
  captureAtClose,
  attemptResolutionCapture,
  determineResolution,
  calculateMarketConsensus,
  persistWindowCloseEvent,
  cleanupCapture,
  getActiveCaptures: () => activeCaptures,
  getStats: () => stats,
};
