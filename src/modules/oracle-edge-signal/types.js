/**
 * Oracle Edge Signal Generator Types
 *
 * Defines error classes, error codes, SignalDirection enum, and default configuration
 * for the oracle edge signal generator module.
 *
 * @module modules/oracle-edge-signal/types
 */

import { PolyError } from '../../types/errors.js';

/**
 * Oracle Edge Signal error class
 */
export class OracleEdgeSignalError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'OracleEdgeSignalError';
  }
}

/**
 * Error codes for Oracle Edge Signal module
 */
export const OracleEdgeSignalErrorCodes = {
  NOT_INITIALIZED: 'ORACLE_EDGE_SIGNAL_NOT_INITIALIZED',
  INVALID_WINDOW: 'ORACLE_EDGE_SIGNAL_INVALID_WINDOW',
  INVALID_CONFIG: 'ORACLE_EDGE_SIGNAL_INVALID_CONFIG',
  DEPENDENCY_UNAVAILABLE: 'ORACLE_EDGE_SIGNAL_DEPENDENCY_UNAVAILABLE',
  SUBSCRIPTION_FAILED: 'ORACLE_EDGE_SIGNAL_SUBSCRIPTION_FAILED',
};

/**
 * Signal direction enum
 *
 * FADE_UP: UI shows UP, we bet AGAINST by buying DOWN token
 * FADE_DOWN: UI shows DOWN, we bet AGAINST by buying UP token
 */
export const SignalDirection = {
  FADE_UP: 'fade_up',
  FADE_DOWN: 'fade_down',
};

/**
 * Default configuration for Oracle Edge Signal Generator
 */
export const DEFAULT_CONFIG = {
  maxTimeThresholdMs: 30000,           // Only signal within 30s of expiry
  minStalenessMs: 15000,               // Oracle must be stale for 15+ seconds
  strikeThreshold: 0.05,               // 5% from strike for "clear" direction
  chainlinkDeviationThresholdPct: 0.005, // 0.5% max divergence (oracle won't update)
  confidenceThreshold: 0.65,           // Market must show 65%+ conviction
  evaluationIntervalMs: 500,           // Check every 500ms
};
