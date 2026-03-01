/**
 * Order Manager Types and Constants
 *
 * Defines order-specific error types, status values, and constants.
 */

import { OrderError } from '../../types/errors.js';

/**
 * Order Manager Error Codes
 */
export const OrderManagerErrorCodes = {
  NOT_INITIALIZED: 'ORDER_MANAGER_NOT_INITIALIZED',
  VALIDATION_FAILED: 'ORDER_VALIDATION_FAILED',
  SUBMISSION_FAILED: 'ORDER_SUBMISSION_FAILED',
  NOT_FOUND: 'ORDER_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_ORDER_STATUS_TRANSITION',
  DATABASE_ERROR: 'ORDER_DATABASE_ERROR',
  CANCEL_FAILED: 'ORDER_CANCEL_FAILED',
  INVALID_CANCEL_STATE: 'ORDER_INVALID_CANCEL_STATE',
  INSUFFICIENT_BALANCE: 'ORDER_INSUFFICIENT_BALANCE',
  WINDOW_ORDER_CAP_EXCEEDED: 'ORDER_WINDOW_CAP_EXCEEDED',
  CONFIRMATION_TIMEOUT: 'ORDER_CONFIRMATION_TIMEOUT',
};

/**
 * Order Manager Error
 * Extends OrderError with module-specific error codes
 */
export class OrderManagerError extends OrderError {
  /**
   * @param {string} code - Error code from OrderManagerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OrderManagerError';
  }
}

/**
 * Order Status Values
 * Maps to the status column in orders table
 */
export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
};

/**
 * Order Types
 * Maps to the order_type column in orders table
 */
export const OrderType = {
  LIMIT: 'limit',
  MARKET: 'market',
  GTC: 'GTC',
  FOK: 'FOK',
  IOC: 'IOC',
};

/**
 * Order Sides
 */
export const Side = {
  BUY: 'buy',
  SELL: 'sell',
};

/**
 * Trading Modes
 * Determines the fill source for orders while keeping downstream code identical.
 */
export const TradingMode = {
  LIVE: 'LIVE',       // Polymarket API -> real fill
  PAPER: 'PAPER',     // SimulatedBook -> simulated fill, persisted with mode='PAPER'
  DRY_RUN: 'DRY_RUN', // Log only -> synthetic fill at CLOB price
  BACKTEST: 'BACKTEST',
};

/**
 * Valid status transitions for orders
 */
export const ValidStatusTransitions = {
  [OrderStatus.PENDING]: [OrderStatus.OPEN, OrderStatus.FILLED, OrderStatus.REJECTED, OrderStatus.UNKNOWN],
  [OrderStatus.OPEN]: [OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.UNKNOWN],
  [OrderStatus.PARTIALLY_FILLED]: [OrderStatus.PARTIALLY_FILLED, OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.UNKNOWN],
  [OrderStatus.FILLED]: [], // Terminal state
  [OrderStatus.CANCELLED]: [], // Terminal state
  [OrderStatus.EXPIRED]: [], // Terminal state
  [OrderStatus.REJECTED]: [], // Terminal state
  [OrderStatus.UNKNOWN]: [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED], // Can resolve to terminal state
};
