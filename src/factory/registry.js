/**
 * Block Registry — Auto-discovers and manages composable building blocks.
 *
 * Scans signals/, filters/, sizers/ directories for .js files,
 * imports them, and registers blocks by type and name.
 *
 * Each block module must export: name, description, paramSchema, create(params)
 *
 * Singleton — initialized once via loadBlocks(), then queried via getBlock/listBlocks.
 *
 * Covers: FR6, FR7, FR8 (building block libraries), NFR16 (independent testability)
 */

import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const BLOCK_TYPES = ['signal', 'filter', 'sizer'];
const TYPE_DIRS = { signal: 'signals', filter: 'filters', sizer: 'sizers' };

/** @type {Map<string, Map<string, Object>>} type → (name → blockModule) */
let registry = new Map();
let initialized = false;

/**
 * Load all building blocks from the factory directories.
 *
 * @param {string} [factoryDir] - Base directory containing signals/, filters/, sizers/
 * @returns {Promise<{ loaded: number, errors: string[] }>}
 */
export async function loadBlocks(factoryDir) {
  const baseDir = factoryDir || new URL('.', import.meta.url).pathname;
  registry = new Map();
  for (const type of BLOCK_TYPES) {
    registry.set(type, new Map());
  }

  let loaded = 0;
  const errors = [];

  for (const type of BLOCK_TYPES) {
    const dir = join(baseDir, TYPE_DIRS[type]);
    let files;
    try {
      files = await readdir(dir);
    } catch {
      // Directory may not exist yet — not an error
      continue;
    }

    const jsFiles = files.filter(f => f.endsWith('.js') && f !== 'index.js');

    for (const file of jsFiles) {
      const filePath = join(dir, file);
      try {
        const mod = await import(pathToFileURL(filePath).href);
        validateBlockModule(mod, type, file);
        registry.get(type).set(mod.name, mod);
        loaded++;
      } catch (err) {
        errors.push(`[${type}/${file}] ${err.message}`);
      }
    }
  }

  initialized = true;
  return { loaded, errors };
}

/**
 * Validate that a module exports the required block interface.
 *
 * @param {Object} mod - Imported module
 * @param {string} type - Block type (signal, filter, sizer)
 * @param {string} file - Filename for error messages
 * @throws {Error} If module is missing required exports
 */
function validateBlockModule(mod, type, file) {
  const missing = [];
  if (typeof mod.name !== 'string') missing.push('name (string)');
  if (typeof mod.description !== 'string') missing.push('description (string)');
  if (typeof mod.paramSchema !== 'object' || mod.paramSchema === null) missing.push('paramSchema (object)');
  if (typeof mod.create !== 'function') missing.push('create (function)');

  if (missing.length > 0) {
    throw new Error(`Missing required exports: ${missing.join(', ')}`);
  }
}

/**
 * Retrieve a registered block by type and name.
 *
 * @param {string} type - 'signal' | 'filter' | 'sizer'
 * @param {string} name - Block name
 * @returns {Object} Block module with { name, description, paramSchema, create }
 * @throws {Error} Descriptive error listing available blocks if not found
 */
export function getBlock(type, name) {
  if (!initialized) {
    throw new Error(
      `Block registry not initialized — call loadBlocks() before getBlock(). ` +
      `This is a startup sequencing issue in the factory pipeline.`
    );
  }

  if (!BLOCK_TYPES.includes(type)) {
    throw new Error(
      `Unknown block type '${type}'. Valid types: ${BLOCK_TYPES.join(', ')}. ` +
      `Check the YAML strategy definition for typos in block type references.`
    );
  }

  const typeMap = registry.get(type);
  const block = typeMap.get(name);
  if (!block) {
    const available = [...typeMap.keys()];
    throw new Error(
      `No ${type} block named '${name}' found. ` +
      `Available ${type} blocks: [${available.join(', ')}]. ` +
      `Check the YAML strategy definition for typos in the 'type' field.`
    );
  }

  return block;
}

/**
 * List all registered blocks, grouped by type.
 *
 * @returns {{ signal: Object[], filter: Object[], sizer: Object[] }}
 */
export function listBlocks() {
  if (!initialized) {
    throw new Error(
      `Block registry not initialized — call loadBlocks() before listBlocks().`
    );
  }

  const result = {};
  for (const type of BLOCK_TYPES) {
    result[type] = [];
    for (const [, block] of registry.get(type)) {
      result[type].push({
        name: block.name,
        description: block.description,
        paramSchema: block.paramSchema,
      });
    }
  }
  return result;
}

/**
 * Check if the registry has been initialized.
 *
 * @returns {boolean}
 */
export function isInitialized() {
  return initialized;
}

/**
 * Reset registry state (for testing).
 */
export function resetRegistry() {
  registry = new Map();
  initialized = false;
}
