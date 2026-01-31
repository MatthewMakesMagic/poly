/**
 * Kill Switch Types and Constants
 *
 * Error codes, constants, and custom error class for the watchdog process.
 * This module is independent of the main process to ensure the watchdog
 * can function even if main process modules are broken.
 *
 * @module kill-switch/types
 */

/**
 * Watchdog-specific error codes
 */
export const WatchdogErrorCodes = {
  PID_FILE_NOT_FOUND: 'PID_FILE_NOT_FOUND',
  PID_FILE_STALE: 'PID_FILE_STALE',
  PID_FILE_INVALID: 'PID_FILE_INVALID',
  MAIN_PROCESS_NOT_RUNNING: 'MAIN_PROCESS_NOT_RUNNING',
  KILL_FAILED: 'KILL_FAILED',
  KILL_TIMEOUT: 'KILL_TIMEOUT',
  INVALID_COMMAND: 'INVALID_COMMAND',
  WATCHDOG_ALREADY_RUNNING: 'WATCHDOG_ALREADY_RUNNING',
  SIGNAL_FAILED: 'SIGNAL_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
};

/**
 * Process status values
 */
export const ProcessStatus = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  UNRESPONSIVE: 'unresponsive',
  UNKNOWN: 'unknown',
};

/**
 * Kill result method values
 */
export const KillMethod = {
  GRACEFUL: 'graceful',
  FORCE: 'force',
  ALREADY_STOPPED: 'already_stopped',
  FAILED: 'failed',
};

/**
 * Watchdog commands
 */
export const WatchdogCommands = {
  START: 'start',
  STOP: 'stop',
  KILL: 'kill',
  STATUS: 'status',
  HELP: 'help',
};

/**
 * Default configuration values
 */
export const WatchdogDefaults = {
  GRACEFUL_TIMEOUT_MS: 2000,
  POLL_INTERVAL_MS: 100,
  MAX_KILL_TIME_MS: 5000,
  PID_FILE_PATH: './data/main.pid',
  LOG_FILE_PATH: './logs/watchdog.log',
  WATCHDOG_PID_FILE: './data/watchdog.pid',
  STATE_FILE_PATH: './data/last-known-state.json',
  STATE_UPDATE_INTERVAL_MS: 5000,
  STATE_STALE_THRESHOLD_MS: 5000,
};

/**
 * State snapshot schema version
 * Used for format compatibility checking
 */
export const SnapshotVersion = {
  CURRENT: 1,
};

/**
 * Watchdog-specific error class
 *
 * Independent of the main process error classes to ensure the watchdog
 * can function even if main process modules are broken.
 */
export class WatchdogError extends Error {
  /**
   * @param {string} code - Error code from WatchdogErrorCodes
   * @param {string} message - Human-readable error message
   * @param {Object} [context={}] - Additional context for debugging
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'WatchdogError';
    this.code = code;
    this.context = context;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to structured log format
   * @returns {Object} Structured error object
   */
  toLogFormat() {
    return {
      error_code: this.code,
      error_message: this.message,
      error_context: this.context,
      error_timestamp: this.timestamp,
    };
  }
}
