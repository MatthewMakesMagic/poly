/**
 * Oracle Predictor Types
 *
 * Error classes and constants for the oracle update predictor module.
 * Extends PolyError for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Oracle predictor error codes
 */
export const OraclePredictorErrorCodes = {
  NOT_INITIALIZED: 'ORACLE_PREDICTOR_NOT_INITIALIZED',
  INVALID_SYMBOL: 'ORACLE_PREDICTOR_INVALID_SYMBOL',
  INVALID_INPUT: 'ORACLE_PREDICTOR_INVALID_INPUT',
  INSUFFICIENT_DATA: 'ORACLE_PREDICTOR_INSUFFICIENT_DATA',
  PERSISTENCE_ERROR: 'ORACLE_PREDICTOR_PERSISTENCE_ERROR',
};

/**
 * Oracle predictor error class
 * Extends PolyError for consistent error handling across the system.
 */
export class OraclePredictorError extends PolyError {
  /**
   * @param {string} code - Error code from OraclePredictorErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OraclePredictorError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  patternCacheExpiryMs: 5 * 60 * 1000,      // Recalculate patterns every 5 min
  minHistoricalUpdates: 20,                  // Minimum updates needed for reliable prediction
  confidenceLevel: 0.95,                     // For confidence interval calculation
  buckets: {
    timeSinceLast: [
      { name: '0-10s', min: 0, max: 10000 },
      { name: '10-30s', min: 10000, max: 30000 },
      { name: '30s-1m', min: 30000, max: 60000 },
      { name: '1-2m', min: 60000, max: 120000 },
      { name: '2-5m', min: 120000, max: 300000 },
      { name: '>5m', min: 300000, max: Infinity },
    ],
    deviation: [
      { name: 'micro', min: 0, max: 0.001 },      // 0-0.1%
      { name: 'small', min: 0.001, max: 0.003 },  // 0.1-0.3%
      { name: 'medium', min: 0.003, max: 0.005 }, // 0.3-0.5%
      { name: 'large', min: 0.005, max: 0.01 },   // 0.5-1%
      { name: 'extreme', min: 0.01, max: Infinity }, // >1%
    ],
  },
};

/**
 * Calibration bucket definitions for prediction tracking
 * Note: max is exclusive except for final bucket (uses 1.01 to include 1.0)
 */
export const CALIBRATION_BUCKETS = [
  { name: '0-10%', min: 0.0, max: 0.1 },
  { name: '10-20%', min: 0.1, max: 0.2 },
  { name: '20-30%', min: 0.2, max: 0.3 },
  { name: '30-40%', min: 0.3, max: 0.4 },
  { name: '40-50%', min: 0.4, max: 0.5 },
  { name: '50-60%', min: 0.5, max: 0.6 },
  { name: '60-70%', min: 0.6, max: 0.7 },
  { name: '70-80%', min: 0.7, max: 0.8 },
  { name: '80-90%', min: 0.8, max: 0.9 },
  { name: '90-100%', min: 0.9, max: 1.01 }, // max > 1.0 to include exactly 1.0
];
