/**
 * Quality Gate Module
 *
 * Automatically disables strategies when signal quality degrades.
 * Monitors rolling accuracy, feed health, and pattern changes.
 *
 * Key Features:
 * - Rolling accuracy calculation over configurable window
 * - Accuracy threshold enforcement (auto-disable below threshold)
 * - Feed health detection (oracle feed availability)
 * - Pattern change detection (update frequency/spread changes)
 * - Manual re-enable required after disable
 *
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * @module modules/quality-gate
 */

import { child } from '../logger/index.js';
import * as database from '../../persistence/database.js';
import { QualityGateEvaluator } from './evaluator.js';
import {
  QualityGateError,
  QualityGateErrorCodes,
  DisableReason,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let initialized = false;
let evaluator = null;
let config = null;

// Optional module references (loaded dynamically)
let rtdsClientModule = null;

/**
 * Initialize the quality gate module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.qualityGate] - Quality gate configuration
 * @param {boolean} [cfg.qualityGate.enabled=true] - Enable/disable quality gate
 * @param {number} [cfg.qualityGate.evaluationIntervalMs=60000] - Evaluation interval
 * @param {number} [cfg.qualityGate.rollingWindowSize=20] - Rolling window size
 * @param {number} [cfg.qualityGate.minAccuracyThreshold=0.40] - Min accuracy threshold
 * @param {number} [cfg.qualityGate.feedUnavailableThresholdMs=10000] - Feed unavailable threshold
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  // Create child logger
  log = child({ module: 'quality-gate' });
  log.info('module_init_start');

  // Extract quality gate config
  const qualityGateConfig = cfg.qualityGate || {};
  config = {
    enabled: qualityGateConfig.enabled ?? DEFAULT_CONFIG.enabled,
    evaluationIntervalMs: qualityGateConfig.evaluationIntervalMs ?? DEFAULT_CONFIG.evaluationIntervalMs,
    rollingWindowSize: qualityGateConfig.rollingWindowSize ?? DEFAULT_CONFIG.rollingWindowSize,
    minAccuracyThreshold: qualityGateConfig.minAccuracyThreshold ?? DEFAULT_CONFIG.minAccuracyThreshold,
    feedUnavailableThresholdMs: qualityGateConfig.feedUnavailableThresholdMs ?? DEFAULT_CONFIG.feedUnavailableThresholdMs,
    patternChangeThreshold: qualityGateConfig.patternChangeThreshold ?? DEFAULT_CONFIG.patternChangeThreshold,
    spreadBehaviorStdDev: qualityGateConfig.spreadBehaviorStdDev ?? DEFAULT_CONFIG.spreadBehaviorStdDev,
    patternCheckFrequency: qualityGateConfig.patternCheckFrequency ?? DEFAULT_CONFIG.patternCheckFrequency,
    minSignalsForEvaluation: qualityGateConfig.minSignalsForEvaluation ?? DEFAULT_CONFIG.minSignalsForEvaluation,
  };

  // Validate config values
  validateConfig(config);

  // Create evaluator instance
  evaluator = new QualityGateEvaluator({
    config,
    logger: log,
    db: database,
  });

  // Load and subscribe to optional modules
  await loadDependencies();

  // Start periodic evaluation if enabled
  if (config.enabled) {
    evaluator.startPeriodicEvaluation(config.evaluationIntervalMs);
  }

  initialized = true;
  log.info('quality_gate_initialized', {
    config: {
      enabled: config.enabled,
      evaluationIntervalMs: config.evaluationIntervalMs,
      rollingWindowSize: config.rollingWindowSize,
      minAccuracyThreshold: config.minAccuracyThreshold,
    },
    rtds_subscription_active: rtdsClientModule !== null,
  });
}

/**
 * Validate configuration values
 *
 * @param {Object} cfg - Configuration to validate
 * @throws {QualityGateError} If config is invalid
 */
function validateConfig(cfg) {
  if (typeof cfg.evaluationIntervalMs !== 'number' || cfg.evaluationIntervalMs < 1000) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'evaluationIntervalMs must be at least 1000ms',
      { evaluationIntervalMs: cfg.evaluationIntervalMs }
    );
  }

  if (typeof cfg.rollingWindowSize !== 'number' || cfg.rollingWindowSize < 1) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'rollingWindowSize must be at least 1',
      { rollingWindowSize: cfg.rollingWindowSize }
    );
  }

  if (typeof cfg.minAccuracyThreshold !== 'number' ||
      cfg.minAccuracyThreshold < 0 || cfg.minAccuracyThreshold > 1) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'minAccuracyThreshold must be between 0 and 1',
      { minAccuracyThreshold: cfg.minAccuracyThreshold }
    );
  }

  if (typeof cfg.feedUnavailableThresholdMs !== 'number' || cfg.feedUnavailableThresholdMs < 1000) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'feedUnavailableThresholdMs must be at least 1000ms',
      { feedUnavailableThresholdMs: cfg.feedUnavailableThresholdMs }
    );
  }

  if (typeof cfg.patternChangeThreshold !== 'number' || cfg.patternChangeThreshold <= 0) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'patternChangeThreshold must be a positive number',
      { patternChangeThreshold: cfg.patternChangeThreshold }
    );
  }

  if (typeof cfg.spreadBehaviorStdDev !== 'number' || cfg.spreadBehaviorStdDev <= 0) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'spreadBehaviorStdDev must be a positive number',
      { spreadBehaviorStdDev: cfg.spreadBehaviorStdDev }
    );
  }

  if (typeof cfg.patternCheckFrequency !== 'number' || cfg.patternCheckFrequency < 1 || !Number.isInteger(cfg.patternCheckFrequency)) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'patternCheckFrequency must be a positive integer',
      { patternCheckFrequency: cfg.patternCheckFrequency }
    );
  }

  if (typeof cfg.minSignalsForEvaluation !== 'number' || cfg.minSignalsForEvaluation < 1 || !Number.isInteger(cfg.minSignalsForEvaluation)) {
    throw new QualityGateError(
      QualityGateErrorCodes.INVALID_CONFIG,
      'minSignalsForEvaluation must be a positive integer',
      { minSignalsForEvaluation: cfg.minSignalsForEvaluation }
    );
  }
}

