/**
 * Position Manager Types and Constants
 *
 * Defines position-specific error types, status values, and constants.
 */

import { PositionError } from '../../types/errors.js';

/**
 * Position Manager Error Codes
 */
export const PositionManagerErrorCodes = {
  NOT_INITIALIZED: 'POSITION_MANAGER_NOT_INITIALIZED',
  VALIDATION_FAILED: 'POSITION_VALIDATION_FAILED',
  NOT_FOUND: 'POSITION_NOT_FOUND',
  DUPLICATE_POSITION: 'DUPLICATE_POSITION',
  DATABASE_ERROR: 'POSITION_DATABASE_ERROR',
  INVALID_STATUS_TRANSITION: 'POSITION_INVALID_STATUS_TRANSITION',
  // Story 2.6: Reconciliation & Limits
  POSITION_LIMIT_EXCEEDED: 'POSITION_LIMIT_EXCEEDED',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  CLOSE_FAILED: 'POSITION_CLOSE_FAILED',
  EXCHANGE_DIVERGENCE: 'EXCHANGE_DIVERGENCE',
};

/**
 * Position Manager Error
 * Extends PositionError with module-specific error codes
 */
export class PositionManagerError extends PositionError {
  /**
   * @param {string} code - Error code from PositionManagerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'PositionManagerError';
  }
}

/**
 * Position Status Values
 * Maps to the status column in positions table
 */
export const PositionStatus = {
  OPEN: 'open',
  CLOSED: 'closed',
  LIQUIDATED: 'liquidated',
};

/**
 * Lifecycle State Values
 * Maps to the lifecycle_state column in positions table
 *
 * ENTRY -> MONITORING -> { STOP_TRIGGERED | TP_TRIGGERED | EXPIRY }
 *                         -> EXIT_PENDING | SETTLEMENT -> CLOSED
 */
export { LifecycleState } from './lifecycle.js';

/**
 * Position Sides
 */
export const Side = {
  LONG: 'long',
  SHORT: 'short',
};
