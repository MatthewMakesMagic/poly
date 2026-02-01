/**
 * Staleness Detector Module
 *
 * Detects when the oracle is "stale" (hasn't updated despite price movement).
 * Identifies potential trading opportunities where settlement may differ from UI expectations.
 *
 * Key Features:
 * - Staleness detection based on time, divergence, and update likelihood
 * - Score calculation (0-1) for staleness severity
 * - Event subscription for staleness_detected and staleness_resolved
 * - Integration with oracle-tracker, divergence-tracker, and oracle-predictor
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/staleness-detector
 */

import { child } from '../logger/index.js';
import * as oracleTracker from '../oracle-tracker/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';
import { StalenessDetector } from './detector.js';
import {
  StalenessDetectorError,
  StalenessDetectorErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let detector = null;
let config = null;
let evaluationIntervalId = null;

// Optional module references (loaded dynamically)
let divergenceTrackerModule = null;
let oraclePredictorModule = null;

/**
 * Initialize the staleness detector module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.stalenessDetector] - Staleness detector configuration
 * @param {number} [cfg.stalenessDetector.stalenessThresholdMs=15000] - Time since update to be "stale"
 * @param {number} [cfg.stalenessDetector.minDivergencePct=0.001] - 0.1% minimum spread for staleness
 * @param {number} [cfg.stalenessDetector.chainlinkDeviationThresholdPct=0.005] - 0.5% threshold
 * @param {number} [cfg.stalenessDetector.scoreThreshold=0.6] - Score threshold for events
 * @param {number} [cfg.stalenessDetector.evaluationIntervalMs=1000] - Evaluation interval
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Defensive cleanup
  if (evaluationIntervalId) {
    clearInterval(evaluationIntervalId);
    evaluationIntervalId = null;
  }

  // Create child logger
  log = child({ module: 'staleness-detector' });
  log.info('module_init_start');

  // Extract staleness detector config
  const stalenessDetectorConfig = cfg.stalenessDetector || {};
  config = {
    stalenessThresholdMs: stalenessDetectorConfig.stalenessThresholdMs ?? DEFAULT_CONFIG.stalenessThresholdMs,
    minDivergencePct: stalenessDetectorConfig.minDivergencePct ?? DEFAULT_CONFIG.minDivergencePct,
    chainlinkDeviationThresholdPct: stalenessDetectorConfig.chainlinkDeviationThresholdPct ?? DEFAULT_CONFIG.chainlinkDeviationThresholdPct,
    scoreThreshold: stalenessDetectorConfig.scoreThreshold ?? DEFAULT_CONFIG.scoreThreshold,
    evaluationIntervalMs: stalenessDetectorConfig.evaluationIntervalMs ?? DEFAULT_CONFIG.evaluationIntervalMs,
  };

  // Validate config
  validateConfig(config);

  // Create detector instance
  detector = new StalenessDetector({
    config,
    logger: log,
  });

  // Try to load optional modules
  await loadOptionalModules();

  // Setup periodic evaluation
  if (config.evaluationIntervalMs > 0) {
    evaluationIntervalId = setInterval(() => {
      evaluateAllSymbols();
    }, config.evaluationIntervalMs);

    // Allow process to exit even if interval is running
    if (evaluationIntervalId.unref) {
      evaluationIntervalId.unref();
    }
  }

  initialized = true;
  log.info('staleness_detector_initialized', {
    config: {
      stalenessThresholdMs: config.stalenessThresholdMs,
      minDivergencePct: config.minDivergencePct,
      chainlinkDeviationThresholdPct: config.chainlinkDeviationThresholdPct,
      scoreThreshold: config.scoreThreshold,
    },
    divergence_tracker_available: divergenceTrackerModule !== null,
    oracle_predictor_available: oraclePredictorModule !== null,
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Configuration to validate
 * @throws {StalenessDetectorError} If config is invalid
 */
function validateConfig(cfg) {
  if (cfg.stalenessThresholdMs <= 0) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.INVALID_CONFIG,
      'stalenessThresholdMs must be positive',
      { stalenessThresholdMs: cfg.stalenessThresholdMs }
    );
  }

  if (cfg.minDivergencePct < 0 || cfg.minDivergencePct >= cfg.chainlinkDeviationThresholdPct) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.INVALID_CONFIG,
      'minDivergencePct must be non-negative and less than chainlinkDeviationThresholdPct',
      { minDivergencePct: cfg.minDivergencePct, chainlinkDeviationThresholdPct: cfg.chainlinkDeviationThresholdPct }
    );
  }

  if (cfg.scoreThreshold < 0 || cfg.scoreThreshold > 1) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.INVALID_CONFIG,
      'scoreThreshold must be between 0 and 1',
      { scoreThreshold: cfg.scoreThreshold }
    );
  }
}

