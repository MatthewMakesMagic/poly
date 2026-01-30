/**
 * Polymarket Client Types
 *
 * Type definitions and error classes for the Polymarket client module.
 * Extends PolyError from src/types/errors.js for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Polymarket-specific error codes
 */
export const PolymarketErrorCodes = {
  CONNECTION_FAILED: 'POLYMARKET_CONNECTION_FAILED',
  AUTH_FAILED: 'POLYMARKET_AUTH_FAILED',
  RATE_LIMITED: 'POLYMARKET_RATE_LIMITED',
  INVALID_RESPONSE: 'POLYMARKET_INVALID_RESPONSE',
  ORDER_REJECTED: 'POLYMARKET_ORDER_REJECTED',
  INSUFFICIENT_BALANCE: 'POLYMARKET_INSUFFICIENT_BALANCE',
  INVALID_PRICE: 'POLYMARKET_INVALID_PRICE',
  INVALID_SIZE: 'POLYMARKET_INVALID_SIZE',
  NOT_INITIALIZED: 'POLYMARKET_NOT_INITIALIZED',
};

/**
 * Polymarket-specific error class
 * Extends PolyError for consistent error handling across the system.
 */
export class PolymarketError extends PolyError {
  /**
   * @param {string} code - Error code from PolymarketErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'PolymarketError';
  }
}

/**
 * Side enum matching Polymarket's API
 */
export const Side = {
  BUY: 0,
  SELL: 1,
};

/**
 * Order type enum
 */
export const OrderType = {
  GTC: 'GTC', // Good till cancelled
  GTD: 'GTD', // Good till date
  FOK: 'FOK', // Fill or kill
  IOC: 'IOC', // Immediate or cancel
};

/**
 * Client state structure
 * @typedef {Object} PolymarketClientState
 * @property {boolean} initialized - Whether client is initialized
 * @property {string|null} address - Wallet address
 * @property {string|null} funder - Funder address
 * @property {boolean} ready - Whether client is ready for operations
 * @property {Object} stats - Request statistics
 * @property {number} stats.requests - Total requests made
 * @property {number} stats.errors - Total errors encountered
 * @property {number} stats.rateLimitHits - Rate limit events
 * @property {Object} rateLimit - Rate limit status
 * @property {number} rateLimit.remainingMs - Ms until next request allowed
 * @property {number} rateLimit.lastRequestTime - Timestamp of last request
 */

/**
 * Order result structure
 * @typedef {Object} OrderResult
 * @property {string|null} orderId - Order ID if successful
 * @property {string} status - Order status (matched, live, killed, etc.)
 * @property {number} shares - Shares filled
 * @property {number} price - Requested price
 * @property {number|null} priceFilled - Actual fill price
 * @property {number} cost - Total cost
 * @property {boolean} filled - Whether order was filled
 * @property {string|null} tx - Transaction hash
 * @property {Object|null} raw - Raw API response
 */
