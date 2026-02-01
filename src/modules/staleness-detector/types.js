/**
 * Staleness Detector Types
 *
 * Type definitions and error classes for the staleness detector module.
 * Extends PolyError from src/types/errors.js for consistent error handling.
 *
 * @module modules/staleness-detector/types
 */

import { PolyError } from '../../types/errors.js';

/**
 * Staleness detector error codes
 */
export const StalenessDetectorErrorCodes = {
  NOT_INITIALIZED: 'STALENESS_DETECTOR_NOT_INITIALIZED',
  INVALID_SYMBOL: 'STALENESS_DETECTOR_INVALID_SYMBOL',
  INVALID_CONFIG: 'STALENESS_DETECTOR_INVALID_CONFIG',
  TRACKER_UNAVAILABLE: 'STALENESS_DETECTOR_TRACKER_UNAVAILABLE',
  SUBSCRIPTION_FAILED: 'STALENESS_DETECTOR_SUBSCRIPTION_FAILED',
};

/**
 * Staleness detector error class
 * Extends PolyError for consistent error handling across the system.
 */
export class StalenessDetectorError extends PolyError {
  /**
   * @param {string} code - Error code from StalenessDetectorErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'StalenessDetectorError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  stalenessThresholdMs: 15000,              // Time since update to be "stale" (15s)
  minDivergencePct: 0.001,                   // 0.1% minimum spread for staleness
  chainlinkDeviationThresholdPct: 0.005,     // 0.5% - above this, oracle likely to update
  scoreThreshold: 0.6,                        // Score above this triggers events
  evaluationIntervalMs: 1000,                 // How often to evaluate staleness (1s)
  maxSubscribers: 100,                        // Maximum number of subscribers to prevent memory leaks
};

/**
 * Event types emitted by the staleness detector
 */
export const EventTypes = {
  STALENESS_DETECTED: 'staleness_detected',
  STALENESS_RESOLVED: 'staleness_resolved',
};
