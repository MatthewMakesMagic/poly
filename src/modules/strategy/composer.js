/**
 * Strategy Composer
 *
 * Core composition and execution logic for strategies built from reusable components.
 * This module provides functions to create, execute, and validate strategies.
 *
 * Capabilities:
 * - Create strategies from component version IDs (with validation)
 * - Execute strategies by running components in pipeline order
 * - Validate strategy configuration and component references
 *
 * Requirements Addressed:
 * - FR30: Strategies can be composed from reusable components
 * - FR35: Strategy parameters configurable via config JSON
 *
 * @module modules/strategy/composer
 */

import { StrategyError, StrategyErrorCodes } from './types.js';
import { getComponent, registerStrategy, getStrategy } from './logic.js';

/**
 * Component execution order for strategy pipeline
 * @type {string[]}
 */
const COMPONENT_ORDER = ['probability', 'entry', 'sizing', 'exit'];

/**
 * Create a new strategy from component version IDs
 *
 * Validates all component version IDs exist in catalog,
 * validates component types match expected slots,
 * validates strategy config against each component's validateConfig(),
 * and persists via registerStrategy().
 *
 * @param {string} name - Human-readable strategy name
 * @param {Object} components - Component version IDs
 * @param {string} components.probability - Probability component version ID
 * @param {string} components.entry - Entry component version ID
 * @param {string} components.exit - Exit component version ID
 * @param {string} components.sizing - Sizing component version ID
 * @param {Object} [config={}] - Strategy configuration JSON
 * @returns {string} New strategy ID
 * @throws {StrategyError} If components not found or config validation fails
 */
export function createStrategy(name, components, config = {}) {
  // Validate all component version IDs exist in catalog
  const loadedComponents = {};
  for (const type of COMPONENT_ORDER) {
    const versionId = components[type];
    if (!versionId) {
      throw new StrategyError(
        StrategyErrorCodes.MISSING_REQUIRED_FIELD,
        `Component ${type} is required`,
        { field: `components.${type}` }
      );
    }

    const component = getComponent(versionId);
    if (!component) {
      throw new StrategyError(
        StrategyErrorCodes.COMPONENT_NOT_FOUND,
        `Component ${versionId} not found in catalog`,
        { versionId, type }
      );
    }

    // Validate component type matches expected slot
    if (component.type !== type) {
      throw new StrategyError(
        StrategyErrorCodes.INVALID_COMPONENT_TYPE,
        `Component ${versionId} is type '${component.type}', expected '${type}'`,
        { versionId, actualType: component.type, expectedType: type }
      );
    }

    loadedComponents[type] = component;
  }

  // Validate strategy config against each component's validateConfig()
  for (const type of COMPONENT_ORDER) {
    const component = loadedComponents[type];
    if (component.module && typeof component.module.validateConfig === 'function') {
      const validation = component.module.validateConfig(config);
      if (!validation.valid) {
        throw new StrategyError(
          StrategyErrorCodes.CONFIG_VALIDATION_FAILED,
          `Config validation failed for ${type} component: ${(validation.errors || []).join(', ')}`,
          { type, versionId: components[type], errors: validation.errors }
        );
      }
    }
  }

  // Delegate to registry.registerStrategy() for persistence
  const strategyId = registerStrategy({
    name,
    components,
    config,
  });

  return strategyId;
}

/**
 * Execute a single component with context, config, and previous results
 *
 * @param {Object} component - Component from catalog
 * @param {Object} context - Market and strategy context
 * @param {Object} config - Strategy configuration
 * @param {Object} prevResults - Results from previous components
 * @returns {Object} Component execution result
 * @throws {StrategyError} If component execution fails
 */
function executeComponent(component, context, config, prevResults) {
  if (!component.module || typeof component.module.evaluate !== 'function') {
    throw new StrategyError(
      StrategyErrorCodes.INVALID_COMPONENT_INTERFACE,
      `Component ${component.versionId} does not have an evaluate function`,
      { versionId: component.versionId }
    );
  }

  try {
    // Build enriched context with previous results
    const enrichedContext = {
      ...context,
      prevResults,
    };

    // Execute component's evaluate function
    const result = component.module.evaluate(enrichedContext, config);

    // Validate result is an object
    if (!result || typeof result !== 'object') {
      throw new StrategyError(
        StrategyErrorCodes.INVALID_COMPONENT_OUTPUT,
        `Component ${component.versionId} returned invalid output`,
        { versionId: component.versionId, output: result }
      );
    }

    return result;
  } catch (err) {
    // Re-throw StrategyErrors
    if (err instanceof StrategyError) {
      throw err;
    }

    // Wrap other errors
    throw new StrategyError(
      StrategyErrorCodes.COMPONENT_EXECUTION_FAILED,
      `Component ${component.versionId} execution failed: ${err.message}`,
      { versionId: component.versionId, error: err.message, stack: err.stack }
    );
  }
}

