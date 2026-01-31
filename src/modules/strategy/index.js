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
  // Story 6.4: Component Update functions
  getStrategiesUsingComponent as getStrategiesUsingComponentLogic,
  getComponentVersionHistory as getComponentVersionHistoryLogic,
  // Story 6.5: Strategy Configuration functions
  getStrategyConfig as getStrategyConfigLogic,
  validateStrategyConfig as validateStrategyConfigLogic,
  previewConfigUpdate as previewConfigUpdateLogic,
  updateStrategyConfig as updateStrategyConfigLogic,
} from './logic.js';
import {
  createStrategy as createStrategyLogic,
  executeStrategy as executeStrategyLogic,
  validateStrategy as validateStrategyLogic,
  forkStrategy as forkStrategyLogic,
  diffStrategies as diffStrategiesLogic,
  diffFromParent as diffFromParentLogic,
  // Story 6.4: Component Upgrade functions
  upgradeStrategyComponent as upgradeStrategyComponentLogic,
  batchUpgradeComponent as batchUpgradeComponentLogic,
  previewComponentUpgrade as previewComponentUpgradeLogic,
} from './composer.js';
import { createComponentVersion as createComponentVersionLogic } from './registry.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT UPDATE FUNCTIONS (Story 6.4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new component version and add to catalog
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @param {number} version - Version number
 * @param {string} modulePath - Path to component module file
 * @returns {Promise<string>} New version ID
 * @throws {StrategyError} If type invalid, version exists, or interface invalid
 */
export async function createComponentVersion(type, name, version, modulePath) {
  ensureInitialized();

  const versionId = await createComponentVersionLogic(type, name, version, modulePath);

  log.info('component_version_created', {
    version_id: versionId,
    type,
    name,
    version,
    module_path: modulePath,
  });

  return versionId;
}

/**
 * Find all strategies using a specific component version
 *
 * @param {string} versionId - Component version ID
 * @param {Object} [options] - Query options
 * @param {boolean} [options.activeOnly=false] - Only return active strategies
 * @returns {Object[]} Array of strategy summaries with componentSlot
 */
export function getStrategiesUsingComponent(versionId, options = {}) {
  ensureInitialized();

  const strategies = getStrategiesUsingComponentLogic(versionId, options);

  log.info('strategies_using_component_retrieved', {
    version_id: versionId,
    count: strategies.length,
    active_only: options.activeOnly || false,
  });

  return strategies;
}

/**
 * Get version history for a component by type and name
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @returns {Object[]} Array of version entries sorted by version descending
 */
export function getComponentVersionHistory(type, name) {
  ensureInitialized();

  const history = getComponentVersionHistoryLogic(type, name);

  log.info('component_version_history_retrieved', {
    type,
    name,
    version_count: history.length,
  });

  return history;
}

/**
 * Upgrade a strategy to use a new component version
 *
 * @param {string} strategyId - Strategy ID to upgrade
 * @param {string} componentType - Component slot to upgrade (probability, entry, exit, sizing)
 * @param {string} newVersionId - New component version ID
 * @returns {Object} Upgraded strategy details
 * @throws {StrategyError} If strategy not found, component invalid, or config fails validation
 */
export function upgradeStrategyComponent(strategyId, componentType, newVersionId) {
  ensureInitialized();

  const result = upgradeStrategyComponentLogic(strategyId, componentType, newVersionId);

  log.info('strategy_component_upgraded', {
    strategy_id: strategyId,
    component_type: componentType,
    previous_version: result.previousVersion,
    new_version: newVersionId,
  });

  return result;
}

/**
 * Batch upgrade all strategies from old component to new
 *
 * @param {string} oldVersionId - Current component version to replace
 * @param {string} newVersionId - New component version
 * @param {Object} [options={}] - Batch options
 * @param {boolean} [options.activeOnly=true] - Only upgrade active strategies
 * @param {string[]} [options.strategyIds] - Specific strategies to upgrade (if omitted, all matching)
 * @returns {Object} Batch result { upgraded, failed, total, successCount, failCount }
 */
