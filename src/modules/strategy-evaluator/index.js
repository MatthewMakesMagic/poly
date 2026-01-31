/**
 * Strategy Evaluator Module
 *
 * Public interface for entry condition evaluation.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Evaluate entry conditions against real-time market state
 * - Generate entry signals when conditions are met
 * - Silent operation when no signal (FR24)
 * - Multi-window evaluation support
 *
 * @module modules/strategy-evaluator
 */

import { child } from '../logger/index.js';
import { StrategyEvaluatorError, StrategyEvaluatorErrorCodes } from './types.js';
import { evaluateEntry } from './entry-logic.js';
import { getStats, recordEvaluation, recordSignal, resetState } from './state.js';

// Module state
let log = null;
let config = null;
let thresholds = null;
let initialized = false;

// Default thresholds if not specified in config
const DEFAULT_THRESHOLDS = {
  spotLagThresholdPct: 0.02,   // 2% lag required to enter
  minConfidence: 0.6,          // Minimum confidence to enter
  minTimeRemainingMs: 60000,   // 1 minute minimum
};

/**
 * Initialize the strategy evaluator module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.strategy] - Strategy configuration
 * @param {Object} [cfg.strategy.entry] - Entry thresholds
 * @param {number} [cfg.strategy.entry.spotLagThresholdPct] - Minimum lag percentage
 * @param {number} [cfg.strategy.entry.minConfidence] - Minimum confidence
 * @param {Object} [cfg.trading] - Trading configuration
 * @param {number} [cfg.trading.minTimeRemainingMs] - Minimum time remaining
 * @returns {Promise<void>}
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'strategy-evaluator' });
  config = cfg;

  log.info('module_init_start');

  // Extract and validate thresholds
  const entryConfig = cfg?.strategy?.entry || {};
  const tradingConfig = cfg?.trading || {};

  thresholds = {
    spotLagThresholdPct: entryConfig.spotLagThresholdPct ?? DEFAULT_THRESHOLDS.spotLagThresholdPct,
    minConfidence: entryConfig.minConfidence ?? DEFAULT_THRESHOLDS.minConfidence,
    minTimeRemainingMs: tradingConfig.minTimeRemainingMs ?? DEFAULT_THRESHOLDS.minTimeRemainingMs,
  };

  // Validate thresholds
  validateThresholds(thresholds);

  initialized = true;
  log.info('module_initialized', {
    thresholds: {
      spot_lag_threshold_pct: thresholds.spotLagThresholdPct,
      min_confidence: thresholds.minConfidence,
      min_time_remaining_ms: thresholds.minTimeRemainingMs,
    },
  });
}

/**
 * Validate threshold configuration
 *
 * @param {Object} thresholds - Threshold values to validate
 * @throws {StrategyEvaluatorError} If validation fails
 * @private
 */
function validateThresholds(thresholds) {
  const { spotLagThresholdPct, minConfidence, minTimeRemainingMs } = thresholds;

  if (typeof spotLagThresholdPct !== 'number' || spotLagThresholdPct <= 0 || spotLagThresholdPct >= 1) {
    throw new StrategyEvaluatorError(
      StrategyEvaluatorErrorCodes.INVALID_CONFIG,
      'spotLagThresholdPct must be a number between 0 and 1 (exclusive)',
      { spotLagThresholdPct }
    );
  }

  if (typeof minConfidence !== 'number' || minConfidence < 0 || minConfidence > 1) {
    throw new StrategyEvaluatorError(
      StrategyEvaluatorErrorCodes.INVALID_CONFIG,
      'minConfidence must be a number between 0 and 1',
      { minConfidence }
    );
  }

  if (typeof minTimeRemainingMs !== 'number' || minTimeRemainingMs < 0) {
    throw new StrategyEvaluatorError(
      StrategyEvaluatorErrorCodes.INVALID_CONFIG,
      'minTimeRemainingMs must be a non-negative number',
      { minTimeRemainingMs }
    );
  }
}

/**
 * Evaluate entry conditions for multiple windows
 *
 * @param {Object} marketState - Current market state
 * @param {number} marketState.spot_price - Current spot price
 * @param {Array} marketState.windows - Active windows to evaluate
 * @param {string} marketState.windows[].window_id - Window identifier
 * @param {string} marketState.windows[].market_id - Market identifier
 * @param {number} marketState.windows[].market_price - Market price for window
 * @param {number} marketState.windows[].time_remaining_ms - Time remaining
 * @returns {Array} Array of entry signals (empty if no conditions met)
 */
export function evaluateEntryConditions(marketState) {
  ensureInitialized();

  const { spot_price, windows = [] } = marketState;

  // Handle empty windows gracefully (silent operation)
  if (windows.length === 0) {
    return [];
  }

  const signals = [];

  for (const window of windows) {
    recordEvaluation();

    const { signal } = evaluateEntry({
      window_id: window.window_id,
      market_id: window.market_id,
      spot_price,
      market_price: window.market_price,
      time_remaining_ms: window.time_remaining_ms,
      thresholds,
      log,
    });

    if (signal) {
      recordSignal();
      signals.push(signal);
    }
  }

  return signals;
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including initialization status and stats
 */
export function getState() {
  return {
    initialized,
    thresholds: thresholds ? {
      spot_lag_threshold_pct: thresholds.spotLagThresholdPct,
      min_confidence: thresholds.minConfidence,
      min_time_remaining_ms: thresholds.minTimeRemainingMs,
    } : null,
    ...getStats(),
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

  // Reset state
  resetState();

  config = null;
  thresholds = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {StrategyEvaluatorError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new StrategyEvaluatorError(
      StrategyEvaluatorErrorCodes.NOT_INITIALIZED,
      'Strategy evaluator not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  StrategyEvaluatorError,
  StrategyEvaluatorErrorCodes,
  Direction,
  NoSignalReason,
} from './types.js';
