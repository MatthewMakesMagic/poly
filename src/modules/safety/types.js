/**
 * Safety Module Type Definitions
 *
 * Error types, constants, and enums for the safety module.
 */

import { PolyError } from '../../types/index.js';

/**
 * Safety module error codes
 */
export const SafetyErrorCodes = {
  NOT_INITIALIZED: 'SAFETY_NOT_INITIALIZED',
  ALREADY_INITIALIZED: 'SAFETY_ALREADY_INITIALIZED',
  DATABASE_ERROR: 'SAFETY_DATABASE_ERROR',
  INVALID_AMOUNT: 'SAFETY_INVALID_AMOUNT',
  RECORD_NOT_FOUND: 'SAFETY_RECORD_NOT_FOUND',
  DRAWDOWN_LIMIT_BREACHED: 'DRAWDOWN_LIMIT_BREACHED',
  AUTO_STOP_ACTIVE: 'AUTO_STOP_ACTIVE',
  RESET_REQUIRES_CONFIRMATION: 'RESET_REQUIRES_CONFIRMATION',
};

/**
 * Custom error class for safety module errors
 */
export class SafetyError extends PolyError {
  /**
   * @param {string} code - Error code from SafetyErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'SafetyError';
  }
}
