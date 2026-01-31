/**
 * Take-Profit Module Types and Constants
 *
 * Defines take-profit result types, trigger reasons, and error types.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Take-Profit Error Codes
 */
export const TakeProfitErrorCodes = {
  NOT_INITIALIZED: 'TAKE_PROFIT_NOT_INITIALIZED',
  INVALID_POSITION: 'INVALID_POSITION',
  INVALID_PRICE: 'INVALID_PRICE',
  CONFIG_INVALID: 'TAKE_PROFIT_CONFIG_INVALID',
  EVALUATION_FAILED: 'TAKE_PROFIT_EVALUATION_FAILED',
};

/**
 * Take-Profit Error
 * Extends PolyError with module-specific error codes
 */
export class TakeProfitError extends PolyError {
  /**
   * @param {string} code - Error code from TakeProfitErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'TakeProfitError';
  }
}

/**
 * Trigger reasons for take-profit
 * Note: These are OPPOSITE of stop-loss:
 * - Long: triggered when price RISES above threshold (profit)
 * - Short: triggered when price DROPS below threshold (profit)
 */
export const TriggerReason = {
  PRICE_ABOVE_THRESHOLD: 'price_above_threshold',  // Long position take-profit
  PRICE_BELOW_THRESHOLD: 'price_below_threshold',  // Short position take-profit
  NOT_TRIGGERED: 'not_triggered',
};

/**
 * Create a take-profit evaluation result
 *
 * @param {Object} params - Result parameters
 * @param {boolean} params.triggered - Whether take-profit was triggered
 * @param {number|null} params.position_id - Position ID
 * @param {string} params.window_id - Window identifier
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.entry_price - Position entry price
 * @param {number} params.current_price - Current market price
 * @param {number} params.take_profit_threshold - Calculated threshold
 * @param {number} params.take_profit_pct - Take-profit percentage
 * @param {string} params.reason - TriggerReason value
 * @param {string|null} params.action - 'close' when triggered, null otherwise
 * @param {string|null} params.closeMethod - 'limit' for better fills (unlike stop-loss which uses 'market')
 * @param {number} params.profit_amount - Realized profit if triggered
 * @param {number} params.profit_pct - Profit as percentage of entry
 * @param {string} params.evaluated_at - ISO timestamp
 * @returns {Object} Take-profit result object
 */
export function createTakeProfitResult({
  triggered = false,
  position_id = null,
  window_id = '',
  side = '',
  entry_price = 0,
  current_price = 0,
  take_profit_threshold = 0,
  take_profit_pct = 0,
  reason = TriggerReason.NOT_TRIGGERED,
  action = null,
  closeMethod = null,
  profit_amount = 0,
  profit_pct = 0,
  evaluated_at = '',
} = {}) {
  return {
    triggered,
    position_id,
    window_id,
    side,
    entry_price,
    current_price,
    take_profit_threshold,
    take_profit_pct,
    reason,
    action,
    closeMethod,
    profit_amount,
    profit_pct,
    evaluated_at: evaluated_at || new Date().toISOString(),
  };
}
