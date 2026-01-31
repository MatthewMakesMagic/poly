/**
 * Strategy Module
 *
 * Public interface for strategy component registry and composition.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Discover and catalog strategy components from filesystem
 * - Generate immutable version IDs for components
 * - Register strategies with component version references
 * - Query strategies and their component composition
 *
 * Requirements Addressed:
 * - FR31: Components can be versioned independently
 * - FR32: System can track which component versions a strategy uses
 *
 * @module modules/strategy
 */

import { child } from '../logger/index.js';
import { StrategyError, StrategyErrorCodes, ComponentType, TypePrefix } from './types.js';
import {
  isInitialized,
  setInitialized,
  setConfig,
  resetState,
  getStateSnapshot,
  setCatalog,
} from './state.js';
import {
  generateVersionId,
  parseVersionId,
  validateComponentInterface,
  discoverComponents,
  registerStrategy,
  getStrategy,
  getComponent,
  listComponents,
  getStrategyComponents,
  listStrategies,
  deactivateStrategy,
} from './logic.js';

// Module state
let log = null;

/**
 * Initialize the strategy module
 *
 * @param {Object} config - Configuration object
 * @param {string} [config.componentsPath] - Custom path to components directory
 * @param {boolean} [config.discoverOnInit=true] - Whether to discover components on init
 * @returns {Promise<void>}
 */
export async function init(config = {}) {
  if (isInitialized()) {
    throw new StrategyError(
      StrategyErrorCodes.ALREADY_INITIALIZED,
      'Strategy module already initialized',
      {}
    );
  }

  // Create child logger for this module
  log = child({ module: 'strategy' });
  log.info('module_init_start');

  // Store configuration
  setConfig(config);

  // Discover components if enabled (default: true)
  if (config.discoverOnInit !== false) {
    try {
      const catalog = await discoverComponents(config.componentsPath);
      setCatalog(catalog);

      const totalComponents = Object.values(catalog).reduce(
        (sum, type) => sum + Object.keys(type).length,
        0
      );

      log.info('components_discovered', {
        total: totalComponents,
        probability: Object.keys(catalog.probability).length,
        entry: Object.keys(catalog.entry).length,
        exit: Object.keys(catalog.exit).length,
        sizing: Object.keys(catalog.sizing).length,
      });
    } catch (err) {
      log.warn('component_discovery_failed', { error: err.message });
      // Continue initialization even if discovery fails
    }
  }

  setInitialized(true);
  log.info('module_initialized');
}

/**
 * Get current module state
 *
 * Returns initialization status, stats, and catalog summary.
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return getStateSnapshot();
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

  resetState();

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {StrategyError} If not initialized
 */
function ensureInitialized() {
  if (!isInitialized()) {
    throw new StrategyError(
      StrategyErrorCodes.NOT_INITIALIZED,
      'Strategy module not initialized. Call init() first.',
      {}
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRY FUNCTIONS (AC5, AC7)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register a new strategy with specified components
 *
 * @param {Object} params - Strategy parameters
 * @param {string} params.name - Human-readable strategy name
 * @param {Object} params.components - Component version IDs
 * @param {string} params.components.probability - Probability component version ID
 * @param {string} params.components.entry - Entry component version ID
 * @param {string} params.components.exit - Exit component version ID
 * @param {string} params.components.sizing - Sizing component version ID
 * @param {Object} [params.config={}] - Strategy configuration JSON
 * @param {string} [params.baseStrategyId=null] - For forks: parent strategy ID
 * @returns {string} New strategy ID
 */
export function registerStrategyWithComponents(params) {
  ensureInitialized();

  const strategyId = registerStrategy(params);

  log.info('strategy_registered', {
    strategy_id: strategyId,
    name: params.name,
    base_strategy_id: params.baseStrategyId,
    components: params.components,
  });

  return strategyId;
}

/**
 * Get strategy by ID with full component details
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object|null} Strategy instance or null if not found
 */
export function getStrategyById(strategyId) {
  ensureInitialized();
  return getStrategy(strategyId);
}

/**
 * Get component by version ID
 *
 * @param {string} versionId - Component version ID (e.g., "prob-spot-lag-v1")
 * @returns {Object|null} Component metadata and module reference
 */
export function getComponentByVersionId(versionId) {
  ensureInitialized();
  return getComponent(versionId);
}

/**
 * List all available components, optionally filtered by type
 *
 * @param {string} [type] - Filter by component type
 * @returns {Object[]} Array of component metadata
 */
export function listAvailableComponents(type) {
  ensureInitialized();
  return listComponents(type);
}

/**
 * Get all components used by a strategy
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object|null} Component details for each type
 */
export function getComponentsForStrategy(strategyId) {
  ensureInitialized();
  return getStrategyComponents(strategyId);
}

/**
 * List all registered strategies
 *
 * @param {Object} [options] - Query options
 * @param {boolean} [options.activeOnly=true] - Only return active strategies
 * @param {number} [options.limit=100] - Maximum number of results
 * @returns {Object[]} Array of strategy summaries
 */
export function listRegisteredStrategies(options) {
  ensureInitialized();
  return listStrategies(options);
}

/**
 * Deactivate a strategy (soft delete)
 *
 * @param {string} strategyId - Strategy ID to deactivate
 * @returns {boolean} True if strategy was deactivated
 */
export function deactivateStrategyById(strategyId) {
  ensureInitialized();

  const result = deactivateStrategy(strategyId);

  if (result) {
    log.info('strategy_deactivated', { strategy_id: strategyId });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS (AC2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a version ID for a component
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @param {number} version - Version number
 * @returns {string} Version ID
 */
export { generateVersionId };

/**
 * Parse a version ID into its components
 *
 * @param {string} versionId - Version ID to parse
 * @returns {Object|null} Parsed components { type, name, version, prefix }
 */
export { parseVersionId };

/**
 * Validate a component exports the required interface
 *
 * @param {Object} component - Component module to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export { validateComponentInterface };

/**
 * Rediscover components from filesystem
 *
 * @param {string} [componentsPath] - Custom path to components directory
 * @returns {Promise<Object>} Component catalog by type
 */
export async function rediscoverComponents(componentsPath) {
  ensureInitialized();

  const catalog = await discoverComponents(componentsPath);
  setCatalog(catalog);

  const totalComponents = Object.values(catalog).reduce(
    (sum, type) => sum + Object.keys(type).length,
    0
  );

  log.info('components_rediscovered', {
    total: totalComponents,
    probability: Object.keys(catalog.probability).length,
    entry: Object.keys(catalog.entry).length,
    exit: Object.keys(catalog.exit).length,
    sizing: Object.keys(catalog.sizing).length,
  });

  return catalog;
}

// Re-export types and constants
export { StrategyError, StrategyErrorCodes, ComponentType, TypePrefix } from './types.js';