/**
 * Load optional modules (divergence-tracker, oracle-predictor)
 * These are not required but enhance staleness detection.
 */
async function loadOptionalModules() {
  // Try to load divergence-tracker
  try {
    divergenceTrackerModule = await import('../divergence-tracker/index.js');
    log.info('divergence_tracker_loaded');
  } catch (err) {
    log.warn('divergence_tracker_unavailable', { error: err.message });
    divergenceTrackerModule = null;
  }

  // Try to load oracle-predictor
  try {
    oraclePredictorModule = await import('../oracle-predictor/index.js');
    log.info('oracle_predictor_loaded');
  } catch (err) {
    log.warn('oracle_predictor_unavailable', { error: err.message });
    oraclePredictorModule = null;
  }
}

/**
 * Evaluate staleness for all symbols
 * Called periodically by the evaluation interval.
 */
function evaluateAllSymbols() {
  for (const symbol of SUPPORTED_SYMBOLS) {
    try {
      evaluateSymbol(symbol);
    } catch (err) {
      // Log but don't throw - continue evaluating other symbols
      log.error('evaluation_failed', {
        symbol,
        error: err.message,
      });
    }
  }
}

/**
 * Evaluate staleness for a single symbol
 *
 * @param {string} symbol - Symbol to evaluate
 * @returns {Object|null} Evaluation result or null if data unavailable
 */
function evaluateSymbol(symbol) {
  // Get oracle state
  const oracleState = getOracleState(symbol);
  if (!oracleState) {
    return null;
  }

  // Get divergence data
  const divergence = getDivergence(symbol, oracleState);

  // Get update probability (optional)
  const pNoUpdate = getUpdateProbability(symbol);

  // Evaluate staleness
  const evaluation = detector.evaluateStaleness(symbol, oracleState, divergence, pNoUpdate);

  return evaluation;
}

/**
 * Get oracle state from oracle-tracker
 *
 * @param {string} symbol - Symbol to query
 * @returns {Object|null} Oracle state { price, last_update_at } or null
 */
function getOracleState(symbol) {
  try {
    const state = oracleTracker.getState();
    const tracking = state.tracking?.[symbol];

    if (!tracking || tracking.last_update_at === null) {
      return null;
    }

    return {
      price: tracking.last_price,
      last_update_at: new Date(tracking.last_update_at).getTime(),
    };
  } catch (err) {
    // Oracle tracker not available
    return null;
  }
}

/**
 * Get divergence data from divergence-tracker or fallback
 *
 * @param {string} symbol - Symbol to query
 * @param {Object} oracleState - Oracle state for fallback
 * @returns {Object} Divergence data { ui_price, oracle_price, spread_pct }
 */
function getDivergence(symbol, oracleState) {
  // Try divergence-tracker first
  if (divergenceTrackerModule) {
    try {
      const state = divergenceTrackerModule.getState();
      const spread = state.spreads?.[symbol];

      if (spread && spread.oracle_price !== null) {
        return {
          ui_price: spread.ui_price,
          oracle_price: spread.oracle_price,
          spread_pct: spread.pct || 0,
        };
      }
    } catch {
      // Fallback to oracle-only
    }
  }

  // Fallback: use oracle-only data (no divergence)
  return {
    ui_price: null,
    oracle_price: oracleState.price,
    spread_pct: 0,
  };
}

