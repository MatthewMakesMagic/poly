/**
 * Divergence Tracker Module
 *
 * Tracks the spread between UI prices (Binance-sourced) and Oracle prices (Chainlink).
 * Calculates raw spread, percentage spread, and direction.
 * Emits events when spread exceeds configurable threshold.
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/divergence-tracker
 */

import { child } from '../logger/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { SUPPORTED_SYMBOLS } from '../../clients/rtds/types.js';
import { DivergenceTracker } from './tracker.js';
import {
  DivergenceTrackerError,
  DivergenceTrackerErrorCodes,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let tracker = null;
let config = null;
let unsubscribers = [];
let snapshotIntervalId = null;

/**
 * Initialize the divergence tracker module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.divergenceTracker] - Divergence tracker configuration
 * @param {number} [cfg.divergenceTracker.thresholdPct=0.003] - Threshold for breach detection (0.3%)
 * @param {number} [cfg.divergenceTracker.snapshotIntervalMs=1000] - Snapshot logging interval
 * @param {boolean} [cfg.divergenceTracker.enableSnapshots=true] - Enable snapshot logging
 * @param {number} [cfg.divergenceTracker.alignedThresholdPct=0.0001] - Threshold for aligned detection
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Defensive cleanup: clear any stale interval from corrupted state
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }

  // Create child logger
  log = child({ module: 'divergence-tracker' });
  log.info('module_init_start');

  // Extract divergence tracker config
  const divergenceTrackerConfig = cfg.divergenceTracker || {};
  config = {
    thresholdPct: divergenceTrackerConfig.thresholdPct ?? DEFAULT_CONFIG.thresholdPct,
    snapshotIntervalMs: divergenceTrackerConfig.snapshotIntervalMs ?? DEFAULT_CONFIG.snapshotIntervalMs,
    enableSnapshots: divergenceTrackerConfig.enableSnapshots ?? DEFAULT_CONFIG.enableSnapshots,
    alignedThresholdPct: divergenceTrackerConfig.alignedThresholdPct ?? DEFAULT_CONFIG.alignedThresholdPct,
  };

  // Create tracker instance
  tracker = new DivergenceTracker({
    logger: log,
    thresholdPct: config.thresholdPct,
    alignedThresholdPct: config.alignedThresholdPct,
  });

  // Subscribe to RTDS client for all symbols
  for (const symbol of SUPPORTED_SYMBOLS) {
    const unsubscribe = rtdsClient.subscribe(symbol, (tick) => {
      handleTick(tick);
    });
    unsubscribers.push(unsubscribe);
  }

  // Setup snapshot logging if enabled
  if (config.enableSnapshots && config.snapshotIntervalMs > 0) {
    snapshotIntervalId = setInterval(() => {
      logSnapshots();
    }, config.snapshotIntervalMs);

    // Allow process to exit even if interval is running
    if (snapshotIntervalId.unref) {
      snapshotIntervalId.unref();
    }
  }

  initialized = true;
  log.info('divergence_tracker_initialized', {
    config: {
      thresholdPct: config.thresholdPct,
      snapshotIntervalMs: config.snapshotIntervalMs,
      enableSnapshots: config.enableSnapshots,
    },
  });
}

/**
 * Handle incoming tick from RTDS
 * @param {Object} tick - Normalized tick { timestamp, topic, symbol, price }
 */
function handleTick(tick) {
  if (!tick || !tick.symbol || !tick.topic) {
    return;
  }

  tracker.updatePrice(tick.symbol, tick.topic, tick.price);
}

/**
 * Log spread snapshots for all symbols with active spreads
 */
function logSnapshots() {
  const spreads = tracker.getAllSpreads();

  for (const symbol of SUPPORTED_SYMBOLS) {
    const spread = spreads[symbol];
    if (spread) {
      log.info('spread_snapshot', {
        symbol,
        ui_price: spread.ui_price,
        oracle_price: spread.oracle_price,
        spread: spread.raw,
        spread_pct: spread.pct,
        direction: spread.direction,
      });
    }
  }
}

/**
 * Get current spread for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @returns {Object|null} Spread data or null if not available
 * @throws {DivergenceTrackerError} If not initialized
 */
export function getSpread(symbol) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new DivergenceTrackerError(
      DivergenceTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  return tracker.getSpread(symbol);
}

/**
 * Subscribe to spread updates for a symbol
 *
 * @param {string} symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {Function} callback - Callback invoked on spread update
 *   callback receives: { symbol, raw, pct, direction, ui_price, oracle_price, last_updated }
 * @returns {Function} Unsubscribe function
 * @throws {DivergenceTrackerError} If not initialized or invalid symbol
 */
export function subscribe(symbol, callback) {
  ensureInitialized();

  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    throw new DivergenceTrackerError(
      DivergenceTrackerErrorCodes.INVALID_SYMBOL,
      `Invalid symbol: ${symbol}. Supported: ${SUPPORTED_SYMBOLS.join(', ')}`,
      { symbol }
    );
  }

  if (typeof callback !== 'function') {
    throw new DivergenceTrackerError(
      DivergenceTrackerErrorCodes.SUBSCRIPTION_FAILED,
      'Callback must be a function',
      { symbol }
    );
  }

  return tracker.subscribeToSpread(symbol, callback);
}

/**
 * Subscribe to threshold breach events
 *
 * @param {Function} callback - Callback invoked on breach event
 *   callback receives: { type, symbol, spread_pct, threshold_pct, direction?, breach_duration_ms?, timestamp }
 * @returns {Function} Unsubscribe function
 * @throws {DivergenceTrackerError} If not initialized
 */
export function subscribeToBreaches(callback) {
  ensureInitialized();

  if (typeof callback !== 'function') {
    throw new DivergenceTrackerError(
      DivergenceTrackerErrorCodes.SUBSCRIPTION_FAILED,
      'Callback must be a function'
    );
  }

  return tracker.subscribeToBreaches(callback);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including:
 *   - initialized: boolean
 *   - spreads: { [symbol]: spread data }
 *   - breaches: { [symbol]: breach state }
 *   - stats: { ticks_processed, breaches_detected, last_breach_at }
 *   - config: { thresholdPct, snapshotIntervalMs, enableSnapshots }
 */
export function getState() {
  if (!initialized || !tracker) {
    return {
      initialized: false,
      spreads: {},
      breaches: {},
      stats: {
        ticks_processed: 0,
        breaches_detected: 0,
        last_breach_at: null,
      },
      config: null,
    };
  }

  return {
    initialized: true,
    spreads: tracker.getAllSpreads(),
    breaches: tracker.getBreachStates(),
    stats: tracker.getStats(),
    config: { ...config },
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

  // Clear snapshot interval
  if (snapshotIntervalId) {
    clearInterval(snapshotIntervalId);
    snapshotIntervalId = null;
  }

  // Unsubscribe from RTDS
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors
    }
  }
  unsubscribers = [];

  // Clear tracker subscriptions
  if (tracker) {
    tracker.clearSubscriptions();
    tracker = null;
  }

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}

/**
 * Internal: Ensure module is initialized
 * @throws {DivergenceTrackerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new DivergenceTrackerError(
      DivergenceTrackerErrorCodes.NOT_INITIALIZED,
      'Divergence tracker not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { DivergenceTrackerError, DivergenceTrackerErrorCodes };
