/**
 * Strategy Factory — Public API (Story 2.7)
 *
 * Single entry point for the factory module. Provides:
 * - composeFromYaml(yamlString) — YAML string → strategy object
 * - composeFromDefinition(definition) — parsed definition → strategy object
 * - validateDefinition(definition) — validate block references without composing
 * - listBlocks() — list all registered building blocks
 * - loadBlocks(factoryDir) — initialize the block registry
 * - loadStrategy(name, options) — load a strategy by name (.yaml or .js)
 *
 * Covers: FR4, FR42, NFR12, NFR14
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeFromYaml, composeFromDefinition, validateDefinition } from './compose.js';
import { loadBlocks, listBlocks, isInitialized } from './registry.js';

/** Default directories for strategy lookup */
const FACTORY_STRATEGIES_DIR = new URL('strategies/', import.meta.url).pathname;
const BACKTEST_STRATEGIES_DIR = new URL('../backtest/strategies/', import.meta.url).pathname;

/**
 * Load a strategy by name, resolving .yaml or .js files from strategy directories.
 *
 * Resolution order:
 * 1. src/factory/strategies/{name}.yaml
 * 2. src/factory/strategies/{name}.js
 * 3. src/backtest/strategies/{name}.js
 *
 * @param {string} name - Strategy name (without extension, or with)
 * @param {Object} [options]
 * @param {string[]} [options.searchDirs] - Override search directories
 * @returns {Promise<{ name: string, evaluate: Function, onWindowOpen?: Function, defaults: Object, sweepGrid?: Object }>}
 * @throws {Error} If strategy not found or fails to load
 */
export async function loadStrategy(name, options = {}) {
  const searchDirs = options.searchDirs || [FACTORY_STRATEGIES_DIR, BACKTEST_STRATEGIES_DIR];

  // Ensure registry is loaded for YAML composition
  if (!isInitialized()) {
    await loadBlocks();
  }

  // Try each directory and extension
  for (const dir of searchDirs) {
    // If name already has extension, try it directly
    if (extname(name)) {
      const filePath = join(dir, name);
      const result = await tryLoadStrategy(filePath);
      if (result) return result;
      continue;
    }

    // Try .yaml first, then .js
    for (const ext of ['.yaml', '.yml', '.js']) {
      const filePath = join(dir, name + ext);
      const result = await tryLoadStrategy(filePath);
      if (result) return result;
    }
  }

  throw new Error(
    `Strategy '${name}' not found. Searched directories:\n` +
    searchDirs.map(d => `  - ${d}`).join('\n') +
    `\nTried extensions: .yaml, .yml, .js\n` +
    `Check spelling or place the strategy file in one of these directories.`
  );
}

/**
 * Try to load a strategy from a specific file path.
 *
 * @param {string} filePath - Full file path
 * @returns {Promise<Object|null>} Strategy object or null if file doesn't exist
 */
async function tryLoadStrategy(filePath) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') {
    return tryLoadYamlStrategy(filePath);
  }

  if (ext === '.js') {
    return tryLoadJsStrategy(filePath);
  }

  return null;
}

/**
 * Try to load a YAML strategy from a file path.
 *
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
async function tryLoadYamlStrategy(filePath) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return null; // File doesn't exist
  }

  return composeFromYaml(content);
}

/**
 * Try to load a JS strategy from a file path.
 *
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
async function tryLoadJsStrategy(filePath) {
  let mod;
  try {
    mod = await import(pathToFileURL(filePath).href);
  } catch (err) {
    // If file doesn't exist, return null; otherwise re-throw
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw new Error(`Failed to load JS strategy '${filePath}': ${err.message}`);
  }

  // Validate JS strategy has required exports
  if (typeof mod.name !== 'string') {
    throw new Error(
      `JS strategy '${filePath}' missing 'name' export. ` +
      `JS strategies must export: { name, evaluate, defaults }. ` +
      `This is a JS escape hatch compatibility issue (FR2, FR42).`
    );
  }
  if (typeof mod.evaluate !== 'function') {
    throw new Error(
      `JS strategy '${filePath}' missing 'evaluate' export. ` +
      `JS strategies must export: { name, evaluate, defaults }.`
    );
  }

  return {
    name: mod.name,
    evaluate: mod.evaluate,
    onWindowOpen: mod.onWindowOpen || undefined,
    onWindowClose: mod.onWindowClose || undefined,
    defaults: mod.defaults || {},
    sweepGrid: mod.sweepGrid || {},
    description: mod.description || '',
  };
}

/**
 * List all available strategy files from the strategy directories.
 *
 * @param {Object} [options]
 * @param {string[]} [options.searchDirs] - Override search directories
 * @returns {Promise<{ name: string, path: string, type: 'yaml'|'js' }[]>}
 */
export async function listStrategies(options = {}) {
  const searchDirs = options.searchDirs || [FACTORY_STRATEGIES_DIR, BACKTEST_STRATEGIES_DIR];
  const strategies = [];

  for (const dir of searchDirs) {
    let files;
    try {
      files = await readdir(dir);
    } catch {
      continue; // Directory may not exist
    }

    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (ext === '.yaml' || ext === '.yml') {
        strategies.push({
          name: basename(file, ext),
          path: join(dir, file),
          type: 'yaml',
        });
      } else if (ext === '.js' && file !== 'index.js') {
        strategies.push({
          name: basename(file, ext),
          path: join(dir, file),
          type: 'js',
        });
      }
    }
  }

  return strategies;
}

// Re-export public API
export {
  composeFromYaml,
  composeFromDefinition,
  validateDefinition,
  listBlocks,
  loadBlocks,
};
