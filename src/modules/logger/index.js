/**
 * Logger Module - Structured JSON logging with credential redaction
 *
 * Provides structured JSON logging following the architecture's log format.
 * All log entries include: timestamp, level, module, event
 * Optional fields: data, context, error
 *
 * Exports:
 * - init(config) - Initialize logger with configuration
 * - info(event, data?, context?) - Log info level
 * - warn(event, data?, context?) - Log warn level
 * - error(event, data?, context?, err?) - Log error level
 * - child(defaultFields) - Create child logger with bound fields
 * - getState() - Get current logger state
 * - shutdown() - Gracefully shutdown logger
 * - flush() - Flush pending writes (for testing)
 */

import { mkdirSync, existsSync } from 'node:fs';
import { formatLogEntry, formatLogEntryObject } from './formatter.js';
import { redactSensitive } from './redactor.js';
import { writeToFile, closeWriter, getWriterStats, flushWrites } from './writer.js';
import { isValidLevel } from './schema.js';

// Log level priorities (lower number = higher priority)
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// ANSI color codes for console output
const CONSOLE_COLORS = {
  error: '\x1b[31m', // Red
  warn: '\x1b[33m',  // Yellow
  info: '\x1b[36m',  // Cyan
  debug: '\x1b[90m', // Gray
  reset: '\x1b[0m',
};

// Module state
let state = {
  initialized: false,
  config: null,
  stats: {
    totalLogs: 0,
    errorCount: 0,
    lastWriteTime: null,
  },
};

/**
 * Initialize the logger module
 *
 * @param {Object} config - Configuration object
 * @param {Object} config.logging - Logging configuration
 * @param {string} config.logging.level - Log level (info, warn, error)
 * @param {string} config.logging.directory - Directory for log files
 * @param {boolean} [config.logging.console] - Enable console output
 * @returns {Promise<void>}
 */
export async function init(config) {
  const loggingConfig = config.logging || {};

  // Validate and set log level
  const requestedLevel = loggingConfig.level || 'info';
  const validLevel = isValidLevel(requestedLevel) ? requestedLevel : 'info';

  // Set defaults - console enabled by default (Railway captures stdout)
  // V3 Philosophy: Same behavior everywhere, no NODE_ENV differences
  state.config = {
    level: validLevel,
    directory: loggingConfig.directory || './logs',
    console: loggingConfig.console !== undefined ? loggingConfig.console : true,
  };

  // Create logs directory if it doesn't exist
  if (!existsSync(state.config.directory)) {
    mkdirSync(state.config.directory, { recursive: true });
  }

  state.initialized = true;
}

/**
 * Internal log function
 *
 * @param {string} level - Log level
 * @param {string} moduleName - Module name (from child logger or null)
 * @param {string} event - Event name
 * @param {Object} data - Event data
 * @param {Object} context - Additional context
 * @param {Error|null} err - Error object (for error level)
 */
function log(level, moduleName, event, data = {}, context = {}, err = null) {
  // Check if initialized
  if (!state.initialized) {
    // Fail-open: try to log to console
    console.error('[logger not initialized]', level, event, data);
    return;
  }

  // Check log level filtering
  const configLevel = LOG_LEVELS[state.config.level] ?? LOG_LEVELS.info;
  const messageLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  if (messageLevel > configLevel) {
    return; // Filter out lower priority logs
  }

  // Redact sensitive data
  const redactedData = redactSensitive(data);
  const redactedContext = redactSensitive(context);

  // Format the log entry - get both object and string
  const { entryObject, entryString } = formatLogEntryObject(
    level,
    moduleName,
    event,
    redactedData,
    redactedContext,
    err
  );

  // Update stats
  state.stats.totalLogs++;
  if (level === 'error') {
    state.stats.errorCount++;
  }
  state.stats.lastWriteTime = new Date().toISOString();

  // Write to file
  try {
    writeToFile(entryString, state.config.directory);
  } catch (writeErr) {
    // Fail-open: log to console on write failure
    console.error('[logger write failed]', writeErr.message);
    state.stats.errorCount++;
  }

  // Console output in development (use object directly, no re-parsing)
  if (state.config.console) {
    outputToConsole(level, entryObject);
  }
}