export function batchUpgradeComponent(oldVersionId, newVersionId, options = {}) {
  ensureInitialized();

  const result = batchUpgradeComponentLogic(oldVersionId, newVersionId, options);

  log.info('batch_component_upgrade_completed', {
    old_version: oldVersionId,
    new_version: newVersionId,
    total: result.total,
    success_count: result.successCount,
    fail_count: result.failCount,
    active_only: options.activeOnly !== false,
  });

  return result;
}

/**
 * Preview a component upgrade without making changes
 *
 * @param {string} strategyId - Strategy ID
 * @param {string} componentType - Component slot (probability, entry, exit, sizing)
 * @param {string} newVersionId - New component version ID
 * @returns {Object} Preview result { canUpgrade, currentVersion, newVersion, validationResult, componentDiff }
 */
export function previewComponentUpgrade(strategyId, componentType, newVersionId) {
  ensureInitialized();

  const preview = previewComponentUpgradeLogic(strategyId, componentType, newVersionId);

  log.info('component_upgrade_preview', {
    strategy_id: strategyId,
    component_type: componentType,
    current_version: preview.currentVersion,
    new_version: newVersionId,
    can_upgrade: preview.canUpgrade,
  });

  return preview;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION FUNCTIONS (Story 6.5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a strategy's configuration JSON
 *
 * @param {string} strategyId - Strategy ID
 * @returns {Object|null} Strategy config or null if not found
 */
export function getStrategyConfig(strategyId) {
  ensureInitialized();

  const config = getStrategyConfigLogic(strategyId);

  log.info('strategy_config_retrieved', {
    strategy_id: strategyId,
    has_config: config !== null,
    config_keys: config ? Object.keys(config) : [],
  });

  return config;
}

/**
 * Validate a strategy's current configuration against its components
 *
 * @param {string} strategyId - Strategy ID to validate
 * @returns {Object} Validation result { valid, errors, componentResults }
 */
export function validateStrategyConfig(strategyId) {
  ensureInitialized();

  const result = validateStrategyConfigLogic(strategyId);

  log.info('strategy_config_validated', {
    strategy_id: strategyId,
    valid: result.valid,
    error_count: result.errors?.length ?? 0,
  });

  return result;
}

/**
 * Preview a config update without making changes
 *
 * @param {string} strategyId - Strategy ID
 * @param {Object} newConfig - Proposed new configuration
 * @param {Object} [options={}] - Preview options
 * @param {boolean} [options.merge=true] - Deep merge with existing (true) or replace (false)
 * @returns {Object} Preview result { canUpdate, currentConfig, proposedConfig, diff, validationResult }
 */
export function previewConfigUpdate(strategyId, newConfig, options = {}) {
  ensureInitialized();

  const preview = previewConfigUpdateLogic(strategyId, newConfig, options);

  log.info('strategy_config_preview', {
    strategy_id: strategyId,
    can_update: preview.canUpdate,
    merge_mode: options.merge !== false,
    changed_keys: Object.keys(preview.diff.changed),
    added_keys: Object.keys(preview.diff.added),
    removed_keys: Object.keys(preview.diff.removed),
  });

  return preview;
}

/**
 * Update a strategy's configuration
 *
 * @param {string} strategyId - Strategy ID to update
 * @param {Object} newConfig - New configuration values
 * @param {Object} [options={}] - Update options
 * @param {boolean} [options.merge=true] - Deep merge with existing (true) or replace (false)
 * @returns {Object} Updated strategy with new config
 * @throws {StrategyError} If strategy not found or config validation fails
 */
export function updateStrategyConfig(strategyId, newConfig, options = {}) {
  ensureInitialized();

  // Get current config for logging
  const currentConfig = getStrategyConfigLogic(strategyId);

  const updatedStrategy = updateStrategyConfigLogic(strategyId, newConfig, options);

  log.info('strategy_config_updated', {
    strategy_id: strategyId,
    merge_mode: options.merge !== false,
    old_config_keys: currentConfig ? Object.keys(currentConfig) : [],
    new_config_keys: Object.keys(updatedStrategy.config),
  });

  return updatedStrategy;
}

// Re-export types and constants
export { StrategyError, StrategyErrorCodes, ComponentType, TypePrefix } from './types.js';
