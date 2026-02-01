/**
 * Tick Logger Types
 *
 * Error classes and constants for the tick logger module.
 * Extends PolyError for consistent error handling.
 */

import { PolyError } from '../../types/errors.js';

/**
 * Tick logger error codes
 */
export const TickLoggerErrorCodes = {
  NOT_INITIALIZED: 'TICK_LOGGER_NOT_INITIALIZED',
  BUFFER_OVERFLOW: 'TICK_LOGGER_BUFFER_OVERFLOW',
  INSERT_FAILED: 'TICK_LOGGER_INSERT_FAILED',
  CLEANUP_FAILED: 'TICK_LOGGER_CLEANUP_FAILED',
};

/**
 * Tick logger error class
 * Extends PolyError for consistent error handling across the system.
 */
export class TickLoggerError extends PolyError {
  /**
   * @param {string} code - Error code from TickLoggerErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(code, message, context);
    this.name = 'TickLoggerError';
  }
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG = {
  batchSize: 50,             // Flush after N ticks
  flushIntervalMs: 100,      // Flush every N ms
  retentionDays: 7,          // Keep ticks for N days
  cleanupOnInit: true,       // Run cleanup on init
  cleanupIntervalHours: 6,   // Run cleanup every N hours (0 to disable)
  maxBufferSize: 1000,       // Max buffer before forced flush
};

/**
 * Time constants
 */
export const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Security constants
 */
export const MAX_STRING_LENGTH = 256;  // Max length for topic/symbol strings
