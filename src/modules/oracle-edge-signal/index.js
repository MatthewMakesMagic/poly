/**
 * Oracle Edge Signal Generator Module
 *
 * Evaluates trading windows for oracle edge entry conditions and generates
 * entry signals when UI/Oracle divergence exists near expiry with stale oracle.
 *
 * Key Features:
 * - Signal generation based on 5 conditions (time, staleness, direction, divergence, conviction)
 * - Direction determination (FADE_UP vs FADE_DOWN)
 * - Confidence calculation (0-1 scale)
 * - Event subscription for signal events
 * - Integration with staleness-detector and divergence-tracker
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/oracle-edge-signal
 */

import { child } from '../logger/index.js';
import { OracleEdgeSignalGenerator } from './generator.js';
import {
  OracleEdgeSignalError,
  OracleEdgeSignalErrorCodes,
  SignalDirection,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let generator = null;
let config = null;

// Optional module references (loaded dynamically)
let stalenessDetectorModule = null;
let divergenceTrackerModule = null;

/**
 * Initialize the oracle edge signal generator module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.oracleEdgeSignal] - Oracle edge signal configuration
 * @param {number} [cfg.oracleEdgeSignal.maxTimeThresholdMs=30000] - Max time before expiry
 * @param {number} [cfg.oracleEdgeSignal.minStalenessMs=15000] - Min oracle staleness
 * @param {number} [cfg.oracleEdgeSignal.strikeThreshold=0.05] - Strike threshold (5%)
 * @param {number} [cfg.oracleEdgeSignal.chainlinkDeviationThresholdPct=0.005] - Max divergence (0.5%)
 * @param {number} [cfg.oracleEdgeSignal.confidenceThreshold=0.65] - Min market conviction
 * @param {number} [cfg.oracleEdgeSignal.evaluationIntervalMs=500] - Evaluation interval
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Create child logger
  log = child({ module: 'oracle-edge-signal' });
  log.info('module_init_start');

  // Extract oracle edge signal config
  const oracleEdgeSignalConfig = cfg.oracleEdgeSignal || {};
  config = {
    maxTimeThresholdMs: oracleEdgeSignalConfig.maxTimeThresholdMs ?? DEFAULT_CONFIG.maxTimeThresholdMs,
    minStalenessMs: oracleEdgeSignalConfig.minStalenessMs ?? DEFAULT_CONFIG.minStalenessMs,
    strikeThreshold: oracleEdgeSignalConfig.strikeThreshold ?? DEFAULT_CONFIG.strikeThreshold,
    chainlinkDeviationThresholdPct: oracleEdgeSignalConfig.chainlinkDeviationThresholdPct ?? DEFAULT_CONFIG.chainlinkDeviationThresholdPct,
    confidenceThreshold: oracleEdgeSignalConfig.confidenceThreshold ?? DEFAULT_CONFIG.confidenceThreshold,
    evaluationIntervalMs: oracleEdgeSignalConfig.evaluationIntervalMs ?? DEFAULT_CONFIG.evaluationIntervalMs,
  };

  // Validate config
  validateConfig(config);

  // Load dependency modules
  await loadDependencyModules();

  // Create generator instance
  generator = new OracleEdgeSignalGenerator({
    config,
    logger: log,
    stalenessDetector: stalenessDetectorModule,
    divergenceTracker: divergenceTrackerModule,
  });

  initialized = true;
  log.info('oracle_edge_signal_initialized', {
    config: {
      maxTimeThresholdMs: config.maxTimeThresholdMs,
      minStalenessMs: config.minStalenessMs,
      strikeThreshold: config.strikeThreshold,
      chainlinkDeviationThresholdPct: config.chainlinkDeviationThresholdPct,
      confidenceThreshold: config.confidenceThreshold,
    },
    staleness_detector_available: stalenessDetectorModule !== null,
    divergence_tracker_available: divergenceTrackerModule !== null,
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Configuration to validate
 * @throws {OracleEdgeSignalError} If config is invalid
 */
function validateConfig(cfg) {
  if (cfg.maxTimeThresholdMs <= 0) {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.INVALID_CONFIG,
      'maxTimeThresholdMs must be positive',
      { maxTimeThresholdMs: cfg.maxTimeThresholdMs }
    );
  }

  if (cfg.minStalenessMs <= 0) {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.INVALID_CONFIG,
      'minStalenessMs must be positive',
      { minStalenessMs: cfg.minStalenessMs }
    );
  }

  if (cfg.strikeThreshold <= 0 || cfg.strikeThreshold >= 0.5) {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.INVALID_CONFIG,
      'strikeThreshold must be between 0 and 0.5',
      { strikeThreshold: cfg.strikeThreshold }
    );
  }

  if (cfg.chainlinkDeviationThresholdPct <= 0) {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.INVALID_CONFIG,
      'chainlinkDeviationThresholdPct must be positive',
      { chainlinkDeviationThresholdPct: cfg.chainlinkDeviationThresholdPct }
    );
  }

  if (cfg.confidenceThreshold <= 0 || cfg.confidenceThreshold >= 1) {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.INVALID_CONFIG,
      'confidenceThreshold must be between 0 and 1',
      { confidenceThreshold: cfg.confidenceThreshold }
    );
  }
}

