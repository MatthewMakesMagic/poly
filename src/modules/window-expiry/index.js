/**
 * Window-Expiry Module
 *
 * Public interface for window expiry evaluation.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Parse window IDs to extract timing information
 * - Calculate time remaining in windows
 * - Detect "expiring soon" state for warnings
 * - Detect "resolved" state for P&L calculation
 * - Block entries when insufficient time remains
 * - Evaluate all positions for window expiry
 *
 * Key differences from stop-loss/take-profit:
 * - Two output categories: expiring (warning) vs resolved (action)
 * - Resolution based on time, not price crossing threshold
 * - P&L calculated from resolution outcome (0 or 1), not market exit price
 * - Entry blocking function for strategy evaluator
 *
 * @module modules/window-expiry
 */

import { child } from '../logger/index.js';
import { WindowExpiryError, WindowExpiryErrorCodes } from './types.js';
import {
  parseWindowId,
  calculateTimeRemaining as calculateTimeRemainingLogic,
  checkExpiry as checkExpiryLogic,
  canEnterWindow as canEnterWindowLogic,
  evaluateAll as evaluateAllLogic,
} from './logic.js';
import { getStats, resetState } from './state.js';

// Module state
let log = null;
let config = null;
let windowExpiryConfig = null;
let initialized = false;

// Default window expiry config if not specified
const DEFAULT_WINDOW_EXPIRY_CONFIG = {
  enabled: true,
  expiryWarningThresholdMs: 30 * 1000,  // 30 seconds warning before expiry
};

/**
 * Initialize the window-expiry module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.trading] - Trading configuration
 * @param {number} [cfg.trading.windowDurationMs=900000] - Window duration in ms (15 min default)
 * @param {number} [cfg.trading.minTimeRemainingMs=60000] - Min time to enter window (60 sec default)
 * @param {Object} [cfg.strategy] - Strategy configuration
 * @param {Object} [cfg.strategy.windowExpiry] - Window expiry configuration
 * @param {boolean} [cfg.strategy.windowExpiry.enabled=true] - Enable/disable evaluation
 * @param {number} [cfg.strategy.windowExpiry.expiryWarningThresholdMs=30000] - Warning threshold
 * @returns {Promise<void>}
 * @throws {WindowExpiryError} If configuration is invalid
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'window-expiry' });
  config = cfg;

  log.info('module_init_start');

  // Extract and validate trading config
  const tradingConfig = cfg?.trading || {};
  const strategyWindowExpiryConfig = cfg?.strategy?.windowExpiry || {};

  windowExpiryConfig = {
    enabled: strategyWindowExpiryConfig.enabled ?? DEFAULT_WINDOW_EXPIRY_CONFIG.enabled,
    expiryWarningThresholdMs: strategyWindowExpiryConfig.expiryWarningThresholdMs
      ?? DEFAULT_WINDOW_EXPIRY_CONFIG.expiryWarningThresholdMs,
    windowDurationMs: tradingConfig.windowDurationMs ?? 15 * 60 * 1000,
    minTimeRemainingMs: tradingConfig.minTimeRemainingMs ?? 60 * 1000,
  };

  // Validate config values
  validateConfig(windowExpiryConfig);

  initialized = true;
  log.info('module_initialized', {
    window_expiry: {
      enabled: windowExpiryConfig.enabled,
      window_duration_ms: windowExpiryConfig.windowDurationMs,
      expiry_warning_threshold_ms: windowExpiryConfig.expiryWarningThresholdMs,
      min_time_remaining_ms: windowExpiryConfig.minTimeRemainingMs,
    },
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Window expiry config
 * @throws {WindowExpiryError} If validation fails
 * @private
 */
function validateConfig(cfg) {
  if (typeof cfg.enabled !== 'boolean') {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.CONFIG_INVALID,
      'enabled must be a boolean',
      { enabled: cfg.enabled }
    );
  }

  if (typeof cfg.windowDurationMs !== 'number' || cfg.windowDurationMs <= 0) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.CONFIG_INVALID,
      'windowDurationMs must be a positive number',
      { windowDurationMs: cfg.windowDurationMs }
    );
  }

  if (typeof cfg.expiryWarningThresholdMs !== 'number' || cfg.expiryWarningThresholdMs < 0) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.CONFIG_INVALID,
      'expiryWarningThresholdMs must be a non-negative number',
      { expiryWarningThresholdMs: cfg.expiryWarningThresholdMs }
    );
  }

  if (typeof cfg.minTimeRemainingMs !== 'number' || cfg.minTimeRemainingMs < 0) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.CONFIG_INVALID,
      'minTimeRemainingMs must be a non-negative number',
      { minTimeRemainingMs: cfg.minTimeRemainingMs }
    );
  }

  if (cfg.expiryWarningThresholdMs >= cfg.windowDurationMs) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.CONFIG_INVALID,
      'expiryWarningThresholdMs must be less than windowDurationMs',
      {
        expiryWarningThresholdMs: cfg.expiryWarningThresholdMs,
        windowDurationMs: cfg.windowDurationMs,
      }
    );
  }
}

