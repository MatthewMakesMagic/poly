/**
 * Strategy Component Runtime Registry
 *
 * Runtime component registration functionality separate from filesystem discovery.
 * Allows programmatic creation of new component versions.
 *
 * Requirements Addressed:
 * - FR34: User can update a central component when change is a core improvement
 *
 * @module modules/strategy/registry
 */

import { ComponentType, TypePrefix, StrategyError, StrategyErrorCodes } from './types.js';
import { addToCatalog, getFromCatalog } from './state.js';
import { generateVersionId, validateComponentInterface } from './logic.js';

/**
 * Create a new component version and add to catalog
 *
 * Validates the component type, generates a version ID, checks for duplicates,
 * dynamically imports the component module, validates its interface,
 * and adds it to the in-memory catalog.
 *
 * @param {string} type - Component type (probability, entry, exit, sizing)
 * @param {string} name - Component name (kebab-case)
 * @param {number} version - Version number
 * @param {string} modulePath - Path to component module file
 * @returns {Promise<string>} New version ID
 * @throws {StrategyError} If type invalid, version exists, or interface invalid
 */
export async function createComponentVersion(type, name, version, modulePath) {
  // 1. Validate type is valid ComponentType
  if (!Object.values(ComponentType).includes(type)) {
    throw new StrategyError(
      StrategyErrorCodes.INVALID_COMPONENT_TYPE,
      `Invalid component type: ${type}`,
      { type, validTypes: Object.values(ComponentType) }
    );
  }

  // 2. Generate version ID: {prefix}-{name}-v{version}
  const versionId = generateVersionId(type, name, version);

  // 3. Check version ID doesn't already exist in catalog
  const existing = getFromCatalog(versionId);
  if (existing) {
    throw new StrategyError(
      StrategyErrorCodes.COMPONENT_VERSION_EXISTS,
      `Component version ${versionId} already exists in catalog`,
      { versionId, type, name, version }
    );
  }

  // 4. Dynamically import module from modulePath
  let component;
  try {
    component = await import(modulePath);
  } catch (err) {
    throw new StrategyError(
      StrategyErrorCodes.DISCOVERY_ERROR,
      `Failed to import component module: ${err.message}`,
      { modulePath, error: err.message }
    );
  }

  // 5. Validate component interface (metadata, evaluate, validateConfig)
  const validation = validateComponentInterface(component);
  if (!validation.valid) {
    throw new StrategyError(
      StrategyErrorCodes.INVALID_COMPONENT_INTERFACE,
      `Component ${versionId} has invalid interface: ${validation.errors.join(', ')}`,
      { versionId, modulePath, errors: validation.errors }
    );
  }

  // Validate metadata type matches the requested type
  if (component.metadata.type !== type) {
    throw new StrategyError(
      StrategyErrorCodes.INVALID_COMPONENT_TYPE,
      `Component metadata.type '${component.metadata.type}' does not match requested type '${type}'`,
      { versionId, metadataType: component.metadata.type, requestedType: type }
    );
  }

  // 6. Add to catalog via addToCatalog()
  const componentInfo = {
    versionId,
    name,
    version,
    type,
    description: component.metadata.description || null,
    author: component.metadata.author || null,
    createdAt: new Date().toISOString(),
    filePath: modulePath,
    module: component,
  };

  addToCatalog(type, versionId, componentInfo);

  // 7. Return version ID
  return versionId;
}