/**
 * Get update probability from oracle-predictor (optional)
 *
 * @param {string} symbol - Symbol to query
 * @returns {number|null} Probability of no update or null if unavailable
 */
function getUpdateProbability(symbol) {
  if (!oraclePredictorModule) {
    return null;
  }

  try {
    // Look ahead 30 seconds
    const prediction = oraclePredictorModule.getPrediction(symbol, 30000);
    return 1 - prediction.p_update;
  } catch {
    // Predictor not available or insufficient data
    return null;
  }
}

/**
 * Get staleness evaluation for a symbol
 *
 * @param {string} symbol - Symbol to query (btc, eth, sol, xrp)
 * @returns {Object} Full staleness evaluation
 * @throws {StalenessDetectorError} If not initialized or invalid symbol
 */
export function getStaleness(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  // Get fresh evaluation
  const oracleState = getOracleState(symbol);
  if (!oracleState) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.TRACKER_UNAVAILABLE,
      `No oracle data available for ${symbol}`,
      { symbol }
    );
  }

  const divergence = getDivergence(symbol, oracleState);
  const pNoUpdate = getUpdateProbability(symbol);

  return detector.evaluateStaleness(symbol, oracleState, divergence, pNoUpdate);
}

/**
 * Simple boolean check if symbol is stale
 *
 * @param {string} symbol - Symbol to check (btc, eth, sol, xrp)
 * @returns {boolean} True if stale
 * @throws {StalenessDetectorError} If not initialized or invalid symbol
 */
export function isStale(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  try {
    const evaluation = getStaleness(symbol);
    return evaluation.is_stale;
  } catch (err) {
    // If evaluation fails, consider not stale (conservative)
    // Log the error to avoid silent failures
    if (log) {
      log.warn('is_stale_evaluation_failed', {
        symbol,
        error: err.message,
        code: err.code,
      });
    }
    return false;
  }
}

/**
 * Subscribe to staleness events
 *
 * @param {Function} callback - Callback invoked on staleness events
 *   callback receives: { type, symbol, score?, staleness_duration_ms?, ... }
 * @returns {Function} Unsubscribe function
 * @throws {StalenessDetectorError} If not initialized
 */
export function subscribeToStaleness(callback) {
  ensureInitialized();

  if (typeof callback !== 'function') {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.SUBSCRIPTION_FAILED,
      'Callback must be a function'
    );
  }

  return detector.subscribe(callback);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including:
 *   - initialized: boolean
 *   - staleness: { [symbol]: staleness state }
 *   - stats: { staleness_events_emitted, resolutions_detected, avg_staleness_duration_ms }
 *   - config: current configuration
 */
export function getState() {
  if (!initialized || !detector) {
    return {
      initialized: false,
      staleness: {},
      stats: {
        staleness_events_emitted: 0,
        resolutions_detected: 0,
        avg_staleness_duration_ms: 0,
      },
      config: null,
    };
  }

  return {
    initialized: true,
    staleness: detector.getAllStates(),
    stats: detector.getStats(),
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

  // Clear evaluation interval
  if (evaluationIntervalId) {
    clearInterval(evaluationIntervalId);
    evaluationIntervalId = null;
  }

  // Clear detector subscriptions
  if (detector) {
    detector.clearSubscriptions();
    detector = null;
  }

  // Clear module references
  divergenceTrackerModule = null;
  oraclePredictorModule = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}

/**
 * Internal: Ensure module is initialized
 * @throws {StalenessDetectorError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new StalenessDetectorError(
      StalenessDetectorErrorCodes.NOT_INITIALIZED,
      'Staleness detector not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { StalenessDetectorError, StalenessDetectorErrorCodes };
