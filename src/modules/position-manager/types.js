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
 * Position Sides
 */
export const Side = {
  LONG: 'long',
  SHORT: 'short',
};
