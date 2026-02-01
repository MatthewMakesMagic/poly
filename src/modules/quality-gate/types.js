/**
 * Quality Gate Types
 *
 * Defines error classes, error codes, disable reasons, and constants
 * for the quality gate module.
 *
 * @module modules/quality-gate/types
 */

import { PolyError } from '../../types/errors.js';

/**
 * Quality Gate error class
 */
export class QualityGateError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'QualityGateError';
  }
}

/**
 * Error codes for Quality Gate module
 */
export const QualityGateErrorCodes = {
  NOT_INITIALIZED: 'QUALITY_GATE_NOT_INITIALIZED',
  INVALID_CONFIG: 'QUALITY_GATE_INVALID_CONFIG',
  SIGNAL_LOGGER_UNAVAILABLE: 'QUALITY_GATE_SIGNAL_LOGGER_UNAVAILABLE',
  EVALUATION_ERROR: 'QUALITY_GATE_EVALUATION_ERROR',
  ALREADY_DISABLED: 'QUALITY_GATE_ALREADY_DISABLED',
  NOT_DISABLED: 'QUALITY_GATE_NOT_DISABLED',
  INVALID_REASON: 'QUALITY_GATE_INVALID_REASON',
};

/**
 * Reasons why strategy may be disabled
 */
export const DisableReason = {
  ACCURACY_BELOW_THRESHOLD: 'accuracy_below_threshold',
  FEED_UNAVAILABLE: 'feed_unavailable',
  PATTERN_CHANGE_DETECTED: 'pattern_change_detected',
  SPREAD_BEHAVIOR_CHANGE: 'spread_behavior_change',
  MANUAL: 'manual',
};

/**
 * Default configuration for Quality Gate
 */
export const DEFAULT_CONFIG = {
  enabled: true,                        // Enable/disable quality gate
  evaluationIntervalMs: 60000,          // Evaluate every 1 minute
  rollingWindowSize: 20,                // Last N signals for rolling accuracy
  minAccuracyThreshold: 0.40,           // 40% minimum accuracy
  feedUnavailableThresholdMs: 10000,    // 10 seconds feed unavailable
  patternChangeThreshold: 2.0,          // 2x change in update frequency
  spreadBehaviorStdDev: 2.0,            // 2 std dev for spread behavior change
  patternCheckFrequency: 5,             // Check patterns every 5th evaluation
  minSignalsForEvaluation: 10,          // Minimum signals before evaluating
};
