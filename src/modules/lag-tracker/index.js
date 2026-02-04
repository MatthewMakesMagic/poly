/**
 * Lag Tracker Module
 *
 * Tracks lag between spot (Binance) and oracle (Chainlink) price feeds to:
 * - Calculate cross-correlation at multiple tau values
 * - Identify optimal lag (tau*) with highest correlation
 * - Monitor lag stability over time
 * - Generate signals when lag-based opportunities are detected
 * - Track signal outcomes for validation
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/lag-tracker
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS, TOPICS } from '../../clients/rtds/types.js';
import { LagTracker } from './tracker.js';
import {
  LagTrackerError,
  LagTrackerErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let tracker = null;
let config = null;
let unsubscribers = [];
let flushIntervalId = null;

// Statistics
let stats = {
  signalsLogged: 0,
  batchesInserted: 0,
  insertErrors: 0,
  lastFlushAt: null,
};

/**
 * Initialize the lag tracker module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.lagTracker] - Lag tracker configuration
 * @param {number} [cfg.lagTracker.bufferMaxAgeMs=60000] - Max age of price buffer
 * @param {number} [cfg.lagTracker.bufferMaxSize=2000] - Max size of price buffer
 * @param {number[]} [cfg.lagTracker.tauValues] - Tau values to test
 * @param {number} [cfg.lagTracker.minMoveMagnitude=0.001] - Min move for signal
 * @param {number} [cfg.lagTracker.minCorrelation=0.5] - Min correlation for signal
 * @param {number} [cfg.lagTracker.significanceThreshold=0.05] - P-value threshold
 * @param {number} [cfg.lagTracker.bufferSize=10] - Flush after N signals
 * @param {number} [cfg.lagTracker.flushIntervalMs=1000] - Flush interval
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Defensive cleanup
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Create child logger
  log = child({ module: 'lag-tracker' });
  log.info('module_init_start');

  // Extract lag tracker config
  const lagTrackerConfig = cfg.lagTracker || {};
  config = {
    bufferMaxAgeMs: lagTrackerConfig.bufferMaxAgeMs ?? DEFAULT_CONFIG.bufferMaxAgeMs,
    bufferMaxSize: lagTrackerConfig.bufferMaxSize ?? DEFAULT_CONFIG.bufferMaxSize,
    tauValues: lagTrackerConfig.tauValues ?? DEFAULT_CONFIG.tauValues,
    minMoveMagnitude: lagTrackerConfig.minMoveMagnitude ?? DEFAULT_CONFIG.minMoveMagnitude,
    minCorrelation: lagTrackerConfig.minCorrelation ?? DEFAULT_CONFIG.minCorrelation,
    significanceThreshold: lagTrackerConfig.significanceThreshold ?? DEFAULT_CONFIG.significanceThreshold,
    stabilityWindowSize: lagTrackerConfig.stabilityWindowSize ?? DEFAULT_CONFIG.stabilityWindowSize,
    stabilityThreshold: lagTrackerConfig.stabilityThreshold ?? DEFAULT_CONFIG.stabilityThreshold,
    bufferSize: lagTrackerConfig.bufferSize ?? DEFAULT_CONFIG.bufferSize,
    flushIntervalMs: lagTrackerConfig.flushIntervalMs ?? DEFAULT_CONFIG.flushIntervalMs,
    maxBufferSize: lagTrackerConfig.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize,
    staleThresholdMs: lagTrackerConfig.staleThresholdMs ?? DEFAULT_CONFIG.staleThresholdMs,
  };

  // Create tracker instance
  tracker = new LagTracker({
    ...config,
    logger: log,
  });

  // Subscribe to RTDS client for all symbols
  for (const symbol of SUPPORTED_SYMBOLS) {
    const unsubscribe = rtdsClient.subscribe(symbol, (tick) => {
      try {
        // Route to appropriate handler based on topic
        if (tick.topic === TOPICS.CRYPTO_PRICES) {
          tracker.handleSpotTick(tick);
        } else if (tick.topic === TOPICS.CRYPTO_PRICES_CHAINLINK) {
          tracker.handleOracleTick(tick);
        }
      } catch (err) {
        // Log and continue - don't let tick errors crash the subscription
        if (log) {
          log.error('tick_handler_error', {
            error: err.message,
            symbol: tick?.symbol,
            topic: tick?.topic,
          });
        }
      }
    });
    unsubscribers.push(unsubscribe);
  }

  // Setup flush interval
  // V3: flushBuffer is async, fire-and-forget with error logging
  if (config.flushIntervalMs > 0) {
    flushIntervalId = setInterval(() => {
      flushBuffer().catch(err => {
        log.error('interval_flush_failed', { error: err.message });
      });
    }, config.flushIntervalMs);

    // Allow process to exit even if interval is running
    if (flushIntervalId.unref) {
      flushIntervalId.unref();
    }
  }

  initialized = true;
  log.info('lag_tracker_initialized', {
    config: {
      bufferMaxAgeMs: config.bufferMaxAgeMs,
      bufferMaxSize: config.bufferMaxSize,
      tauValues: config.tauValues,
      minCorrelation: config.minCorrelation,
      significanceThreshold: config.significanceThreshold,
    },
  });
}

/**
 * Flush signal buffer to database
 *
 * V3 Philosophy: Uses async PostgreSQL transaction API.
 *
 * @returns {Promise<void>}
 */