/**
 * Load dependency modules (staleness-detector, divergence-tracker)
 * These are required for full functionality.
 */
async function loadDependencyModules() {
  // Try to load staleness-detector
  try {
    stalenessDetectorModule = await import('../staleness-detector/index.js');
    log.info('staleness_detector_loaded');
  } catch (err) {
    log.warn('staleness_detector_unavailable', { error: err.message });
    stalenessDetectorModule = null;
  }

  // Try to load divergence-tracker
  try {
    divergenceTrackerModule = await import('../divergence-tracker/index.js');
    log.info('divergence_tracker_loaded');
  } catch (err) {
    log.warn('divergence_tracker_unavailable', { error: err.message });
    divergenceTrackerModule = null;
  }
}

/**
 * Evaluate a single window for oracle edge signal
 *
 * @param {Object} windowData - Window from window-manager
 * @returns {Object|null} Signal object or null if no signal
 * @throws {OracleEdgeSignalError} If not initialized
 */
export function evaluateWindow(windowData) {
  ensureInitialized();
  return generator.evaluateWindow(windowData);
}

/**
 * Evaluate multiple windows for oracle edge signals
 *
 * @param {Object[]} windows - Array of window data objects
 * @returns {Object[]} Array of generated signals (empty if none)
 * @throws {OracleEdgeSignalError} If not initialized
 */
export function evaluateAllWindows(windows) {
  ensureInitialized();
  return generator.evaluateAllWindows(windows);
}

/**
 * Subscribe to signal generation events
 *
 * @param {Function} callback - Callback invoked on signal generation
 *   callback receives: { window_id, symbol, direction, confidence, token_id, side, inputs, generated_at }
 * @returns {Function} Unsubscribe function
 * @throws {OracleEdgeSignalError} If not initialized
 */
export function subscribe(callback) {
  ensureInitialized();

  if (typeof callback !== 'function') {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.SUBSCRIPTION_FAILED,
      'Callback must be a function'
    );
  }

  return generator.subscribe(callback);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including:
 *   - initialized: boolean
 *   - stats: signal generation statistics
 *   - config: current configuration
 */
export function getState() {
  if (!initialized || !generator) {
    return {
      initialized: false,
      stats: {
        signals_generated: 0,
        evaluations_total: 0,
        signals_by_direction: {
          fade_up: 0,
          fade_down: 0,
        },
        signals_by_symbol: {},
        avg_confidence: 0,
      },
      config: null,
    };
  }

  return {
    initialized: true,
    stats: generator.getStats(),
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

  // Clear generator subscriptions
  if (generator) {
    generator.clearSubscriptions();
    generator = null;
  }

  // Clear module references
  stalenessDetectorModule = null;
  divergenceTrackerModule = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}

/**
 * Internal: Ensure module is initialized
 * @throws {OracleEdgeSignalError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new OracleEdgeSignalError(
      OracleEdgeSignalErrorCodes.NOT_INITIALIZED,
      'Oracle edge signal generator not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { OracleEdgeSignalError, OracleEdgeSignalErrorCodes, SignalDirection };
