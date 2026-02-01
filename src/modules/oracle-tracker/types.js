/**
 * Oracle Tracker Types
 *
 * Error classes and constants for the oracle pattern tracker module.
 * Extends PolyError for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Oracle tracker error codes
 */
export const OracleTrackerErrorCodes = {
  NOT_INITIALIZED: 'ORACLE_TRACKER_NOT_INITIALIZED',
  INVALID_SYMBOL: 'ORACLE_TRACKER_INVALID_SYMBOL',
  PERSISTENCE_ERROR: 'ORACLE_TRACKER_PERSISTENCE_ERROR',
};

/**
 * Oracle tracker error class
 * Extends PolyError for consistent error handling across the system.
 */
export class OracleTrackerError extends PolyError {
  /**
   * @param {string} code - Error code from OracleTrackerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OracleTrackerError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  bufferSize: 10,                  // Flush after N update records
  flushIntervalMs: 1000,           // Flush every N ms
  minDeviationForUpdate: 0.0001,   // Minimum deviation to count as "update" (0.01%)
  maxBufferSize: 500,              // Max buffer before overflow
};

/**
 * Volatility bucket definitions for pattern analysis
 */
export const VOLATILITY_BUCKETS = {
  small: { min: 0, max: 0.001 },           // 0-0.1%
  medium: { min: 0.001, max: 0.005 },      // 0.1-0.5%
  large: { min: 0.005, max: 0.01 },        // 0.5-1%
  extreme: { min: 0.01, max: Infinity },   // >1%
};
