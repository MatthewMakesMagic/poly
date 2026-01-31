/**
 * Position Sizer Module
 *
 * Public interface for position sizing.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Size positions based on strategy config and available liquidity
 * - Enforce exposure caps and position limits
 * - Track sizing statistics
 *
 * @module modules/position-sizer
 */

import { child } from '../logger/index.js';
import { PositionSizerError, PositionSizerErrorCodes, AdjustmentReason } from './types.js';
import { calculateSize as calculateSizeLogic } from './sizing-logic.js';
import { getStats, recordSizing, resetState } from './state.js';

// Module state
let log = null;
let config = null;
let sizingConfig = null;
let riskConfig = null;
let initialized = false;

// Default sizing config if not specified
const DEFAULT_SIZING_CONFIG = {
  baseSizeDollars: 10,
  minSizeDollars: 1,
  maxSlippagePct: 0.01,
  confidenceMultiplier: 0,
};

// Default risk config if not specified
const DEFAULT_RISK_CONFIG = {
  maxPositionSize: 100,
  maxExposure: 500,
};

/**
 * Initialize the position sizer module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.strategy] - Strategy configuration
 * @param {Object} [cfg.strategy.sizing] - Sizing configuration
 * @param {number} [cfg.strategy.sizing.baseSizeDollars] - Base position size in dollars
 * @param {number} [cfg.strategy.sizing.minSizeDollars] - Minimum tradeable size
 * @param {number} [cfg.strategy.sizing.maxSlippagePct] - Maximum acceptable slippage
 * @param {number} [cfg.strategy.sizing.confidenceMultiplier] - Confidence-based size adjustment
 * @param {Object} [cfg.risk] - Risk configuration
 * @param {number} [cfg.risk.maxPositionSize] - Maximum size per position
 * @param {number} [cfg.risk.maxExposure] - Maximum total exposure
 * @returns {Promise<void>}
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'position-sizer' });
  config = cfg;

  log.info('module_init_start');

  // Extract and validate sizing config
  const strategySizingConfig = cfg?.strategy?.sizing || {};
  sizingConfig = {
    baseSizeDollars: strategySizingConfig.baseSizeDollars ?? DEFAULT_SIZING_CONFIG.baseSizeDollars,
    minSizeDollars: strategySizingConfig.minSizeDollars ?? DEFAULT_SIZING_CONFIG.minSizeDollars,
    maxSlippagePct: strategySizingConfig.maxSlippagePct ?? DEFAULT_SIZING_CONFIG.maxSlippagePct,
    confidenceMultiplier: strategySizingConfig.confidenceMultiplier ?? DEFAULT_SIZING_CONFIG.confidenceMultiplier,
  };

  // Extract risk config
  riskConfig = {
    maxPositionSize: cfg?.risk?.maxPositionSize ?? DEFAULT_RISK_CONFIG.maxPositionSize,
    maxExposure: cfg?.risk?.maxExposure ?? DEFAULT_RISK_CONFIG.maxExposure,
  };

  // Validate config values
  validateConfig(sizingConfig, riskConfig);

  initialized = true;
  log.info('module_initialized', {
    sizing: {
      base_size_dollars: sizingConfig.baseSizeDollars,
      min_size_dollars: sizingConfig.minSizeDollars,
      max_slippage_pct: sizingConfig.maxSlippagePct,
      confidence_multiplier: sizingConfig.confidenceMultiplier,
    },
    risk: {
      max_position_size: riskConfig.maxPositionSize,
      max_exposure: riskConfig.maxExposure,
    },
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} sizing - Sizing config
 * @param {Object} risk - Risk config
 * @throws {PositionSizerError} If validation fails
 * @private
 */
