/**
 * Launch Config Module
 *
 * Manages the launch manifest that declares which strategies to run.
 * Provides explicit, reproducible deployment configuration.
 *
 * Public interface:
 * - init(config) - Initialize the module
 * - getState() - Get current module state
 * - shutdown() - Gracefully shutdown
 * - loadManifest() - Read and validate launch.json
 * - updateManifest(updates) - Validate and write changes
 * - listAvailableStrategies() - Get registry of available strategies
 *
 * Requirements Addressed:
 * - AC1: Orchestrator reads config/launch.json and loads ONLY listed strategies
 * - AC2: Claude Code can update launch.json
 * - AC3: Strategy registry exports available strategy names
 *
 * @module modules/launch-config
 */

import { child } from '../logger/index.js';
import {
  LaunchConfigError,
  LaunchConfigErrorCodes,
  KNOWN_STRATEGIES,
  getKnownStrategyNames,
} from './types.js';
import {
  loadAndValidateManifest,
  writeManifest,
  validateManifestSchema,
  validateStrategyNames,
  mergeManifestUpdates,
  getDefaultManifest,
} from './logic.js';

// Module state
let log = null;
let initialized = false;
let currentManifest = null;
let manifestPath = './config/launch.json';

/**
 * Initialize the launch-config module
 *
 * @param {Object} [config={}] - Configuration options
 * @param {string} [config.manifestPath] - Custom path to launch.json
 * @returns {Promise<void>}
 * @throws {LaunchConfigError} If already initialized
 */
export async function init(config = {}) {
  if (initialized) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.ALREADY_INITIALIZED,
      'Launch-config module already initialized',
      {}
    );
  }

  log = child({ module: 'launch-config' });
  log.info('module_init_start');

  if (config.manifestPath) {
    manifestPath = config.manifestPath;
  }

  // Load manifest on init
  try {
    currentManifest = loadAndValidateManifest(manifestPath);
    log.info('manifest_loaded', {
      strategies: currentManifest.strategies,
      position_size_dollars: currentManifest.position_size_dollars,
      max_exposure_dollars: currentManifest.max_exposure_dollars,
      symbols: currentManifest.symbols,
      kill_switch_enabled: currentManifest.kill_switch_enabled,
    });
  } catch (err) {
    // Log but don't fail init - manifest may be created later
    log.warn('manifest_load_failed', {
      error: err.message,
      code: err.code,
    });
    currentManifest = null;
  }

  initialized = true;
  log.info('module_initialized');
}

/**
 * Get current module state
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return {
    initialized,
    manifestPath,
    manifest: currentManifest,
    knownStrategies: getKnownStrategyNames(),
    activeStrategies: currentManifest?.strategies ?? [],
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

  currentManifest = null;
  initialized = false;
  manifestPath = './config/launch.json';

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Ensure module is initialized
 *
 * @throws {LaunchConfigError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.NOT_INITIALIZED,
      'Launch-config module not initialized. Call init() first.',
      {}
    );
  }
}

/**
 * Deep clone a manifest to prevent external mutation of internal state
 *
 * @param {Object} manifest - Manifest to clone
 * @returns {Object} Deep cloned manifest
 */
function deepCloneManifest(manifest) {
  return {
    ...manifest,
    strategies: [...manifest.strategies],
    symbols: [...manifest.symbols],
  };
}

/**
 * Load and validate the launch manifest
 *
 * Reads config/launch.json, validates schema and strategy names,
 * and returns the manifest object.
 *
 * @param {boolean} [reload=false] - Force reload from disk
 * @returns {Object} Validated manifest object
 * @throws {LaunchConfigError} If manifest invalid or not found
 */
export function loadManifest(reload = false) {
  ensureInitialized();

  if (reload || !currentManifest) {
    currentManifest = loadAndValidateManifest(manifestPath);
    if (log) {
      log.info('manifest_reloaded', {
        strategies: currentManifest.strategies,
      });
    }
  }

  return deepCloneManifest(currentManifest);
}

/**
 * Update the launch manifest
 *
 * Validates updates, merges with current manifest, validates the result,
 * and writes to disk.
 *
 * @param {Object} updates - Fields to update
 * @param {string[]} [updates.strategies] - New strategy list
 * @param {number} [updates.position_size_dollars] - New position size
 * @param {number} [updates.max_exposure_dollars] - New max exposure
 * @param {string[]} [updates.symbols] - New symbol list
 * @param {boolean} [updates.kill_switch_enabled] - Kill switch setting
 * @returns {Object} Updated manifest
 * @throws {LaunchConfigError} If validation fails
 */
export function updateManifest(updates) {
  ensureInitialized();

  // Load current manifest
  const current = loadManifest();

  // Merge updates
  const merged = mergeManifestUpdates(current, updates);

  // Validate merged result
  const schemaResult = validateManifestSchema(merged);
  if (!schemaResult.valid) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.VALIDATION_FAILED,
      `Invalid update: ${schemaResult.errors.join(', ')}`,
      { errors: schemaResult.errors }
    );
  }

  // Validate strategy names
  const strategyResult = validateStrategyNames(merged.strategies);
  if (!strategyResult.valid) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.UNKNOWN_STRATEGY,
      `Unknown strategies: ${strategyResult.unknownStrategies.join(', ')}`,
      { unknownStrategies: strategyResult.unknownStrategies }
    );
  }

  // Write to disk
  writeManifest(merged, manifestPath);

  // Update cached manifest
  currentManifest = merged;

  if (log) {
    log.info('manifest_updated', {
      updates: Object.keys(updates),
      strategies: merged.strategies,
    });
  }

  return deepCloneManifest(merged);
}

/**
 * List all available strategies
 *
 * Returns the strategy registry with names, descriptions, and dependencies.
 * Note: This does NOT require init() - strategies are static.
 *
 * @returns {Object[]} Array of strategy definitions (deep cloned)
 */
export function listAvailableStrategies() {
  return KNOWN_STRATEGIES.map((s) => ({
    ...s,
    dependencies: [...s.dependencies],
  }));
}

/**
 * Check if a strategy name is known
 *
 * Note: This does NOT require init() - strategies are static.
 *
 * @param {string} name - Strategy name to check
 * @returns {boolean} True if strategy is known
 */
export function isKnownStrategy(name) {
  if (typeof name !== 'string') {
    return false;
  }
  return getKnownStrategyNames().includes(name);
}

/**
 * Get default manifest values
 *
 * @returns {Object} Default manifest object
 */
export { getDefaultManifest };

// Re-export types
export {
  LaunchConfigError,
  LaunchConfigErrorCodes,
  KNOWN_STRATEGIES,
} from './types.js';
