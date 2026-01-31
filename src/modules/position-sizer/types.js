/**
 * Position Sizer Types and Constants
 *
 * Defines sizing result types, adjustment reasons, and error types.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Position Sizer Error Codes
 */
export const PositionSizerErrorCodes = {
  NOT_INITIALIZED: 'POSITION_SIZER_NOT_INITIALIZED',
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  ORDERBOOK_FETCH_FAILED: 'ORDERBOOK_FETCH_FAILED',
  CONFIG_INVALID: 'CONFIG_INVALID',
};

/**
 * Position Sizer Error
 * Extends PolyError with module-specific error codes
 */
export class PositionSizerError extends PolyError {
  /**
   * @param {string} code - Error code from PositionSizerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'PositionSizerError';
  }
}

/**
 * Adjustment reasons for sizing decisions
 */
export const AdjustmentReason = {
  NO_ADJUSTMENT: 'no_adjustment',
  LIQUIDITY_LIMITED: 'liquidity_limited',
  EXPOSURE_CAPPED: 'exposure_capped',
  POSITION_LIMIT_CAPPED: 'position_limit_capped',
  BELOW_MINIMUM: 'below_minimum',
  REJECTED: 'rejected',
};

/**
 * Rejection codes for failed sizing attempts
 */
export const RejectionCode = {
  EXPOSURE_CAP_EXCEEDED: 'EXPOSURE_CAP_EXCEEDED',
  INSUFFICIENT_LIQUIDITY: 'INSUFFICIENT_LIQUIDITY',
  BELOW_MINIMUM_SIZE: 'BELOW_MINIMUM_SIZE',
};

/**
 * Create a sizing result object
 *
 * @param {Object} params - Sizing result parameters
 * @param {boolean} params.success - Whether a valid size was calculated
 * @param {number} params.requested_size - Original desired size (dollars)
 * @param {number} params.actual_size - Final size after adjustments (dollars)
 * @param {string} params.adjustment_reason - Why size was adjusted (AdjustmentReason)
 * @param {string} [params.rejection_code] - Code if rejected (RejectionCode)
 * @param {string} params.window_id - Window identifier
 * @param {string} params.market_id - Market identifier
 * @param {string} params.token_id - Token identifier
 * @param {string} params.direction - 'long' or 'short'
 * @param {number} params.confidence - Signal confidence (0.0-1.0)
 * @param {number} params.available_liquidity - Orderbook depth available
 * @param {number} params.estimated_slippage - Expected slippage at this size
 * @param {number} params.current_exposure - Total exposure before this trade
 * @param {number} params.exposure_headroom - Room left under max exposure
 * @returns {Object} Sizing result object
 */
export function createSizingResult({
  success,
  requested_size,
  actual_size,
  adjustment_reason,
  rejection_code = null,
  window_id,
  market_id,
  token_id,
  direction,
  confidence,
  available_liquidity,
  estimated_slippage,
  current_exposure,
  exposure_headroom,
}) {
  return {
    success,
    requested_size,
    actual_size,
    adjustment_reason,
    rejection_code,
    window_id,
    market_id,
    token_id,
    direction,
    confidence,
    available_liquidity,
    estimated_slippage,
    current_exposure,
    exposure_headroom,
    sized_at: new Date().toISOString(),
  };
}

/**
 * Create a liquidity analysis result
 *
 * @param {Object} params - Liquidity analysis parameters
 * @param {number} params.availableLiquidity - Total liquidity available within slippage
 * @param {number} params.estimatedSlippage - Estimated slippage percentage
 * @param {number} params.depthAtPrice - Number of orderbook levels
 * @param {string} [params.error] - Error message if fetch failed
 * @returns {Object} Liquidity analysis result
 */
export function createLiquidityResult({
  availableLiquidity,
  estimatedSlippage,
  depthAtPrice,
  error = null,
}) {
  return {
    availableLiquidity,
    estimatedSlippage,
    depthAtPrice,
    error,
  };
}
