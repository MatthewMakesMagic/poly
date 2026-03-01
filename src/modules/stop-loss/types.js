/**
 * Stop-Loss Module Types and Constants
 *
 * Defines stop-loss result types, trigger reasons, and error types.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Stop-Loss Error Codes
 */
export const StopLossErrorCodes = {
  NOT_INITIALIZED: 'STOP_LOSS_NOT_INITIALIZED',
  INVALID_POSITION: 'INVALID_POSITION',
  INVALID_PRICE: 'INVALID_PRICE',
  CONFIG_INVALID: 'STOP_LOSS_CONFIG_INVALID',
  EVALUATION_FAILED: 'STOP_LOSS_EVALUATION_FAILED',
};

/**
 * Stop-Loss Error
 * Extends PolyError with module-specific error codes
 */
export class StopLossError extends PolyError {
  /**
   * @param {string} code - Error code from StopLossErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'StopLossError';
  }
}

/**
 * Trigger reasons for stop-loss
 */
export const TriggerReason = {
  PRICE_BELOW_THRESHOLD: 'price_below_threshold',  // Long position (entry-relative)
  PRICE_ABOVE_THRESHOLD: 'price_above_threshold',  // Short position (entry-relative)
  PRICE_BELOW_FLOOR: 'price_below_floor',           // Long position (absolute floor)
  PRICE_ABOVE_CEILING: 'price_above_ceiling',       // Short position (absolute ceiling)
  NOT_TRIGGERED: 'not_triggered',
};

/**
 * Create a stop-loss evaluation result
 *
 * @param {Object} params - Result parameters
 * @param {boolean} params.triggered - Whether stop-loss was triggered
 * @param {number|null} params.position_id - Position ID
 * @param {string} params.window_id - Window identifier
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.entry_price - Position entry price
 * @param {number} params.current_price - Current market price
 * @param {number} params.stop_loss_threshold - Calculated threshold
 * @param {number} params.stop_loss_pct - Stop-loss percentage
 * @param {string} params.reason - TriggerReason value
 * @param {string|null} params.action - 'close' when triggered, null otherwise
 * @param {string|null} params.closeMethod - 'market' for immediate exit
 * @param {number} params.loss_amount - Potential loss if triggered
 * @param {number} params.loss_pct - Loss as percentage of entry
 * @param {string} params.evaluated_at - ISO timestamp
 * @returns {Object} Stop-loss result object
 */
export function createStopLossResult({
  triggered = false,
  position_id = null,
  window_id = '',
  side = '',
  entry_price = 0,
  current_price = 0,
  stop_loss_threshold = 0,
  stop_loss_pct = 0,
  reason = TriggerReason.NOT_TRIGGERED,
  action = null,
  closeMethod = null,
  loss_amount = 0,
  loss_pct = 0,
  evaluated_at = '',
} = {}) {
  return {
    triggered,
    position_id,
    window_id,
    side,
    entry_price,
    current_price,
    stop_loss_threshold,
    stop_loss_pct,
    reason,
    action,
    closeMethod,
    loss_amount,
    loss_pct,
    evaluated_at: evaluated_at || new Date().toISOString(),
  };
}
