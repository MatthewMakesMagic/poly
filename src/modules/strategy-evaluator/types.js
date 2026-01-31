/**
 * Strategy Evaluator Types and Constants
 *
 * Defines entry signal types, evaluation results, and error types.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Strategy Evaluator Error Codes
 */
export const StrategyEvaluatorErrorCodes = {
  NOT_INITIALIZED: 'STRATEGY_EVALUATOR_NOT_INITIALIZED',
  VALIDATION_FAILED: 'STRATEGY_VALIDATION_FAILED',
  INVALID_CONFIG: 'STRATEGY_INVALID_CONFIG',
  EVALUATION_FAILED: 'STRATEGY_EVALUATION_FAILED',
};

/**
 * Strategy Evaluator Error
 * Extends PolyError with module-specific error codes
 */
export class StrategyEvaluatorError extends PolyError {
  /**
   * @param {string} code - Error code from StrategyEvaluatorErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'StrategyEvaluatorError';
  }
}

/**
 * Direction values for entry signals
 */
export const Direction = {
  LONG: 'long',
  SHORT: 'short',
};

/**
 * Reasons why a signal was not generated
 */
export const NoSignalReason = {
  INSUFFICIENT_LAG: 'insufficient_lag',
  INSUFFICIENT_TIME: 'insufficient_time',
  LOW_CONFIDENCE: 'low_confidence',
  BELOW_THRESHOLD: 'below_threshold',
  ALREADY_ENTERED_WINDOW: 'already_entered_window',
  CONDITIONS_MET: 'conditions_met',
};

/**
 * Create an entry signal object
 *
 * @param {Object} params - Signal parameters
 * @param {string} params.window_id - Which 15-min window
 * @param {string} params.market_id - Polymarket market identifier
 * @param {string} params.direction - 'long' or 'short'
 * @param {number} params.confidence - 0.0 to 1.0
 * @param {number} params.spot_price - Spot price at signal
 * @param {number} params.market_price - Market price at signal
 * @param {number} params.spot_lag - spot - market (the edge)
 * @param {number} params.spot_lag_pct - Percentage lag
 * @param {number} params.time_remaining_ms - Time until window expiry
 * @returns {Object} Entry signal object
 */
export function createEntrySignal({
  window_id,
  market_id,
  direction,
  confidence,
  spot_price,
  market_price,
  spot_lag,
  spot_lag_pct,
  time_remaining_ms,
  token_id,
  token_id_up,
  token_id_down,
}) {
  return {
    window_id,
    market_id,
    direction,
    confidence,
    spot_price,
    market_price,
    spot_lag,
    spot_lag_pct,
    time_remaining_ms,
    token_id,
    token_id_up,
    token_id_down,
    signal_at: new Date().toISOString(),
  };
}

/**
 * Create an evaluation result object for logging/debugging
 *
 * @param {Object} params - Evaluation parameters
 * @param {string} params.window_id - Window identifier
 * @param {number} params.spot_price - Spot price evaluated
 * @param {number} params.market_price - Market price evaluated
 * @param {number} params.threshold_pct - Threshold percentage used
 * @param {number} params.time_remaining_ms - Time remaining in window
 * @param {boolean} params.signal_generated - Whether a signal was generated
 * @param {string} params.reason - Reason for result
 * @returns {Object} Evaluation result object
 */
export function createEvaluationResult({
  window_id,
  spot_price,
  market_price,
  threshold_pct,
  time_remaining_ms,
  signal_generated,
  reason,
}) {
  return {
    window_id,
    evaluated_at: new Date().toISOString(),
    spot_price,
    market_price,
    threshold_pct,
    time_remaining_ms,
    signal_generated,
    reason,
  };
}
