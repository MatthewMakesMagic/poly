/**
 * Take-Profit Module
 *
 * Public interface for take-profit evaluation.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Evaluate positions against take-profit thresholds
 * - Support per-position and default take-profit percentages
 * - Track evaluation statistics
 *
 * Key differences from stop-loss:
 * - Trigger direction is OPPOSITE: long triggers when price RISES, short when price DROPS
 * - Uses 'limit' closeMethod (not 'market') for better fills
 * - Tracks profit_amount/profit_pct instead of loss_amount/loss_pct
 *
 * @module modules/take-profit
 */

import { child } from '../logger/index.js';
import { TakeProfitError, TakeProfitErrorCodes } from './types.js';
import {
  evaluate as evaluateLogic,
  evaluateAll as evaluateAllLogic,
  evaluateTrailing as evaluateTrailingLogic,
  calculateTakeProfitThreshold,
} from './logic.js';
import { getStats, resetState, removeHighWaterMark } from './state.js';

// Module state
let log = null;
let config = null;
let takeProfitConfig = null;
let initialized = false;

// Default take-profit config if not specified
const DEFAULT_TAKE_PROFIT_CONFIG = {
  enabled: true,
  defaultTakeProfitPct: 0.10,           // 10% default take-profit (fixed mode)
  trailingEnabled: false,               // Use trailing stop instead of fixed
  trailingActivationPct: 0.15,          // 15% profit to activate trailing
  trailingPullbackPct: 0.10,            // 10% pullback from HWM to trigger exit
  minProfitFloorPct: 0.05,              // 5% minimum profit to lock in
};

/**
 * Initialize the take-profit module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.strategy] - Strategy configuration
 * @param {Object} [cfg.strategy.takeProfit] - Take-profit configuration
 * @param {boolean} [cfg.strategy.takeProfit.enabled=true] - Enable/disable take-profit evaluation
 * @param {number} [cfg.strategy.takeProfit.defaultTakeProfitPct=0.10] - Default take-profit percentage (0-1)
 * @param {boolean} [cfg.strategy.takeProfit.trailingEnabled=false] - Use trailing stop mode
 * @param {number} [cfg.strategy.takeProfit.trailingActivationPct=0.15] - Profit % to activate trailing
 * @param {number} [cfg.strategy.takeProfit.trailingPullbackPct=0.10] - Pullback % from HWM to trigger
 * @param {number} [cfg.strategy.takeProfit.minProfitFloorPct=0.05] - Minimum profit % to lock in
 * @returns {Promise<void>}
 * @throws {TakeProfitError} If configuration is invalid
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'take-profit' });
  config = cfg;

  log.info('module_init_start');

  // Extract and validate take-profit config
  const strategyTakeProfitConfig = cfg?.strategy?.takeProfit || {};
  takeProfitConfig = {
    enabled: strategyTakeProfitConfig.enabled ?? DEFAULT_TAKE_PROFIT_CONFIG.enabled,
    defaultTakeProfitPct: strategyTakeProfitConfig.defaultTakeProfitPct ?? DEFAULT_TAKE_PROFIT_CONFIG.defaultTakeProfitPct,
    trailingEnabled: strategyTakeProfitConfig.trailingEnabled ?? DEFAULT_TAKE_PROFIT_CONFIG.trailingEnabled,
    trailingActivationPct: strategyTakeProfitConfig.trailingActivationPct ?? DEFAULT_TAKE_PROFIT_CONFIG.trailingActivationPct,
    trailingPullbackPct: strategyTakeProfitConfig.trailingPullbackPct ?? DEFAULT_TAKE_PROFIT_CONFIG.trailingPullbackPct,
    minProfitFloorPct: strategyTakeProfitConfig.minProfitFloorPct ?? DEFAULT_TAKE_PROFIT_CONFIG.minProfitFloorPct,
  };

  // Validate config values
  validateConfig(takeProfitConfig);

  initialized = true;
  log.info('module_initialized', {
    take_profit: {
      enabled: takeProfitConfig.enabled,
      default_take_profit_pct: takeProfitConfig.defaultTakeProfitPct,
      trailing_enabled: takeProfitConfig.trailingEnabled,
      trailing_activation_pct: takeProfitConfig.trailingActivationPct,
      trailing_pullback_pct: takeProfitConfig.trailingPullbackPct,
      min_profit_floor_pct: takeProfitConfig.minProfitFloorPct,
    },
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Take-profit config
 * @throws {TakeProfitError} If validation fails
 * @private
 */
