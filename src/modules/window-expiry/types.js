/**
 * Window-Expiry Module Types and Constants
 *
 * Defines window expiry result types, expiry reasons, and error types.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Window Expiry Error Codes
 */
export const WindowExpiryErrorCodes = {
  NOT_INITIALIZED: 'WINDOW_EXPIRY_NOT_INITIALIZED',
  INVALID_WINDOW_ID: 'INVALID_WINDOW_ID',
  INVALID_POSITION: 'INVALID_POSITION',
  CONFIG_INVALID: 'WINDOW_EXPIRY_CONFIG_INVALID',
  EVALUATION_FAILED: 'WINDOW_EXPIRY_EVALUATION_FAILED',
  RESOLUTION_FAILED: 'WINDOW_RESOLUTION_FAILED',
};

/**
 * Window Expiry Error
 * Extends PolyError with module-specific error codes
 */
export class WindowExpiryError extends PolyError {
  /**
   * @param {string} code - Error code from WindowExpiryErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'WindowExpiryError';
  }
}

/**
 * Expiry/resolution reasons
 */
export const ExpiryReason = {
  WINDOW_EXPIRING: 'window_expiring',      // Warning threshold reached
  WINDOW_RESOLVED: 'window_resolved',      // Window time ended
  SAFE: 'safe',                            // Window has plenty of time
};

/**
 * Resolution outcomes for binary options
 */
export const Resolution = {
  WIN: 'win',   // Position side matched resolution
  LOSE: 'lose', // Position side did not match resolution
};

/**
 * Create a window expiry evaluation result
 *
 * @param {Object} params - Result parameters
 * @param {number|null} params.position_id - Position ID
 * @param {string} params.window_id - Window identifier
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.entry_price - Position entry price
 * @param {number} params.current_price - Current market price
 * @param {string} params.window_start_time - Window start time ISO string
 * @param {string} params.window_end_time - Window end time ISO string
 * @param {number} params.time_remaining_ms - Time remaining in window
 * @param {boolean} params.is_expiring - Whether window is expiring (warning zone)
 * @param {boolean} params.is_resolved - Whether window has resolved
 * @param {string} params.reason - ExpiryReason value
 * @param {number|null} params.resolution_price - Resolution price (0 or 1 for binary)
 * @param {string|null} params.outcome - 'win' or 'lose'
 * @param {number} params.pnl - Realized P&L if resolved
 * @param {number} params.pnl_pct - P&L as percentage of entry
 * @param {string} params.evaluated_at - ISO timestamp
 * @returns {Object} Window expiry result object
 */
export function createWindowExpiryResult({
  position_id = null,
  window_id = '',
  side = '',
  entry_price = 0,
  current_price = 0,
  window_start_time = '',
  window_end_time = '',
  time_remaining_ms = 0,
  is_expiring = false,
  is_resolved = false,
  reason = ExpiryReason.SAFE,
  resolution_price = null,
  outcome = null,
  pnl = 0,
  pnl_pct = 0,
  evaluated_at = '',
} = {}) {
  return {
    position_id,
    window_id,
    side,
    entry_price,
    current_price,
    window_start_time,
    window_end_time,
    time_remaining_ms,
    is_expiring,
    is_resolved,
    reason,
    resolution_price,
    outcome,
    pnl,
    pnl_pct,
    evaluated_at: evaluated_at || new Date().toISOString(),
  };
}
