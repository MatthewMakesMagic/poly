/**
 * Signal Outcome Logger Types
 *
 * Defines error classes, error codes, and constants for the signal outcome logger module.
 *
 * @module modules/signal-outcome-logger/types
 */

import { PolyError } from '../../types/errors.js';

/**
 * Signal Outcome Logger error class
 */
export class SignalOutcomeLoggerError extends PolyError {
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'SignalOutcomeLoggerError';
  }
}

/**
 * Error codes for Signal Outcome Logger module
 */
export const SignalOutcomeLoggerErrorCodes = {
  NOT_INITIALIZED: 'SIGNAL_OUTCOME_LOGGER_NOT_INITIALIZED',
  INVALID_CONFIG: 'SIGNAL_OUTCOME_LOGGER_INVALID_CONFIG',
  INVALID_SIGNAL: 'SIGNAL_OUTCOME_LOGGER_INVALID_SIGNAL',
  INVALID_SETTLEMENT: 'SIGNAL_OUTCOME_LOGGER_INVALID_SETTLEMENT',
  DATABASE_ERROR: 'SIGNAL_OUTCOME_LOGGER_DATABASE_ERROR',
  SIGNAL_NOT_FOUND: 'SIGNAL_OUTCOME_LOGGER_SIGNAL_NOT_FOUND',
};

/**
 * Default configuration for Signal Outcome Logger
 */
export const DEFAULT_CONFIG = {
  autoSubscribeToSignals: true,       // Auto-subscribe to oracle-edge-signal
  autoSubscribeToSettlements: true,   // Auto-subscribe to settlement events
  defaultPositionSize: 1,             // Default position size for PnL calc
  retentionDays: 30,                  // Keep signals for 30 days
};

/**
 * Bucket types for statistics queries
 */
export const BucketType = {
  TIME_TO_EXPIRY: 'time_to_expiry',
  STALENESS: 'staleness',
  CONFIDENCE: 'confidence',
  SYMBOL: 'symbol',
};