/**
 * Output log entry to console with formatting
 *
 * @param {string} level - Log level
 * @param {Object} entry - Log entry object (avoids re-parsing JSON)
 */
function outputToConsole(level, entry) {
  const color = CONSOLE_COLORS[level] || '';
  const reset = CONSOLE_COLORS.reset;

  // Pretty format for console
  const timestamp = entry.timestamp;
  const module = entry.module || '-';
  const event = entry.event;

  let output = `${color}[${timestamp}] ${level.toUpperCase()} [${module}] ${event}${reset}`;

  if (entry.data && Object.keys(entry.data).length > 0) {
    output += `\n  data: ${JSON.stringify(entry.data, null, 2).replace(/\n/g, '\n  ')}`;
  }

  if (entry.context && Object.keys(entry.context).length > 0) {
    output += `\n  context: ${JSON.stringify(entry.context, null, 2).replace(/\n/g, '\n  ')}`;
  }

  if (entry.error) {
    output += `\n  error: ${JSON.stringify(entry.error, null, 2).replace(/\n/g, '\n  ')}`;
  }

  console.log(output);
}

/**
 * Log debug level message
 *
 * Debug messages are lowest priority and filtered out in production.
 * Use for verbose tracing that's helpful during development.
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Event data
 * @param {Object} [context={}] - Additional context
 */
export function debug(event, data = {}, context = {}) {
  log('debug', null, event, data, context);
}

/**
 * Log info level message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Event data
 * @param {Object} [context={}] - Additional context
 */
export function info(event, data = {}, context = {}) {
  log('info', null, event, data, context);
}

/**
 * Log warn level message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Event data
 * @param {Object} [context={}] - Additional context
 */
export function warn(event, data = {}, context = {}) {
  log('warn', null, event, data, context);
}

/**
 * Log error level message
 *
 * @param {string} event - Event name
 * @param {Object} [data={}] - Event data
 * @param {Object} [context={}] - Additional context
 * @param {Error} [err=null] - Error object
 */
export function error(event, data = {}, context = {}, err = null) {
  log('error', null, event, data, context, err);
}

/**
 * Create a child logger with bound default fields
 *
 * @param {Object} defaultFields - Fields to include in every log
 * @param {string} [defaultFields.module] - Module name
 * @returns {Object} Child logger with info, warn, error, child methods
 */
export function child(defaultFields = {}) {
  const moduleName = defaultFields.module || null;

  return {
    debug: (event, data = {}, context = {}) => {
      log('debug', moduleName, event, { ...defaultFields, ...data, module: undefined }, context);
    },
    info: (event, data = {}, context = {}) => {
      log('info', moduleName, event, { ...defaultFields, ...data, module: undefined }, context);
    },
    warn: (event, data = {}, context = {}) => {
      log('warn', moduleName, event, { ...defaultFields, ...data, module: undefined }, context);
    },
    error: (event, data = {}, context = {}, err = null) => {
      log('error', moduleName, event, { ...defaultFields, ...data, module: undefined }, context, err);
    },
    child: (additionalFields = {}) => {
      return child({ ...defaultFields, ...additionalFields });
    },
  };
}

/**
 * Flush pending log writes to disk
 *
 * Useful for testing to ensure writes complete before assertions.
 *
 * @returns {Promise<void>}
 */
export async function flush() {
  await flushWrites();
}

/**
 * Get current logger state
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return {
    initialized: state.initialized,
    config: state.config ? { ...state.config } : null,
    stats: { ...state.stats, ...getWriterStats() },
  };
}

/**
 * Gracefully shutdown the logger
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (!state.initialized) {
    return;
  }

  // Close file writer
  await closeWriter();

  // Reset state
  state = {
    initialized: false,
    config: null,
    stats: {
      totalLogs: 0,
      errorCount: 0,
      lastWriteTime: null,
    },
  };
}
