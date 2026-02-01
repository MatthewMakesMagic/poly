/**
 * Divergence Tracker Types
 *
 * Error classes and constants for the divergence tracker module.
 * Extends PolyError for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Divergence tracker error codes
 */
export const DivergenceTrackerErrorCodes = {
  NOT_INITIALIZED: 'DIVERGENCE_TRACKER_NOT_INITIALIZED',
  INVALID_SYMBOL: 'DIVERGENCE_TRACKER_INVALID_SYMBOL',
  SUBSCRIPTION_FAILED: 'DIVERGENCE_TRACKER_SUBSCRIPTION_FAILED',
};

/**
 * Divergence tracker error class
 * Extends PolyError for consistent error handling across the system.
 */
export class DivergenceTrackerError extends PolyError {
  /**
   * @param {string} code - Error code from DivergenceTrackerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'DivergenceTrackerError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  thresholdPct: 0.003,           // 0.3% default threshold for breach detection
  snapshotIntervalMs: 1000,      // Log spread snapshot every 1 second
  enableSnapshots: true,         // Enable/disable snapshot logging
  alignedThresholdPct: 0.0001,   // Consider "aligned" if spread < 0.01%
};

/**
 * Direction constants
 */
export const Direction = {
  UI_LEADING: 'ui_leading',
  UI_LAGGING: 'ui_lagging',
  ALIGNED: 'aligned',
};

/**
 * Breach event types
 */
export const BreachEventType = {
  STARTED: 'breach_started',
  ENDED: 'breach_ended',
};
