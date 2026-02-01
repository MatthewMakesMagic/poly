/**
 * Lag Tracker Types
 *
 * Error classes and constants for the lag tracker module.
 * Extends PolyError for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Lag tracker error codes
 */
export const LagTrackerErrorCodes = {
  NOT_INITIALIZED: 'LAG_TRACKER_NOT_INITIALIZED',
  INVALID_SYMBOL: 'LAG_TRACKER_INVALID_SYMBOL',
  PERSISTENCE_ERROR: 'LAG_TRACKER_PERSISTENCE_ERROR',
  INSUFFICIENT_DATA: 'LAG_TRACKER_INSUFFICIENT_DATA',
};

/**
 * Lag tracker error class
 * Extends PolyError for consistent error handling across the system.
 */
export class LagTrackerError extends PolyError {
  /**
   * @param {string} code - Error code from LagTrackerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'LagTrackerError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  // Buffer settings
  bufferMaxAgeMs: 60000,        // Keep last 60 seconds of prices
  bufferMaxSize: 2000,          // Max points per symbol

  // Tau values to test (milliseconds)
  tauValues: [500, 1000, 2000, 5000, 10000, 30000],

  // Signal generation
  minMoveMagnitude: 0.001,      // 0.1% minimum move to generate signal
  minCorrelation: 0.5,          // Minimum correlation for signal
  significanceThreshold: 0.05,  // P-value threshold

  // Stability tracking
  stabilityWindowSize: 30,      // Number of tau* samples to track
  stabilityThreshold: 5000,     // Variance threshold (ms^2) for stability

  // Persistence
  bufferSize: 10,               // Flush after N signals
  flushIntervalMs: 1000,        // Flush every N ms
  maxBufferSize: 500,           // Max buffer before overflow

  // Oracle staleness
  staleThresholdMs: 2000,       // Oracle considered stale after this time
};

/**
 * Minimum sample size for correlation analysis
 */
export const MIN_SAMPLE_SIZE = 10;

/**
 * Tolerance for matching timestamps when aligning series (ms)
 */
export const TIMESTAMP_TOLERANCE_MS = 100;

/**
 * Default stale oracle threshold in milliseconds
 */
export const DEFAULT_STALE_THRESHOLD_MS = 2000;

/**
 * Maximum pending signals before oldest are dropped (memory safety)
 */
export const MAX_PENDING_SIGNALS = 1000;

/**
 * Epsilon for floating point comparisons
 */
export const FLOAT_EPSILON = 1e-10;
