/**
 * Watchdog Logger
 *
 * Simple, independent logger for the watchdog process.
 * Does NOT depend on the main logger module to ensure the watchdog
 * can function even if main process modules are broken.
 *
 * @module kill-switch/logger
 */

import fs from 'fs';
import path from 'path';
import { WatchdogDefaults } from './types.js';

let logFilePath = WatchdogDefaults.LOG_FILE_PATH;
let consoleEnabled = true;

/**
 * Configure the logger
 *
 * @param {Object} options - Logger configuration
 * @param {string} [options.logFile] - Path to log file
 * @param {boolean} [options.console] - Whether to log to console
 */
export function configure(options = {}) {
  if (options.logFile) {
    logFilePath = options.logFile;
  }
  if (typeof options.console === 'boolean') {
    consoleEnabled = options.console;
  }
}

/**
 * Log an event
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Additional data to log
 * @param {string} [level='info'] - Log level (info, warn, error, debug)
 */
export function log(event, data = {}, level = 'info') {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: 'watchdog',
    event,
    data,
  };

  const line = JSON.stringify(entry);

  // Write to log file
  writeToFile(line);

  // Log to console if enabled
  if (consoleEnabled) {
    const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`;
    const message = Object.keys(data).length > 0
      ? `${prefix} ${event} ${JSON.stringify(data)}`
      : `${prefix} ${event}`;

    if (level === 'error') {
      console.error(message);
    } else if (level === 'warn') {
      console.warn(message);
    } else {
      console.log(message);
    }
  }
}

/**
 * Log an info message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Additional data
 */
export function info(event, data = {}) {
  log(event, data, 'info');
}

/**
 * Log a warning message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Additional data
 */
export function warn(event, data = {}) {
  log(event, data, 'warn');
}

/**
 * Log an error message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Additional data
 */
export function error(event, data = {}) {
  log(event, data, 'error');
}

/**
 * Log a debug message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Additional data
 */
export function debug(event, data = {}) {
  log(event, data, 'debug');
}

/**
 * Write a line to the log file
 *
 * @param {string} line - Line to write
 * @private
 */
function writeToFile(line) {
  try {
    // Ensure logs directory exists
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Append to log file
    fs.appendFileSync(logFilePath, line + '\n', 'utf-8');
  } catch (err) {
    // If we can't write to the log file, at least try console
    if (consoleEnabled) {
      console.error(`[WATCHDOG] Failed to write to log file: ${err.message}`);
    }
  }
}

/**
 * Format an error for logging
 *
 * @param {Error} err - Error to format
 * @returns {Object} Formatted error data
 */
export function formatError(err) {
  return {
    message: err.message,
    code: err.code || 'UNKNOWN',
    stack: err.stack,
    ...(err.context || {}),
  };
}