/**
 * Execute a strategy by running all components in pipeline order
 *
 * Pipeline order: probability -> entry -> sizing -> exit
 * Each component receives:
 * - context: Market data and strategy state
 * - config: Full strategy configuration
 * - prevResults: Outputs from previous components
 *
 * @param {string} strategyId - Strategy instance ID
 * @param {Object} context - Execution context
 * @param {number} [context.spotPrice] - Current spot price
 * @param {number} [context.targetPrice] - Target price for window
 * @param {number} [context.timeToExpiry] - Time to window expiry (ms)
 * @param {Object} [context.marketData] - Additional market data
 * @param {Object} [context.position] - Current position data if any
 * @returns {Object} Aggregated execution result
 * @throws {StrategyError} If strategy not found or component execution fails
 */
export function executeStrategy(strategyId, context) {
  // Load strategy by ID
  const strategy = getStrategy(strategyId);
  if (!strategy) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_NOT_FOUND,
      `Strategy ${strategyId} not found`,
      { strategyId }
    );
  }

  // Check strategy is active
  if (!strategy.active) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_VALIDATION_FAILED,
      `Strategy ${strategyId} is not active`,
      { strategyId, active: strategy.active }
    );
  }

  // Load all component modules from catalog
  const loadedComponents = {};
  for (const type of COMPONENT_ORDER) {
    const versionId = strategy.components[type];
    const component = getComponent(versionId);

    if (!component) {
      throw new StrategyError(
        StrategyErrorCodes.COMPONENT_NOT_FOUND,
        `Component ${versionId} not found in catalog`,
        { versionId, type, strategyId }
      );
    }

    loadedComponents[type] = component;
  }

  // Execute components in order, passing results from previous to next
  const componentResults = {};
  let prevResults = {};
  const partialResults = {};

  try {
    for (const type of COMPONENT_ORDER) {
      const component = loadedComponents[type];
      const result = executeComponent(component, context, strategy.config, prevResults);

      componentResults[type] = result;
      partialResults[type] = result;

      // Pass current component's result to next component
      prevResults = {
        ...prevResults,
        [type]: result,
      };
    }
  } catch (err) {
    // Re-throw with partial results context
    if (err instanceof StrategyError) {
      err.context = {
        ...err.context,
        partialResults,
        strategyId,
      };
      throw err;
    }

    throw new StrategyError(
      StrategyErrorCodes.COMPONENT_EXECUTION_FAILED,
      `Strategy execution failed: ${err.message}`,
      { strategyId, partialResults, error: err.message }
    );
  }

  // Aggregate results into final trade decision
  const decision = aggregateDecision(componentResults);

  return {
    strategyId,
    executedAt: new Date().toISOString(),
    decision,
    components: componentResults,
    context: {
      windowId: context.windowId,
      spotPrice: context.spotPrice,
      marketPrice: context.marketPrice,
    },
  };
}

/**
 * Aggregate component results into final trade decision
 *
 * @param {Object} componentResults - Results from all components
 * @returns {Object} Aggregated trade decision
 */
function aggregateDecision(componentResults) {
  const { probability, entry, sizing, exit } = componentResults;

  // Determine action based on entry component
  let action = 'no_action';
  if (entry.shouldEnter) {
    action = 'enter';
  } else if (exit.shouldExit) {
    action = 'exit';
  } else {
    action = 'hold';
  }

  return {
    action,
    direction: entry.direction || entry.side || null,
    size: sizing.adjustedSize ?? sizing.size ?? 0,
    stopLoss: exit.stopLoss?.price ?? null,
    takeProfit: exit.takeProfit?.price ?? null,
    probability: probability.probability,
    confidence: probability.confidence,
  };
}

/**
 * Validate a strategy's components and configuration
 *
 * Checks:
 * - Strategy exists and is active
 * - All component version IDs exist in catalog
 * - Component interfaces are correct
 * - Strategy config passes each component's validateConfig()
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object} Validation result
 * @returns {boolean} result.valid - Whether strategy is valid
 * @returns {string[]} [result.errors] - Validation error messages
 * @returns {Object} [result.details] - Detailed validation info per component
 */
