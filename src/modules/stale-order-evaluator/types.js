/**
 * Stale Order Evaluator Types
 *
 * Defines types and constants for stale order evaluation.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Stale Order Evaluator Error Codes
 */
export const StaleOrderErrorCodes = {
  NOT_INITIALIZED: 'STALE_ORDER_NOT_INITIALIZED',
  EVALUATION_FAILED: 'STALE_ORDER_EVALUATION_FAILED',
  CANCEL_FAILED: 'STALE_ORDER_CANCEL_FAILED',
};

/**
 * Stale Order Evaluator Error
 */
export class StaleOrderError extends PolyError {
  /**
   * @param {string} code - Error code from StaleOrderErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'StaleOrderError';
  }
}

/**
 * Reasons an order can be considered stale
 */
export const StaleReason = {
  EDGE_BELOW_THRESHOLD: 'edge_below_threshold',
  EDGE_REVERSED: 'edge_reversed',
  WINDOW_EXPIRED: 'window_expired',
  WINDOW_NOT_FOUND: 'window_not_found',
  PRICE_DATA_UNAVAILABLE: 'price_data_unavailable',
};

/**
 * Default configuration
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  // Use same threshold as entry - order is stale if current edge < this
  minEdgeThreshold: 0.10,
  // Cancel if edge reversed (went from positive to negative)
  cancelOnEdgeReversal: true,
  // Cancel if window is no longer in active windows list
  cancelOnWindowExpired: true,
};