async function flushBuffer() {
  // Get pending signals from tracker
  const pendingSignals = tracker.getPendingSignals();

  if (pendingSignals.length === 0) {
    return;
  }

  // Filter signals that have outcomes recorded (ready for persistence)
  const readySignals = pendingSignals.filter(s => s.outcome_direction !== null);

  if (readySignals.length === 0) {
    return;
  }

  const startTime = Date.now();

  try {
    const insertSQL = `
      INSERT INTO lag_signals (
        timestamp, symbol, spot_price_at_signal, spot_move_direction, spot_move_magnitude,
        oracle_price_at_signal, predicted_direction, predicted_tau_ms, correlation_at_tau,
        window_id, outcome_direction, prediction_correct, pnl
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `;

    await persistence.transaction(async (client) => {
      for (const signal of readySignals) {
        await client.run(insertSQL, [
          signal.timestamp,
          signal.symbol,
          signal.spot_price,
          signal.spot_move_magnitude > 0 ? 'up' : 'down',
          signal.spot_move_magnitude,
          signal.oracle_price,
          signal.direction,
          signal.tau_ms,
          signal.correlation,
          signal.window_id || null,
          signal.outcome_direction,
          signal.prediction_correct,
          signal.pnl,
        ]);
      }
    });

    // Clear persisted signals from tracker
    tracker.clearPersistedSignals(readySignals.map(s => s.id));

    const durationMs = Date.now() - startTime;
    stats.signalsLogged += readySignals.length;
    stats.batchesInserted++;
    stats.lastFlushAt = new Date().toISOString();

    log.info('buffer_flushed', { signal_count: readySignals.length, duration_ms: durationMs });
  } catch (err) {
    stats.insertErrors++;
    log.error('persistence_failed', {
      error_code: LagTrackerErrorCodes.PERSISTENCE_ERROR,
      error: err.message,
      signal_count: readySignals.length,
    });
    // Signals remain in tracker for retry on next flush cycle
  }
}

/**
 * Analyze lag for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {number} [windowMs] - Optional analysis window size
 * @returns {Object|null} Analysis results: { tau_star_ms, correlation, p_value, significant }
 * @throws {LagTrackerError} If not initialized or invalid symbol
 */
export function analyze(symbol, windowMs) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new LagTrackerError(
      LagTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  return tracker.analyze(symbol, windowMs);
}

/**
 * Get current lag signal for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Object} Signal object: { has_signal, direction, tau_ms, correlation, confidence }
 * @throws {LagTrackerError} If not initialized or invalid symbol
 */
export function getLagSignal(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new LagTrackerError(
      LagTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  return tracker.getLagSignal(symbol);
}

/**
 * Get stability metrics for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol
 * @returns {Object} Stability: { stable, tau_history, variance }
 * @throws {LagTrackerError} If not initialized or invalid symbol
 */
export function getStability(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new LagTrackerError(
      LagTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  return tracker.getStability(symbol);
}

/**
 * Record outcome for a signal
 *
 * @param {number} signalId - Signal ID
 * @param {Object} outcome - { outcome_direction, pnl }
 * @throws {LagTrackerError} If not initialized
 */
export function recordOutcome(signalId, outcome) {
  ensureInitialized();
  tracker.recordOutcome(signalId, outcome);
}

/**
 * Get accuracy statistics
 *
 * @returns {Object} Accuracy: { total_signals, total_correct, accuracy }
 * @throws {LagTrackerError} If not initialized
 */
export function getAccuracyStats() {
  ensureInitialized();
  return tracker.getAccuracyStats();
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized || !tracker) {
    return {
      initialized: false,
      buffers: {},
      analysis: {},
      stability: {},
      signals: { pending_count: 0, total_generated: 0, total_correct: 0 },
      config: null,
    };
  }

  const trackerState = tracker.getState();

  return {
    initialized: true,
    buffers: trackerState.buffers,
    analysis: trackerState.analysis,
    stability: trackerState.stability,
    signals: trackerState.signals,
    module_stats: {
      signals_logged: stats.signalsLogged,
      batches_inserted: stats.batchesInserted,
      insert_errors: stats.insertErrors,
      last_flush_at: stats.lastFlushAt,
    },
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

  // Clear flush interval
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Unsubscribe from RTDS
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors
    }
  }
  unsubscribers = [];

  // V3: Await async flushBuffer()
  if (tracker) {
    await flushBuffer();
    tracker = null;
  }

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
  stats = {
    signalsLogged: 0,
    batchesInserted: 0,
    insertErrors: 0,
    lastFlushAt: null,
  };
}

/**
 * Internal: Ensure module is initialized
 * @throws {LagTrackerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new LagTrackerError(
      LagTrackerErrorCodes.NOT_INITIALIZED,
      'Lag tracker not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { LagTrackerError, LagTrackerErrorCodes };