/**
 * Load optional dependencies (RTDS client for feed health)
 */
async function loadDependencies() {
  try {
    rtdsClientModule = await import('../../clients/rtds/index.js');

    // Subscribe to oracle feed to track last tick time
    if (rtdsClientModule && typeof rtdsClientModule.subscribe === 'function') {
      rtdsClientModule.subscribe('crypto_prices_chainlink', () => {
        if (evaluator) {
          evaluator.updateOracleTick();
        }
      });
      log.info('rtds_subscription_active');
    }
  } catch (err) {
    log.warn('rtds_client_unavailable', { error: err.message });
    rtdsClientModule = null;
  }
}

/**
 * Force immediate evaluation
 *
 * @returns {Promise<Object>} Evaluation result
 * @throws {QualityGateError} If not initialized
 */
export async function evaluate() {
  ensureInitialized();
  return evaluator.evaluate();
}

/**
 * Check if quality gate has disabled the strategy
 *
 * @returns {boolean} True if disabled
 * @throws {QualityGateError} If not initialized
 */
export function isDisabled() {
  ensureInitialized();
  return evaluator.disabled;
}

/**
 * Check if signals should be allowed
 *
 * @returns {boolean} True if signals should be allowed
 * @throws {QualityGateError} If not initialized
 */
export function shouldAllowSignal() {
  ensureInitialized();
  return evaluator.shouldAllowSignal();
}

/**
 * Manually disable the strategy
 *
 * @param {string} reason - DisableReason value
 * @param {Object} [context] - Additional context
 * @throws {QualityGateError} If not initialized or invalid reason
 */
export function disable(reason, context = {}) {
  ensureInitialized();
  evaluator.disableStrategy(reason, context);
}

/**
 * Manually re-enable the strategy
 *
 * @param {string} userReason - Reason for re-enabling
 * @throws {QualityGateError} If not initialized, not disabled, or no reason provided
 */
export function enable(userReason) {
  ensureInitialized();
  evaluator.enableStrategy(userReason);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state
 */
export function getState() {
  if (!initialized || !evaluator) {
    return {
      initialized: false,
      disabled: false,
      disabledAt: null,
      disableReason: null,
      disableContext: null,
      lastEvaluation: null,
      evaluationCount: 0,
      config: null,
    };
  }

  const evaluatorState = evaluator.getState();

  return {
    initialized: true,
    ...evaluatorState,
  };
}

/**
 * Set callback for when strategy is disabled
 *
 * @param {Function} callback - Called with { reason, context, disabledAt }
 */
export function onDisable(callback) {
  ensureInitialized();
  evaluator.setOnDisable(callback);
}

/**
 * Set callback for when strategy is re-enabled
 *
 * @param {Function} callback - Called with { userReason, enabledAt }
 */
export function onEnable(callback) {
  ensureInitialized();
  evaluator.setOnEnable(callback);
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

  // Stop periodic evaluation and cleanup
  if (evaluator) {
    evaluator.cleanup();
    evaluator = null;
  }

  // Clear module references
  rtdsClientModule = null;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }

  initialized = false;
  config = null;
}

/**
 * Internal: Ensure module is initialized
 * @throws {QualityGateError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new QualityGateError(
      QualityGateErrorCodes.NOT_INITIALIZED,
      'Quality gate not initialized. Call init() first.'
    );
  }
}

// Re-export types and error classes
export { QualityGateError, QualityGateErrorCodes, DisableReason };
