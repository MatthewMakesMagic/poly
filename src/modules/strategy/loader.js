/**
 * Strategy Loader
 *
 * Loads strategy definitions from JSON configuration files
 * and registers them with the strategy framework.
 *
 * Features:
 * - Load single strategy from config file path
 * - Auto-discover and load all strategies from config directory
 * - Validate component references against catalog
 * - Return strategy ID for execution
 *
 * @module modules/strategy/loader
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { StrategyError, StrategyErrorCodes } from './types.js';
import { getFromCatalog } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STRATEGIES_DIR = join(__dirname, '../../../config/strategies');

/**
 * Loaded strategies registry
 * Maps strategy name -> strategy definition
 */
const loadedStrategies = new Map();

/**
 * Active strategy name
 */
let activeStrategyName = null;

/**
 * Load a strategy from a JSON config file
 *
 * @param {string} configPath - Path to strategy JSON file
 * @returns {Object} Loaded strategy definition with validation result
 * @throws {StrategyError} If file not found or invalid JSON
 */
export function loadStrategyFromConfig(configPath) {
  // Check file exists
  if (!existsSync(configPath)) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_NOT_FOUND,
      `Strategy config file not found: ${configPath}`,
      { configPath }
    );
  }

  // Read and parse JSON
  let strategyDef;
  try {
    const content = readFileSync(configPath, 'utf-8');
    strategyDef = JSON.parse(content);
  } catch (err) {
    throw new StrategyError(
      StrategyErrorCodes.CONFIG_VALIDATION_FAILED,
      `Failed to parse strategy config: ${err.message}`,
      { configPath, error: err.message }
    );
  }

  // Validate required fields
  const requiredFields = ['name', 'components'];
  const missingFields = requiredFields.filter(f => !strategyDef[f]);
  if (missingFields.length > 0) {
    throw new StrategyError(
      StrategyErrorCodes.MISSING_REQUIRED_FIELD,
      `Strategy config missing required fields: ${missingFields.join(', ')}`,
      { configPath, missingFields }
    );
  }

  // Validate component references
  const validation = validateComponentReferences(strategyDef.components);

  // Build full strategy object
  const strategy = {
    name: strategyDef.name,
    description: strategyDef.description || null,
    version: strategyDef.version || 1,
    components: strategyDef.components,
    config: strategyDef.config || {},
    pipeline: strategyDef.pipeline || { order: [], signalAggregation: 'first_signal' },
    author: strategyDef.author || null,
    createdAt: strategyDef.createdAt || null,
    configPath,
    validation,
    loaded: true,
  };

  // Store in registry
  loadedStrategies.set(strategy.name, strategy);

  return strategy;
}

/**
 * Validate that all component references exist in the catalog
 *
 * @param {Object} components - Components definition from strategy config
 * @returns {Object} Validation result { valid, errors, componentStatus }
 */
export function validateComponentReferences(components) {
  const errors = [];
  const componentStatus = {};

  // Check each component type
  for (const [type, value] of Object.entries(components)) {
    // Handle arrays (e.g., multiple analysis components)
    const versionIds = Array.isArray(value) ? value : [value];

    for (const versionId of versionIds) {
      const component = getFromCatalog(versionId);
      const key = `${type}:${versionId}`;

      if (!component) {
        errors.push(`Component not found in catalog: ${versionId}`);
        componentStatus[key] = { found: false, versionId };
      } else {
        componentStatus[key] = {
          found: true,
          versionId,
          name: component.name,
          type: component.type,
        };
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    componentStatus,
  };
}

/**
 * Load all strategies from the strategies config directory
 *
 * @param {string} [strategiesDir] - Path to strategies directory (default: config/strategies/)
 * @returns {Object} Loading result { loaded, failed, strategies }
 */
export function loadAllStrategies(strategiesDir = DEFAULT_STRATEGIES_DIR) {
  const result = {
    loaded: [],
    failed: [],
    strategies: {},
  };

  // Check directory exists
  if (!existsSync(strategiesDir)) {
    return result;
  }

  // Read directory
  let files;
  try {
    files = readdirSync(strategiesDir);
  } catch (err) {
    return result;
  }

  // Load each JSON file
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue;
    }

    const configPath = join(strategiesDir, file);

    try {
      const strategy = loadStrategyFromConfig(configPath);
      result.loaded.push(strategy.name);
      result.strategies[strategy.name] = strategy;
    } catch (err) {
      result.failed.push({
        file,
        error: err.message,
      });
    }
  }

  return result;
}

/**
 * Get a loaded strategy by name
 *
 * @param {string} name - Strategy name
 * @returns {Object|null} Strategy definition or null if not loaded
 */
export function getLoadedStrategy(name) {
  return loadedStrategies.get(name) || null;
}

/**
 * List all loaded strategies
 *
 * @returns {Object[]} Array of strategy summaries
 */
export function listLoadedStrategies() {
  const strategies = [];

  for (const [name, strategy] of loadedStrategies) {
    strategies.push({
      name,
      description: strategy.description,
      version: strategy.version,
      valid: strategy.validation.valid,
      componentCount: countComponents(strategy.components),
      configPath: strategy.configPath,
    });
  }

  return strategies;
}

/**
 * Set the active strategy by name
 *
 * @param {string} name - Strategy name
 * @returns {Object} The activated strategy
 * @throws {StrategyError} If strategy not loaded or invalid
 */
export function setActiveStrategy(name) {
  const strategy = loadedStrategies.get(name);

  if (!strategy) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_NOT_FOUND,
      `Strategy not loaded: ${name}. Load it first with loadStrategyFromConfig().`,
      { name, loadedStrategies: Array.from(loadedStrategies.keys()) }
    );
  }

  if (!strategy.validation.valid) {
    throw new StrategyError(
      StrategyErrorCodes.STRATEGY_VALIDATION_FAILED,
      `Strategy has invalid component references: ${strategy.validation.errors?.join(', ')}`,
      { name, errors: strategy.validation.errors }
    );
  }

  activeStrategyName = name;
  return strategy;
}

/**
 * Get the currently active strategy
 *
 * @returns {Object|null} Active strategy or null if none set
 */
export function getActiveStrategy() {
  if (!activeStrategyName) {
    return null;
  }
  return loadedStrategies.get(activeStrategyName) || null;
}

/**
 * Get the active strategy name
 *
 * @returns {string|null} Active strategy name or null
 */
export function getActiveStrategyName() {
  return activeStrategyName;
}

/**
 * Count total components in a components definition
 *
 * @param {Object} components - Components definition
 * @returns {number} Total component count
 */
function countComponents(components) {
  let count = 0;
  for (const value of Object.values(components)) {
    if (Array.isArray(value)) {
      count += value.length;
    } else if (value) {
      count += 1;
    }
  }
  return count;
}

/**
 * Clear all loaded strategies (for testing/reset)
 */
export function clearLoadedStrategies() {
  loadedStrategies.clear();
  activeStrategyName = null;
}

/**
 * Get loader state
 *
 * @returns {Object} Current loader state
 */
export function getLoaderState() {
  return {
    loadedCount: loadedStrategies.size,
    activeStrategy: activeStrategyName,
    strategies: Array.from(loadedStrategies.keys()),
  };
}

export default {
  loadStrategyFromConfig,
  loadAllStrategies,
  getLoadedStrategy,
  listLoadedStrategies,
  setActiveStrategy,
  getActiveStrategy,
  getActiveStrategyName,
  validateComponentReferences,
  clearLoadedStrategies,
  getLoaderState,
};