export function validateStrategy(strategyId) {
  const errors = [];
  const details = {};

  // Check strategy exists
  const strategy = getStrategy(strategyId);
  if (!strategy) {
    return {
      valid: false,
      errors: [`Strategy ${strategyId} not found`],
      details: {},
    };
  }

  // Check strategy is active
  if (!strategy.active) {
    errors.push(`Strategy ${strategyId} is not active`);
  }

  // Validate all component version IDs exist in catalog
  for (const type of COMPONENT_ORDER) {
    const versionId = strategy.components[type];
    const component = getComponent(versionId);

    details[type] = {
      versionId,
      inCatalog: !!component,
      interfaceValid: false,
      configValid: false,
      errors: [],
    };

    if (!component) {
      errors.push(`Component ${versionId} (${type}) not found in catalog`);
      details[type].errors.push('Component not found in catalog');
      continue;
    }

    // Validate component interface
    if (!component.module || typeof component.module.evaluate !== 'function') {
      errors.push(`Component ${versionId} (${type}) missing evaluate function`);
      details[type].errors.push('Missing evaluate function');
    } else if (typeof component.module.validateConfig !== 'function') {
      errors.push(`Component ${versionId} (${type}) missing validateConfig function`);
      details[type].errors.push('Missing validateConfig function');
    } else {
      details[type].interfaceValid = true;

      // Validate config
      const validation = component.module.validateConfig(strategy.config);
      if (validation.valid) {
        details[type].configValid = true;
      } else {
        errors.push(`Config validation failed for ${type}: ${(validation.errors || []).join(', ')}`);
        details[type].errors.push(...(validation.errors || ['Config validation failed']));
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    details,
    strategy: {
      id: strategy.id,
      name: strategy.name,
      active: strategy.active,
    },
  };
}

/**
 * Deep merge two config objects
 * Second object values override first
 *
 * @param {Object} base - Base configuration
 * @param {Object} override - Override configuration
 * @returns {Object} Merged configuration
 */
export function deepMerge(base, override) {
  if (!override || typeof override !== 'object') {
    return { ...base };
  }

  if (!base || typeof base !== 'object') {
    return { ...override };
  }

  const result = { ...base };

  for (const key of Object.keys(override)) {
    if (
      typeof override[key] === 'object' &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }

  return result;
}

/**
 * Fork an existing strategy with modifications
 *
 * Creates a new strategy instance based on an existing one,
 * inheriting components and config unless overridden.
 *
 * @param {string} parentId - Strategy ID to fork from
 * @param {string} name - Name for the new fork
 * @param {Object} [modifications={}] - Optional modifications
 * @param {Object} [modifications.components] - Component overrides
 * @param {string} [modifications.components.probability] - Override probability component
 * @param {string} [modifications.components.entry] - Override entry component
 * @param {string} [modifications.components.exit] - Override exit component
 * @param {string} [modifications.components.sizing] - Override sizing component
 * @param {Object} [modifications.config] - Config overrides (deep merged)
 * @returns {string} New strategy ID
 * @throws {StrategyError} If parent not found, inactive, or modifications invalid
 */
export function forkStrategy(parentId, name, modifications = {}) {
  // 1. Load parent strategy
  const parent = getStrategy(parentId);
  if (!parent) {
    throw new StrategyError(
      StrategyErrorCodes.FORK_PARENT_NOT_FOUND,
      `Parent strategy ${parentId} not found`,
      { parentId }
    );
  }

  // 2. Validate parent is active
  if (!parent.active) {
    throw new StrategyError(
      StrategyErrorCodes.FORK_PARENT_INACTIVE,
      `Cannot fork inactive strategy ${parentId}`,
      { parentId, active: parent.active }
    );
  }

  // 3. Build component set: parent + modifications
  const componentOverrides = modifications.components || {};
  const newComponents = {
    probability: componentOverrides.probability || parent.components.probability,
    entry: componentOverrides.entry || parent.components.entry,
    exit: componentOverrides.exit || parent.components.exit,
    sizing: componentOverrides.sizing || parent.components.sizing,
  };

  // 4. Validate all modified component version IDs exist in catalog
  const loadedComponents = {};
  for (const type of COMPONENT_ORDER) {
    const versionId = newComponents[type];
    const component = getComponent(versionId);

    if (!component) {
      throw new StrategyError(
        StrategyErrorCodes.COMPONENT_NOT_FOUND,
        `Component ${versionId} not found in catalog`,
        { versionId, type, parentId }
      );
    }

    // 5. Validate modified component types match expected slots
    if (component.type !== type) {
      throw new StrategyError(
        StrategyErrorCodes.INVALID_COMPONENT_TYPE,
        `Component ${versionId} is type '${component.type}', expected '${type}'`,
        { versionId, actualType: component.type, expectedType: type }
      );
    }

    loadedComponents[type] = component;
  }

  // 6. Deep merge parent config with modification config
  const newConfig = deepMerge(parent.config, modifications.config || {});

  // Validate config against all components
  for (const type of COMPONENT_ORDER) {
    const component = loadedComponents[type];
    if (component.module && typeof component.module.validateConfig === 'function') {
      const validation = component.module.validateConfig(newConfig);
      if (!validation.valid) {
        throw new StrategyError(
          StrategyErrorCodes.CONFIG_VALIDATION_FAILED,
          `Config validation failed for ${type} component: ${(validation.errors || []).join(', ')}`,
          { type, versionId: newComponents[type], errors: validation.errors }
        );
      }
    }
  }

  // 7. Register with baseStrategyId = parentId
  const forkId = registerStrategy({
    name,
    components: newComponents,
    config: newConfig,
    baseStrategyId: parentId,
  });

  return forkId;
}

/**
 * Compare two strategy configurations and return differences
 *
 * @param {Object} configA - First configuration
 * @param {Object} configB - Second configuration
 * @returns {Object} Config differences { added, removed, changed }
 */
function diffConfigs(configA, configB) {
  const added = {};
  const removed = {};
  const changed = {};

  // Find added and changed keys
  for (const key of Object.keys(configB)) {
    if (!(key in configA)) {
      added[key] = configB[key];
    } else if (JSON.stringify(configA[key]) !== JSON.stringify(configB[key])) {
      changed[key] = { from: configA[key], to: configB[key] };
    }
  }

  // Find removed keys
  for (const key of Object.keys(configA)) {
    if (!(key in configB)) {
      removed[key] = configA[key];
    }
  }

  return { added, removed, changed };
}

/**
 * Find root ancestor of a strategy (for sameBase check)
 *
 * @param {string} strategyId - Strategy ID
 * @returns {string} Root strategy ID
 */
function findRootAncestor(strategyId) {
  let currentId = strategyId;
  const visited = new Set();

  while (currentId) {
    if (visited.has(currentId)) {
      // Circular reference - return current
      return currentId;
    }
    visited.add(currentId);

    const strategy = getStrategy(currentId);
    if (!strategy || !strategy.baseStrategyId) {
      return currentId;
    }
    currentId = strategy.baseStrategyId;
  }

  return strategyId;
}

/**
 * Compare two strategies and return differences
 *
 * @param {string} strategyIdA - First strategy ID
 * @param {string} strategyIdB - Second strategy ID
 * @returns {Object} Structured diff
 * @throws {StrategyError} If either strategy not found
 */
export function diffStrategies(strategyIdA, strategyIdB) {
  const strategyA = getStrategy(strategyIdA);
  if (!strategyA) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_NOT_FOUND,
      `Strategy ${strategyIdA} not found`,
      { strategyId: strategyIdA }
    );
  }

  const strategyB = getStrategy(strategyIdB);
  if (!strategyB) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_NOT_FOUND,
      `Strategy ${strategyIdB} not found`,
      { strategyId: strategyIdB }
    );
  }

  // Check if both have the same root ancestor
  const rootA = findRootAncestor(strategyIdA);
  const rootB = findRootAncestor(strategyIdB);
  const sameBase = rootA === rootB;

  // Compare components
  const components = {};
  for (const type of COMPONENT_ORDER) {
    const versionIdA = strategyA.components[type];
    const versionIdB = strategyB.components[type];
    const match = versionIdA === versionIdB;

    if (match) {
      components[type] = { match: true };
    } else {
      components[type] = {
        match: false,
        a: versionIdA,
        b: versionIdB,
      };
    }
  }

  // Compare configs
  const config = diffConfigs(strategyA.config, strategyB.config);

  return {
    sameBase,
    components,
    config,
  };
}

/**
 * Compare a forked strategy with its parent
 *
 * Convenience wrapper around diffStrategies.
 *
 * @param {string} forkId - Fork strategy ID
 * @returns {Object} Structured diff between fork and parent
 * @throws {StrategyError} If fork not found or has no parent
 */
export function diffFromParent(forkId) {
  const fork = getStrategy(forkId);
  if (!fork) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_NOT_FOUND,
      `Strategy ${forkId} not found`,
      { strategyId: forkId }
    );
  }

  if (!fork.baseStrategyId) {
    throw new StrategyError(
      StrategyErrorCodes.INVALID_FORK_MODIFICATION,
      `Strategy ${forkId} has no parent (not a fork)`,
      { strategyId: forkId }
    );
  }

  return diffStrategies(fork.baseStrategyId, forkId);
}
