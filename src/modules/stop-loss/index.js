/**
 * Stop-Loss Module
 *
 * Public interface for stop-loss evaluation.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Evaluate positions against stop-loss thresholds
 * - Support per-position and default stop-loss percentages
 * - Track evaluation statistics
 *
 * @module modules/stop-loss
 */

import { child } from '../logger/index.js';
import { StopLossError, StopLossErrorCodes } from './types.js';
import { evaluate as evaluateLogic, evaluateAll as evaluateAllLogic, calculateStopLossThreshold } from './logic.js';
import { getStats, resetState } from './state.js';

// Module state
let log = null;
let config = null;
let stopLossConfig = null;
let initialized = false;

// Default stop-loss config if not specified
const DEFAULT_STOP_LOSS_CONFIG = {
  enabled: true,
  defaultStopLossPct: 0.05,  // 5% default stop-loss
};

/**
 * Initialize the stop-loss module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.strategy] - Strategy configuration
 * @param {Object} [cfg.strategy.stopLoss] - Stop-loss configuration
 * @param {boolean} [cfg.strategy.stopLoss.enabled=true] - Enable/disable stop-loss evaluation
 * @param {number} [cfg.strategy.stopLoss.defaultStopLossPct=0.05] - Default stop-loss percentage (0-1)
 * @returns {Promise<void>}
 * @throws {StopLossError} If configuration is invalid
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'stop-loss' });
  config = cfg;

  log.info('module_init_start');

  // Extract and validate stop-loss config
  const strategyStopLossConfig = cfg?.strategy?.stopLoss || {};
  stopLossConfig = {
    enabled: strategyStopLossConfig.enabled ?? DEFAULT_STOP_LOSS_CONFIG.enabled,
    defaultStopLossPct: strategyStopLossConfig.defaultStopLossPct ?? DEFAULT_STOP_LOSS_CONFIG.defaultStopLossPct,
  };

  // Validate config values
  validateConfig(stopLossConfig);

  initialized = true;
  log.info('module_initialized', {
    stop_loss: {
      enabled: stopLossConfig.enabled,
      default_stop_loss_pct: stopLossConfig.defaultStopLossPct,
    },
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Stop-loss config
 * @throws {StopLossError} If validation fails
 * @private
 */
function validateConfig(cfg) {
  if (typeof cfg.enabled !== 'boolean') {
    throw new StopLossError(
      StopLossErrorCodes.CONFIG_INVALID,
      'enabled must be a boolean',
      { enabled: cfg.enabled }
    );
  }

  if (typeof cfg.defaultStopLossPct !== 'number' || cfg.defaultStopLossPct < 0 || cfg.defaultStopLossPct > 1) {
    throw new StopLossError(
      StopLossErrorCodes.CONFIG_INVALID,
      'defaultStopLossPct must be a number between 0 and 1',
      { defaultStopLossPct: cfg.defaultStopLossPct }
    );
  }
}

/**
 * Evaluate stop-loss condition for a single position
 *
 * @param {Object} position - Position to evaluate
 * @param {number} position.id - Position ID
 * @param {string} position.window_id - Window identifier
 * @param {string} position.side - 'long' or 'short'
 * @param {number} position.size - Position size
 * @param {number} position.entry_price - Entry price
 * @param {number} [position.stop_loss_pct] - Per-position stop-loss override
 * @param {number} currentPrice - Current market price
 * @param {Object} [options] - Evaluation options
 * @returns {Object} StopLossResult with triggered, reason, action, closeMethod
 * @throws {StopLossError} If not initialized or inputs are invalid
 */
export function evaluate(position, currentPrice, options = {}) {
  ensureInitialized();

  if (!stopLossConfig.enabled) {
    return {
      triggered: false,
      position_id: position.id,
      reason: 'stop_loss_disabled',
      action: null,
      closeMethod: null,
    };
  }

  return evaluateLogic(position, currentPrice, {
    stopLossPct: stopLossConfig.defaultStopLossPct,
    log,
    ...options,
  });
}

/**
 * Evaluate stop-loss for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} [options] - Evaluation options
 * @returns {Object} { triggered: StopLossResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  ensureInitialized();

  if (!stopLossConfig.enabled) {
    return {
      triggered: [],
      summary: { evaluated: 0, triggered: 0, safe: 0 },
    };
  }

  if (!positions || positions.length === 0) {
    return {
      triggered: [],
      summary: { evaluated: 0, triggered: 0, safe: 0 },
    };
  }

  return evaluateAllLogic(positions, getCurrentPrice, {
    stopLossPct: stopLossConfig.defaultStopLossPct,
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
    config: stopLossConfig ? {
      enabled: stopLossConfig.enabled,
      default_stop_loss_pct: stopLossConfig.defaultStopLossPct,
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
  stopLossConfig = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {StopLossError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new StopLossError(
      StopLossErrorCodes.NOT_INITIALIZED,
      'Stop-loss module not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  StopLossError,
  StopLossErrorCodes,
  TriggerReason,
  createStopLossResult,
} from './types.js';