function validateConfig(cfg) {
  if (typeof cfg.enabled !== 'boolean') {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'enabled must be a boolean',
      { enabled: cfg.enabled }
    );
  }

  if (typeof cfg.defaultTakeProfitPct !== 'number' || cfg.defaultTakeProfitPct < 0 || cfg.defaultTakeProfitPct > 1) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'defaultTakeProfitPct must be a number between 0 and 1',
      { defaultTakeProfitPct: cfg.defaultTakeProfitPct }
    );
  }

  if (typeof cfg.trailingEnabled !== 'boolean') {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'trailingEnabled must be a boolean',
      { trailingEnabled: cfg.trailingEnabled }
    );
  }

  if (typeof cfg.trailingActivationPct !== 'number' || cfg.trailingActivationPct < 0 || cfg.trailingActivationPct > 1) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'trailingActivationPct must be a number between 0 and 1',
      { trailingActivationPct: cfg.trailingActivationPct }
    );
  }

  if (typeof cfg.trailingPullbackPct !== 'number' || cfg.trailingPullbackPct < 0 || cfg.trailingPullbackPct > 1) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'trailingPullbackPct must be a number between 0 and 1',
      { trailingPullbackPct: cfg.trailingPullbackPct }
    );
  }

  if (typeof cfg.minProfitFloorPct !== 'number' || cfg.minProfitFloorPct < 0 || cfg.minProfitFloorPct > 1) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'minProfitFloorPct must be a number between 0 and 1',
      { minProfitFloorPct: cfg.minProfitFloorPct }
    );
  }
}

/**
 * Evaluate take-profit condition for a single position
 *
 * Uses trailing mode if configured, otherwise fixed threshold mode.
 *
 * @param {Object} position - Position to evaluate
 * @param {number} position.id - Position ID
 * @param {string} position.window_id - Window identifier
 * @param {string} position.side - 'long' or 'short'
 * @param {number} position.size - Position size
 * @param {number} position.entry_price - Entry price
 * @param {number} [position.take_profit_pct] - Per-position take-profit override
 * @param {number} currentPrice - Current market price
 * @param {Object} [options] - Evaluation options
 * @returns {Object} TakeProfitResult with triggered, reason, action, closeMethod
 * @throws {TakeProfitError} If not initialized or inputs are invalid
 */
export function evaluate(position, currentPrice, options = {}) {
  ensureInitialized();

  if (!takeProfitConfig.enabled) {
    return {
      triggered: false,
      position_id: position.id,
      reason: 'take_profit_disabled',
      action: null,
      closeMethod: null,
    };
  }

  // Use trailing mode if enabled
  if (takeProfitConfig.trailingEnabled) {
    return evaluateTrailingLogic(position, currentPrice, {
      trailingActivationPct: takeProfitConfig.trailingActivationPct,
      trailingPullbackPct: takeProfitConfig.trailingPullbackPct,
      minProfitFloorPct: takeProfitConfig.minProfitFloorPct,
      log,
      ...options,
    });
  }

  // Fixed threshold mode
  return evaluateLogic(position, currentPrice, {
    takeProfitPct: takeProfitConfig.defaultTakeProfitPct,
    log,
    ...options,
  });
}

/**
 * Evaluate take-profit for all positions
 *
 * Uses trailing mode if configured, otherwise fixed threshold mode.
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} [options] - Evaluation options
 * @returns {Object} { triggered: TakeProfitResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  ensureInitialized();

  if (!takeProfitConfig.enabled) {
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
    takeProfitPct: takeProfitConfig.defaultTakeProfitPct,
    trailingEnabled: takeProfitConfig.trailingEnabled,
    trailingActivationPct: takeProfitConfig.trailingActivationPct,
    trailingPullbackPct: takeProfitConfig.trailingPullbackPct,
    minProfitFloorPct: takeProfitConfig.minProfitFloorPct,
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
    config: takeProfitConfig ? {
      enabled: takeProfitConfig.enabled,
      default_take_profit_pct: takeProfitConfig.defaultTakeProfitPct,
      trailing_enabled: takeProfitConfig.trailingEnabled,
      trailing_activation_pct: takeProfitConfig.trailingActivationPct,
      trailing_pullback_pct: takeProfitConfig.trailingPullbackPct,
      min_profit_floor_pct: takeProfitConfig.minProfitFloorPct,
    } : null,
    ...getStats(),
  };
}

/**
 * Clean up high-water mark tracking for a closed position
 *
 * Call this after a position is closed to free up memory.
 *
 * @param {number|string} positionId - Position ID to clean up
 */
export function cleanupPosition(positionId) {
  removeHighWaterMark(positionId);
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
  takeProfitConfig = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {TakeProfitError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.NOT_INITIALIZED,
      'Take-profit module not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  TakeProfitError,
  TakeProfitErrorCodes,
  TriggerReason,
  createTakeProfitResult,
} from './types.js';