/**
 * Calculate time remaining in a window
 *
 * @param {string} windowId - Window identifier
 * @param {Object} [options] - Options
 * @param {number} [options.expiryWarningThresholdMs] - Override warning threshold
 * @param {Date} [options.now] - Current time (for testing)
 * @returns {Object} { time_remaining_ms, is_expiring, is_resolved, window_start_time, window_end_time }
 * @throws {WindowExpiryError} If not initialized or window_id is invalid
 */
export function calculateTimeRemaining(windowId, options = {}) {
  ensureInitialized();

  return calculateTimeRemainingLogic(windowId, {
    windowDurationMs: windowExpiryConfig.windowDurationMs,
    expiryWarningThresholdMs: options.expiryWarningThresholdMs ?? windowExpiryConfig.expiryWarningThresholdMs,
    now: options.now,
  });
}

/**
 * Check if a position's window is expiring or resolved
 *
 * @param {Object} position - Position to check
 * @param {Object} [windowData] - Window resolution data
 * @param {Object} [options] - Evaluation options
 * @returns {Object} WindowExpiryResult
 * @throws {WindowExpiryError} If not initialized
 */
export function checkExpiry(position, windowData = {}, options = {}) {
  ensureInitialized();

  if (!windowExpiryConfig.enabled) {
    return {
      position_id: position.id,
      is_expiring: false,
      is_resolved: false,
      reason: 'window_expiry_disabled',
    };
  }

  return checkExpiryLogic(position, windowData, {
    windowDurationMs: windowExpiryConfig.windowDurationMs,
    expiryWarningThresholdMs: windowExpiryConfig.expiryWarningThresholdMs,
    log,
    ...options,
  });
}

/**
 * Check if entry is allowed for a window
 *
 * @param {string} windowId - Window identifier
 * @param {Object} [options] - Options
 * @param {number} [options.minTimeRemainingMs] - Override min time remaining
 * @param {Date} [options.now] - Current time (for testing)
 * @returns {Object} { allowed: boolean, reason: string, time_remaining_ms }
 */
export function canEnterWindow(windowId, options = {}) {
  ensureInitialized();

  if (!windowExpiryConfig.enabled) {
    return {
      allowed: true,
      reason: 'window_expiry_disabled',
      time_remaining_ms: 0,
    };
  }

  return canEnterWindowLogic(windowId, {
    windowDurationMs: windowExpiryConfig.windowDurationMs,
    minTimeRemainingMs: options.minTimeRemainingMs ?? windowExpiryConfig.minTimeRemainingMs,
    log,
    ...options,
  });
}

/**
 * Evaluate window expiry for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} [getWindowData] - Function to get window data (resolution info)
 * @param {Object} [options] - Evaluation options
 * @returns {Object} { expiring: WindowExpiryResult[], resolved: WindowExpiryResult[], summary }
 */
export function evaluateAll(positions, getWindowData, options = {}) {
  ensureInitialized();

  if (!windowExpiryConfig.enabled) {
    return {
      expiring: [],
      resolved: [],
      summary: { evaluated: 0, expiring: 0, resolved: 0, safe: 0 },
    };
  }

  if (!positions || positions.length === 0) {
    return {
      expiring: [],
      resolved: [],
      summary: { evaluated: 0, expiring: 0, resolved: 0, safe: 0 },
    };
  }

  return evaluateAllLogic(positions, getWindowData, {
    windowDurationMs: windowExpiryConfig.windowDurationMs,
    expiryWarningThresholdMs: windowExpiryConfig.expiryWarningThresholdMs,
    log,
    ...options,
  });
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including initialization status, config, and stats
 */
export function getState() {
  return {
    initialized,
    config: windowExpiryConfig ? {
      enabled: windowExpiryConfig.enabled,
      window_duration_ms: windowExpiryConfig.windowDurationMs,
      expiry_warning_threshold_ms: windowExpiryConfig.expiryWarningThresholdMs,
      min_time_remaining_ms: windowExpiryConfig.minTimeRemainingMs,
    } : null,
    ...getStats(),
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Reset state
  resetState();

  config = null;
  windowExpiryConfig = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {WindowExpiryError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.NOT_INITIALIZED,
      'Window-expiry module not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  WindowExpiryError,
  WindowExpiryErrorCodes,
  ExpiryReason,
  Resolution,
  createWindowExpiryResult,
} from './types.js';
