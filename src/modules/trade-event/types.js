/**
 * Trade Event Module Type Definitions
 *
 * Event types, error codes, and constants for the trade event module.
 */

import { PolyError } from '../../types/index.js';

/**
 * Trade event types
 */
export const TradeEventType = {
  SIGNAL: 'signal',
  ENTRY: 'entry',
  EXIT: 'exit',
  ALERT: 'alert',
  DIVERGENCE: 'divergence',
};

/**
 * Trade event error codes
 */
export const TradeEventErrorCodes = {
  ALREADY_INITIALIZED: 'TRADE_EVENT_ALREADY_INITIALIZED',
  NOT_INITIALIZED: 'TRADE_EVENT_NOT_INITIALIZED',
  INVALID_EVENT_TYPE: 'INVALID_EVENT_TYPE',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  DATABASE_ERROR: 'TRADE_EVENT_DATABASE_ERROR',
};

/**
 * Custom error class for trade event module errors
 */
export class TradeEventError extends PolyError {
  /**
   * @param {string} code - Error code from TradeEventErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'TradeEventError';
  }
}
