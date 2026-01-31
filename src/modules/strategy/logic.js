/**
 * Strategy Registry Logic
 *
 * Core business logic for the strategy component registry.
 * Handles version ID generation, component discovery, validation,
 * and database operations for strategy registration.
 */

import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { run, get, all } from '../../persistence/database.js';
import { ComponentType, TypePrefix, StrategyError, StrategyErrorCodes } from './types.js';
import { getCatalog, setCatalog, addToCatalog, getFromCatalog, incrementStrategyCount } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate a unique version ID for a component
 *
 * Format: {type-prefix}-{name}-v{version}
 * Examples: prob-spot-lag-v1, entry-threshold-v2
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @param {number} version - Version number
 * @returns {string} Version ID
 * @throws {StrategyError} If type is invalid
 */
export function generateVersionId(type, name, version) {
  const prefix = TypePrefix[type];
  if (!prefix) {
    throw new StrategyError(
      StrategyErrorCodes.INVALID_COMPONENT_TYPE,
      `Invalid component type: ${type}`,
      { type, validTypes: Object.keys(TypePrefix) }
    );
  }

  // Ensure version is a positive integer
  const versionNum = Math.max(1, Math.floor(Number(version) || 1));

  return `${prefix}-${name}-v${versionNum}`;
}

/**
 * Parse a version ID into its components
 *
 * @param {string} versionId - Version ID to parse
 * @returns {Object|null} Parsed components or null if invalid
 */
export function parseVersionId(versionId) {
  if (!versionId || typeof versionId !== 'string') {
    return null;
  }

  // Match pattern: prefix-name-vN
  const match = versionId.match(/^(prob|entry|exit|sizing)-(.+)-v(\d+)$/);
  if (!match) {
    return null;
  }

  const [, prefix, name, version] = match;

  // Map prefix back to type
  const typeMap = {
    prob: ComponentType.PROBABILITY,
    entry: ComponentType.ENTRY,
    exit: ComponentType.EXIT,
    sizing: ComponentType.SIZING,
  };

  return {
    type: typeMap[prefix],
    name,
    version: parseInt(version, 10),
    prefix,
  };
}

/**
 * Validate a component exports the required interface
 *
 * Required exports:
 * - metadata: { name, version, type, description? }
 * - evaluate: function(context, config)
 * - validateConfig: function(config)
 *
 * @param {Object} component - Imported component module
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateComponentInterface(component) {
  const errors = [];

  // Check metadata
  if (!component.metadata) {
    errors.push('Missing metadata export');
  } else {
    if (!component.metadata.name) {
      errors.push('Missing metadata.name');
    }
    if (component.metadata.version === undefined || component.metadata.version === null) {
      errors.push('Missing metadata.version');
    }
    if (!component.metadata.type) {
      errors.push('Missing metadata.type');
    } else if (!Object.values(ComponentType).includes(component.metadata.type)) {
      errors.push(`Invalid metadata.type: ${component.metadata.type}`);
    }
  }

  // Check evaluate function
  if (typeof component.evaluate !== 'function') {
    errors.push('Missing or invalid evaluate function');
  }

  // Check validateConfig function
  if (typeof component.validateConfig !== 'function') {
    errors.push('Missing or invalid validateConfig function');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Discover all components in the filesystem
 *
 * Scans src/modules/strategy/components/{type}/ directories
 * and validates each .js file exports required interface.
 *
 * @param {string} [basePath] - Base path for component directories (defaults to ./components)
 * @returns {Promise<Object>} Component catalog by type
 */
export async function discoverComponents(basePath) {
  const componentsPath = basePath || join(__dirname, 'components');
  const catalog = {
    probability: {},
    entry: {},
    exit: {},
    sizing: {},
  };

  const types = Object.values(ComponentType);

  for (const type of types) {
    const typePath = join(componentsPath, type);

    // Skip if directory doesn't exist
    if (!existsSync(typePath)) {
      continue;
    }

    try {
      const files = readdirSync(typePath);

      for (const file of files) {
        // Skip template files and non-JS files
        if (file.startsWith('_') || !file.endsWith('.js')) {
          continue;
        }

        try {
          const componentPath = join(typePath, file);
          const component = await import(componentPath);

          // Validate interface
          const validation = validateComponentInterface(component);
          if (!validation.valid) {
            // Log warning but continue - don't fail entire discovery
            console.warn(`Component ${file} has invalid interface:`, validation.errors);
            continue;
          }

          // Generate version ID from metadata
          const { name, version, type: componentType } = component.metadata;
          const versionId = generateVersionId(componentType, name, version);

          // Add to catalog
          catalog[type][versionId] = {
            versionId,
            name,
            version,
            type: componentType,
            description: component.metadata.description || null,
            author: component.metadata.author || null,
            createdAt: component.metadata.createdAt || null,
            filePath: componentPath,
            module: component,
          };
        } catch (err) {
          // Log error but continue discovery
          console.warn(`Failed to load component ${file}:`, err.message);
        }
      }
    } catch (err) {
      // Log error but continue with other types
      console.warn(`Failed to scan component directory ${type}:`, err.message);
    }
  }

  return catalog;
}

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
 * @throws {StrategyError} If required fields missing or components not found
 */
