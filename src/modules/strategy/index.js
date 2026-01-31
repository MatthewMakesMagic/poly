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
  getStrategyLineage as getStrategyLineageLogic,
  getStrategyForks as getStrategyForksLogic,
} from './logic.js';
import {
  createStrategy as createStrategyLogic,
  executeStrategy as executeStrategyLogic,
  validateStrategy as validateStrategyLogic,
  forkStrategy as forkStrategyLogic,
  diffStrategies as diffStrategiesLogic,
  diffFromParent as diffFromParentLogic,
} from './composer.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSER FUNCTIONS (Story 6.2)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new strategy from component version IDs
 *
 * Validates all components exist, validates config against each component,
 * then persists the strategy.
 *
 * @param {string} name - Human-readable strategy name
 * @param {Object} components - Component version IDs
 * @param {string} components.probability - Probability component version ID
 * @param {string} components.entry - Entry component version ID
 * @param {string} components.exit - Exit component version ID
 * @param {string} components.sizing - Sizing component version ID
 * @param {Object} [config={}] - Strategy configuration JSON
 * @returns {string} New strategy ID
 */
export function createStrategy(name, components, config = {}) {
  ensureInitialized();

  const strategyId = createStrategyLogic(name, components, config);

  log.info('strategy_created', {
    strategy_id: strategyId,
    name,
    components,
    config_keys: Object.keys(config),
  });

  return strategyId;
}

/**
 * Execute a strategy by running all components in pipeline order
 *
 * Pipeline order: probability -> entry -> sizing -> exit
 * Each component receives context, config, and results from previous components.
 *
 * @param {string} strategyId - Strategy instance ID
 * @param {Object} context - Execution context (market data, position state)
 * @returns {Object} Aggregated execution result with decision and component outputs
 */
export function executeStrategy(strategyId, context) {
  ensureInitialized();

  const startTime = Date.now();

  try {
    const result = executeStrategyLogic(strategyId, context);

    log.info('strategy_executed', {
      strategy_id: strategyId,
      action: result.decision.action,
      direction: result.decision.direction,
      size: result.decision.size,
      probability: result.decision.probability,
      duration_ms: Date.now() - startTime,
    });

    return result;
  } catch (err) {
    log.error('strategy_execution_failed', {
      strategy_id: strategyId,
      error: err.message,
      code: err.code,
      duration_ms: Date.now() - startTime,
    });
    throw err;
  }
}

/**
 * Validate a strategy's components and configuration
 *
 * Checks strategy exists, is active, all components are in catalog,
 * and config passes each component's validation.
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object} Validation result { valid, errors?, details }
 */
export function validateStrategy(strategyId) {
  ensureInitialized();

  const result = validateStrategyLogic(strategyId);

  log.info('strategy_validated', {
    strategy_id: strategyId,
    valid: result.valid,
    error_count: result.errors?.length ?? 0,
  });

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// FORKING FUNCTIONS (Story 6.3)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fork an existing strategy with modifications
 *
 * Creates a new strategy based on an existing one, inheriting
 * components and config unless overridden.
 *
 * @param {string} parentId - Strategy ID to fork from
 * @param {string} name - Name for the new fork
 * @param {Object} [modifications={}] - Optional modifications
 * @param {Object} [modifications.components] - Component overrides
 * @param {Object} [modifications.config] - Config overrides (deep merged)
 * @returns {string} New strategy ID
 */
export function forkStrategy(parentId, name, modifications = {}) {
  ensureInitialized();

  const forkId = forkStrategyLogic(parentId, name, modifications);

  log.info('strategy_forked', {
    fork_id: forkId,
    parent_id: parentId,
    name,
    has_component_overrides: !!(modifications.components && Object.keys(modifications.components).length > 0),
    has_config_overrides: !!(modifications.config && Object.keys(modifications.config).length > 0),
  });

  return forkId;
}

/**
 * Get the lineage (ancestry chain) of a strategy
 *
 * Returns an array starting from the given strategy and going up
 * to the root ancestor.
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object[]} Ancestry array [{ id, name, createdAt, depth }]
 */
export function getStrategyLineage(strategyId) {
  ensureInitialized();

  const lineage = getStrategyLineageLogic(strategyId);

  log.info('strategy_lineage_retrieved', {
    strategy_id: strategyId,
    depth: lineage.length,
    root_id: lineage.length > 0 ? lineage[lineage.length - 1].id : null,
  });

  return lineage;
}

/**
 * Get all strategies that are forks of a given parent strategy
 *
 * @param {string} strategyId - Parent strategy ID
 * @param {Object} [options] - Query options
 * @param {boolean} [options.activeOnly=false] - Only return active forks
 * @returns {Object[]} Array of fork summaries
 */
export function getStrategyForks(strategyId, options) {
  ensureInitialized();

  const forks = getStrategyForksLogic(strategyId, options);

  log.info('strategy_forks_retrieved', {
    strategy_id: strategyId,
    fork_count: forks.length,
  });

  return forks;
}

/**
 * Compare two strategies and return differences
 *
 * @param {string} strategyIdA - First strategy ID
 * @param {string} strategyIdB - Second strategy ID
 * @returns {Object} Structured diff { sameBase, components, config }
 */
export function diffStrategies(strategyIdA, strategyIdB) {
  ensureInitialized();

  const diff = diffStrategiesLogic(strategyIdA, strategyIdB);

  log.info('strategies_diffed', {
    strategy_a: strategyIdA,
    strategy_b: strategyIdB,
    same_base: diff.sameBase,
    component_differences: Object.values(diff.components).filter(c => !c.match).length,
  });

  return diff;
}

/**
 * Compare a forked strategy with its parent
 *
 * Convenience wrapper around diffStrategies.
 *
 * @param {string} forkId - Fork strategy ID
 * @returns {Object} Structured diff between fork and parent
 */
export function diffFromParent(forkId) {
  ensureInitialized();

  const diff = diffFromParentLogic(forkId);

  log.info('strategy_diffed_from_parent', {
    fork_id: forkId,
    component_differences: Object.values(diff.components).filter(c => !c.match).length,
  });

  return diff;
}

// Re-export types and constants
export { StrategyError, StrategyErrorCodes, ComponentType, TypePrefix } from './types.js';
