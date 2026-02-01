/**
 * Signal Outcome Logger Module
 *
 * Tracks every oracle edge signal's outcome against actual settlement
 * to measure whether the oracle edge hypothesis works.
 *
 * Key Features:
 * - Log complete signal state at generation time
 * - Update signal records on window settlement
 * - Queryable signal performance analytics
 * - Automatic subscription to signal/settlement events
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/signal-outcome-logger
 */

import { child } from '../logger/index.js';
import * as database from '../../persistence/database.js';
import { SignalOutcomeLogger } from './logger.js';
import {
  SignalOutcomeLoggerError,
  SignalOutcomeLoggerErrorCodes,
  DEFAULT_CONFIG,
  BucketType,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let logger = null;
let config = null;

// Optional module references (loaded dynamically)
let oracleEdgeSignalModule = null;

/**
 * Initialize the signal outcome logger module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.signalOutcomeLogger] - Signal outcome logger configuration
 * @param {boolean} [cfg.signalOutcomeLogger.autoSubscribeToSignals=true] - Auto-subscribe to signals
 * @param {boolean} [cfg.signalOutcomeLogger.autoSubscribeToSettlements=true] - Auto-subscribe to settlements
 * @param {number} [cfg.signalOutcomeLogger.defaultPositionSize=1] - Default position size for PnL
 * @param {number} [cfg.signalOutcomeLogger.retentionDays=30] - Days to retain signal data
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Create child logger
  log = child({ module: 'signal-outcome-logger' });
  log.info('module_init_start');

  // Extract signal outcome logger config
  const signalOutcomeLoggerConfig = cfg.signalOutcomeLogger || {};
  config = {
    autoSubscribeToSignals: signalOutcomeLoggerConfig.autoSubscribeToSignals ?? DEFAULT_CONFIG.autoSubscribeToSignals,
    autoSubscribeToSettlements: signalOutcomeLoggerConfig.autoSubscribeToSettlements ?? DEFAULT_CONFIG.autoSubscribeToSettlements,
    defaultPositionSize: signalOutcomeLoggerConfig.defaultPositionSize ?? DEFAULT_CONFIG.defaultPositionSize,
    retentionDays: signalOutcomeLoggerConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
  };

  // Validate config values
  validateConfig(config);

  // Create logger instance
  logger = new SignalOutcomeLogger({
    config,
    logger: log,
    db: database,
  });

  // Load and subscribe to optional modules
  if (config.autoSubscribeToSignals) {
    await loadAndSubscribeToSignals();
  }

  // Note: Settlement subscription would come from orchestrator/window-manager
  // For now, leave it manual - orchestrator can call subscribeToSettlements

  initialized = true;
  log.info('signal_outcome_logger_initialized', {
    config: {
      autoSubscribeToSignals: config.autoSubscribeToSignals,
      autoSubscribeToSettlements: config.autoSubscribeToSettlements,
      defaultPositionSize: config.defaultPositionSize,
    },
    signal_subscription_active: oracleEdgeSignalModule !== null,
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Configuration to validate
 * @throws {SignalOutcomeLoggerError} If config is invalid
 */
function validateConfig(cfg) {
  if (typeof cfg.defaultPositionSize !== 'number' || cfg.defaultPositionSize <= 0) {
    throw new SignalOutcomeLoggerError(
      SignalOutcomeLoggerErrorCodes.INVALID_CONFIG,
      'defaultPositionSize must be a positive number',
      { defaultPositionSize: cfg.defaultPositionSize }
    );
  }

  if (typeof cfg.retentionDays !== 'number' || cfg.retentionDays <= 0 || !Number.isInteger(cfg.retentionDays)) {
    throw new SignalOutcomeLoggerError(
      SignalOutcomeLoggerErrorCodes.INVALID_CONFIG,
      'retentionDays must be a positive integer',
      { retentionDays: cfg.retentionDays }
    );
  }
}

/**
 * Load oracle-edge-signal module and subscribe to signals
 */
async function loadAndSubscribeToSignals() {
  try {
    oracleEdgeSignalModule = await import('../oracle-edge-signal/index.js');
    logger.subscribeToSignals(oracleEdgeSignalModule);
    log.info('oracle_edge_signal_loaded');
  } catch (err) {
    log.warn('oracle_edge_signal_unavailable', { error: err.message });
    oracleEdgeSignalModule = null;
  }
}

/**
 * Log a signal at generation time
 *
 * @param {Object} signal - Signal from oracle-edge-signal module
 * @returns {Promise<number>} Inserted signal ID
 * @throws {SignalOutcomeLoggerError} If not initialized or invalid signal
 */
export async function logSignal(signal) {
  ensureInitialized();
  return logger.logSignal(signal);
}

/**
 * Update signal record with settlement outcome
 *
 * @param {string} windowId - Window identifier
 * @param {Object} settlementData - Settlement data
 * @returns {Promise<boolean>} True if update succeeded
 * @throws {SignalOutcomeLoggerError} If not initialized or invalid data
 */
export async function updateOutcome(windowId, settlementData) {
  ensureInitialized();
  return logger.updateOutcome(windowId, settlementData);
}

/**
 * Get overall signal statistics
 *
 * @returns {Object} Statistics including win rate, PnL, etc.
 * @throws {SignalOutcomeLoggerError} If not initialized
 */
export function getStats() {
  ensureInitialized();
  return logger.getStats();
}

/**
 * Get statistics grouped by bucket type
 *
 * @param {string} bucketType - One of 'time_to_expiry', 'staleness', 'confidence', 'symbol'
 * @returns {Array} Array of bucket statistics
 * @throws {SignalOutcomeLoggerError} If not initialized
 */
export function getStatsByBucket(bucketType) {
  ensureInitialized();
  return logger.getStatsByBucket(bucketType);
}

/**
 * Get recent signals with outcomes
 *
 * @param {number} limit - Maximum number of signals to return
 * @returns {Array} Array of recent signal records
 * @throws {SignalOutcomeLoggerError} If not initialized
 */
export function getRecentSignals(limit = 50) {
  ensureInitialized();
  return logger.getRecentSignals(limit);
}

/**
 * Subscribe to settlement events manually
 * Call this from orchestrator/window-manager to enable auto-outcome updates
 *
 * @param {Function} subscribeToSettlements - Function that takes callback and returns unsubscribe
 */
export function subscribeToSettlements(subscribeToSettlements) {
  ensureInitialized();
  logger.subscribeToSettlements(subscribeToSettlements);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized || !logger) {
    return {
      initialized: false,
      stats: {
        total_signals: 0,
        signals_with_outcome: 0,
        pending_outcomes: 0,
        win_rate: 0,
        total_pnl: 0,
        avg_confidence: 0,
      },
      subscriptions: {
        signal_generator: false,
        settlements: false,
      },
      config: null,
    };
  }

  const stats = logger.getStats();
  const internalStats = logger.getInternalStats();

  return {
    initialized: true,
    stats,
    internal_stats: internalStats,
    subscriptions: {
      signal_generator: oracleEdgeSignalModule !== null,
      settlements: logger.subscriptions.settlements !== null,
    },
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

  // Clear subscriptions
  if (logger) {
    logger.clearSubscriptions();
    logger = null;
  }

  // Clear module references
  oracleEdgeSignalModule = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}

/**
 * Internal: Ensure module is initialized
 * @throws {SignalOutcomeLoggerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new SignalOutcomeLoggerError(
      SignalOutcomeLoggerErrorCodes.NOT_INITIALIZED,
      'Signal outcome logger not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { SignalOutcomeLoggerError, SignalOutcomeLoggerErrorCodes, BucketType };