export function registerStrategy({ name, components, config = {}, baseStrategyId = null }) {
  // Validate required fields
  if (!name) {
    throw new StrategyError(
      StrategyErrorCodes.MISSING_REQUIRED_FIELD,
      'Strategy name is required',
      { field: 'name' }
    );
  }

  if (!components) {
    throw new StrategyError(
      StrategyErrorCodes.MISSING_REQUIRED_FIELD,
      'Components are required',
      { field: 'components' }
    );
  }

  const requiredComponents = ['probability', 'entry', 'exit', 'sizing'];
  for (const comp of requiredComponents) {
    if (!components[comp]) {
      throw new StrategyError(
        StrategyErrorCodes.MISSING_REQUIRED_FIELD,
        `Component ${comp} is required`,
        { field: `components.${comp}` }
      );
    }
  }

  // Generate unique strategy ID
  const strategyId = `strat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();

  // Insert into database
  try {
    run(`
      INSERT INTO strategy_instances (
        id, name, base_strategy_id,
        probability_component, entry_component, exit_component, sizing_component,
        config, created_at, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      strategyId,
      name,
      baseStrategyId,
      components.probability,
      components.entry,
      components.exit,
      components.sizing,
      JSON.stringify(config),
      createdAt,
      1, // active
    ]);

    incrementStrategyCount();
    return strategyId;
  } catch (err) {
    throw new StrategyError(
      StrategyErrorCodes.DATABASE_ERROR,
      `Failed to register strategy: ${err.message}`,
      { name, error: err.message }
    );
  }
}

/**
 * Get strategy by ID with full component details
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object|null} Strategy instance or null if not found
 */
export function getStrategy(strategyId) {
  if (!strategyId) {
    return null;
  }

  try {
    const row = get(
      'SELECT * FROM strategy_instances WHERE id = ?',
      [strategyId]
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      baseStrategyId: row.base_strategy_id,
      components: {
        probability: row.probability_component,
        entry: row.entry_component,
        exit: row.exit_component,
        sizing: row.sizing_component,
      },
      config: JSON.parse(row.config || '{}'),
      createdAt: row.created_at,
      active: row.active === 1,
    };
  } catch (err) {
    throw new StrategyError(
      StrategyErrorCodes.DATABASE_ERROR,
      `Failed to get strategy: ${err.message}`,
      { strategyId, error: err.message }
    );
  }
}

/**
 * Get component by version ID from the in-memory catalog
 *
 * @param {string} versionId - Component version ID (e.g., "prob-spot-lag-v1")
 * @returns {Object|null} Component metadata and module reference or null if not found
 */
export function getComponent(versionId) {
  return getFromCatalog(versionId);
}

/**
 * List all available components, optionally filtered by type
 *
 * @param {string} [type] - Filter by component type (probability, entry, exit, sizing)
 * @returns {Object[]} Array of component metadata
 */
export function listComponents(type) {
  const catalog = getCatalog();

  if (type) {
    if (!catalog[type]) {
      return [];
    }
    return Object.values(catalog[type]).map(c => ({
      versionId: c.versionId,
      name: c.name,
      version: c.version,
      type: c.type,
      description: c.description,
      createdAt: c.createdAt,
    }));
  }

  // Return all components across all types
  const result = [];
  for (const typeComponents of Object.values(catalog)) {
    for (const comp of Object.values(typeComponents)) {
      result.push({
        versionId: comp.versionId,
        name: comp.name,
        version: comp.version,
        type: comp.type,
        description: comp.description,
        createdAt: comp.createdAt,
      });
    }
  }
  return result;
}

/**
 * Get all components used by a strategy with full details
 *
 * @param {string} strategyId - Strategy instance ID
 * @returns {Object|null} Component details for each type or null if strategy not found
 */
export function getStrategyComponents(strategyId) {
  const strategy = getStrategy(strategyId);
  if (!strategy) {
    return null;
  }

  const result = {};

  for (const [type, versionId] of Object.entries(strategy.components)) {
    const component = getFromCatalog(versionId);
    result[type] = {
      versionId,
      name: component?.name ?? null,
      version: component?.version ?? null,
      type,
      createdAt: component?.createdAt ?? null,
      inCatalog: component !== null,
    };
  }

  return result;
}

/**
 * List all registered strategies
 *
 * @param {Object} [options] - Query options
 * @param {boolean} [options.activeOnly=true] - Only return active strategies
 * @param {number} [options.limit=100] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Object[]} Array of strategy summaries
 */
export function listStrategies({ activeOnly = true, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM strategy_instances';
  const params = [];

  if (activeOnly) {
    sql += ' WHERE active = 1';
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const rows = all(sql, params);
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      baseStrategyId: row.base_strategy_id,
      components: {
        probability: row.probability_component,
        entry: row.entry_component,
        exit: row.exit_component,
        sizing: row.sizing_component,
      },
      createdAt: row.created_at,
      active: row.active === 1,
    }));
  } catch (err) {
    throw new StrategyError(
      StrategyErrorCodes.DATABASE_ERROR,
      `Failed to list strategies: ${err.message}`,
      { error: err.message }
    );
  }
}

/**
 * Deactivate a strategy (soft delete)
 *
 * @param {string} strategyId - Strategy ID to deactivate
 * @returns {boolean} True if strategy was deactivated
 */
export function deactivateStrategy(strategyId) {
  if (!strategyId) {
    return false;
  }

  try {
    const result = run(
      'UPDATE strategy_instances SET active = 0 WHERE id = ?',
      [strategyId]
    );
    return result.changes > 0;
  } catch (err) {
    throw new StrategyError(
      StrategyErrorCodes.DATABASE_ERROR,
      `Failed to deactivate strategy: ${err.message}`,
      { strategyId, error: err.message }
    );
  }
}