function validateConfig(sizing, risk) {
  // Validate sizing config
  if (typeof sizing.baseSizeDollars !== 'number' || sizing.baseSizeDollars <= 0) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'baseSizeDollars must be a positive number',
      { baseSizeDollars: sizing.baseSizeDollars }
    );
  }

  if (typeof sizing.minSizeDollars !== 'number' || sizing.minSizeDollars <= 0) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'minSizeDollars must be a positive number',
      { minSizeDollars: sizing.minSizeDollars }
    );
  }

  if (sizing.minSizeDollars > sizing.baseSizeDollars) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'minSizeDollars cannot exceed baseSizeDollars',
      { minSizeDollars: sizing.minSizeDollars, baseSizeDollars: sizing.baseSizeDollars }
    );
  }

  if (typeof sizing.maxSlippagePct !== 'number' || sizing.maxSlippagePct <= 0 || sizing.maxSlippagePct >= 1) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'maxSlippagePct must be a number between 0 and 1 (exclusive)',
      { maxSlippagePct: sizing.maxSlippagePct }
    );
  }

  if (typeof sizing.confidenceMultiplier !== 'number' || sizing.confidenceMultiplier < 0) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'confidenceMultiplier must be a non-negative number',
      { confidenceMultiplier: sizing.confidenceMultiplier }
    );
  }

  // Validate risk config
  if (typeof risk.maxPositionSize !== 'number' || risk.maxPositionSize <= 0) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'maxPositionSize must be a positive number',
      { maxPositionSize: risk.maxPositionSize }
    );
  }

  if (typeof risk.maxExposure !== 'number' || risk.maxExposure <= 0) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.CONFIG_INVALID,
      'maxExposure must be a positive number',
      { maxExposure: risk.maxExposure }
    );
  }
}

/**
 * Calculate position size for an entry signal
 *
 * @param {Object} signal - Entry signal from strategy-evaluator
 * @param {string} signal.window_id - Window identifier
 * @param {string} signal.market_id - Market identifier
 * @param {string} [signal.token_id] - Token identifier
 * @param {string} signal.direction - 'long' or 'short'
 * @param {number} [signal.confidence] - Signal confidence (0.0-1.0)
 * @param {Object} options - Sizing options
 * @param {Function} [options.getOrderBook] - Polymarket orderbook fetch function
 * @param {Function} [options.getCurrentExposure] - Position manager exposure function
 * @returns {Promise<Object>} Sizing result with all fields
 */
export async function calculateSize(signal, options = {}) {
  ensureInitialized();

  // Validate signal
  if (!signal || typeof signal !== 'object') {
    throw new PositionSizerError(
      PositionSizerErrorCodes.INVALID_SIGNAL,
      'Invalid signal: must be an object',
      { signal }
    );
  }

  if (!signal.window_id) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.INVALID_SIGNAL,
      'Invalid signal: missing window_id',
      { signal }
    );
  }

  if (!signal.direction || !['long', 'short'].includes(signal.direction)) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.INVALID_SIGNAL,
      'Invalid signal: direction must be "long" or "short"',
      { signal }
    );
  }

  // Calculate size
  const result = await calculateSizeLogic(signal, {
    sizingConfig,
    riskConfig,
    getOrderBook: options.getOrderBook,
    getCurrentExposure: options.getCurrentExposure,
    log,
  });

  // Record stats
  recordSizing(result.success, result.adjustment_reason);

  return result;
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including initialization status and stats
 */
export function getState() {
  return {
    initialized,
    config: sizingConfig ? {
      base_size_dollars: sizingConfig.baseSizeDollars,
      min_size_dollars: sizingConfig.minSizeDollars,
      max_slippage_pct: sizingConfig.maxSlippagePct,
      confidence_multiplier: sizingConfig.confidenceMultiplier,
    } : null,
    risk: riskConfig ? {
      max_position_size: riskConfig.maxPositionSize,
      max_exposure: riskConfig.maxExposure,
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
  sizingConfig = null;
  riskConfig = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {PositionSizerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new PositionSizerError(
      PositionSizerErrorCodes.NOT_INITIALIZED,
      'Position sizer not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  PositionSizerError,
  PositionSizerErrorCodes,
  AdjustmentReason,
} from './types.js';
