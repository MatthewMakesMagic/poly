/**
 * Launch Config Logic
 *
 * Validation and file operations for the launch-config module.
 *
 * @module modules/launch-config/logic
 */

import fs from 'fs';
import path from 'path';
import {
  LaunchConfigError,
  LaunchConfigErrorCodes,
  MANIFEST_SCHEMA,
  MANIFEST_DEFAULTS,
  getKnownStrategyNames,
} from './types.js';

// Default manifest path relative to project root
const DEFAULT_MANIFEST_PATH = './config/launch.json';

// Project root for path validation (security: prevent path traversal)
const PROJECT_ROOT = path.resolve('.');

/**
 * Validate that a path is within the project directory (security: path traversal prevention)
 *
 * @param {string} resolvedPath - Fully resolved path to validate
 * @throws {LaunchConfigError} If path is outside project root
 */
function validatePathSecurity(resolvedPath) {
  const normalizedPath = path.normalize(resolvedPath);
  if (!normalizedPath.startsWith(PROJECT_ROOT)) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.VALIDATION_FAILED,
      `Path traversal attempt detected: ${resolvedPath}`,
      { path: resolvedPath, projectRoot: PROJECT_ROOT }
    );
  }
}

/**
 * Validate a value against schema type
 *
 * @param {*} value - Value to validate
 * @param {Object} schema - Property schema
 * @returns {boolean} True if valid
 */
function validateType(value, schema) {
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (schema.minItems && value.length < schema.minItems) return false;
    if (schema.maxItems && value.length > schema.maxItems) return false;
    if (schema.items && schema.items.type) {
      return value.every((item) => typeof item === schema.items.type);
    }
    return true;
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number' || isNaN(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    return true;
  }

  if (schema.type === 'boolean') {
    return typeof value === 'boolean';
  }

  if (schema.type === 'string') {
    return typeof value === 'string';
  }

  return true;
}

/**
 * Validate manifest against schema
 *
 * @param {Object} manifest - Manifest object to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateManifestSchema(manifest) {
  const errors = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  // Check required fields
  for (const field of MANIFEST_SCHEMA.required) {
    if (!(field in manifest)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate field types
  for (const [field, schema] of Object.entries(MANIFEST_SCHEMA.properties)) {
    if (field in manifest) {
      if (!validateType(manifest[field], schema)) {
        errors.push(`Invalid type for field '${field}': expected ${schema.type}`);
      }
    }
  }

  // Check for additional properties
  if (MANIFEST_SCHEMA.additionalProperties === false) {
    const allowedKeys = Object.keys(MANIFEST_SCHEMA.properties);
    for (const key of Object.keys(manifest)) {
      if (!allowedKeys.includes(key)) {
        errors.push(`Unknown field: ${key}`);
      }
    }
  }

  // Check for duplicate strategies
  if (Array.isArray(manifest.strategies)) {
    const uniqueStrategies = new Set(manifest.strategies);
    if (uniqueStrategies.size !== manifest.strategies.length) {
      errors.push('Duplicate strategies detected');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Validate that all strategies in manifest are known
 *
 * @param {string[]} strategies - Array of strategy names
 * @returns {Object} Validation result { valid: boolean, unknownStrategies?: string[] }
 */
export function validateStrategyNames(strategies) {
  const knownNames = getKnownStrategyNames();
  const unknownStrategies = strategies.filter((s) => !knownNames.includes(s));

  return {
    valid: unknownStrategies.length === 0,
    unknownStrategies: unknownStrategies.length > 0 ? unknownStrategies : undefined,
  };
}

/**
 * Read and parse the launch manifest file (synchronous - for init only)
 *
 * @param {string} [manifestPath] - Path to manifest file (defaults to config/launch.json)
 * @returns {Object} Parsed manifest object
 * @throws {LaunchConfigError} If file not found or invalid JSON
 */
export function readManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const resolvedPath = path.resolve(manifestPath);

  // Security: validate path is within project root
  validatePathSecurity(resolvedPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.MANIFEST_NOT_FOUND,
      `Launch manifest not found: ${resolvedPath}`,
      { path: resolvedPath }
    );
  }

  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new LaunchConfigError(
        LaunchConfigErrorCodes.INVALID_MANIFEST_SCHEMA,
        `Invalid JSON in launch manifest: ${err.message}`,
        { path: resolvedPath, parseError: err.message }
      );
    }
    throw err;
  }
}

/**
 * Write manifest to file atomically (write to temp, then rename)
 *
 * @param {Object} manifest - Manifest object to write
 * @param {string} [manifestPath] - Path to manifest file
 * @throws {LaunchConfigError} If write fails
 */
export function writeManifest(manifest, manifestPath = DEFAULT_MANIFEST_PATH) {
  const resolvedPath = path.resolve(manifestPath);

  // Security: validate path is within project root
  validatePathSecurity(resolvedPath);

  try {
    const content = JSON.stringify(manifest, null, 2) + '\n';

    // Atomic write: write to temp file in same directory, then rename
    const tempPath = `${resolvedPath}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, resolvedPath);
  } catch (err) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.WRITE_FAILED,
      `Failed to write launch manifest: ${err.message}`,
      { path: resolvedPath, error: err.message }
    );
  }
}

/**
 * Load and validate a manifest
 *
 * @param {string} [manifestPath] - Path to manifest file
 * @returns {Object} Validated manifest object
 * @throws {LaunchConfigError} If validation fails
 */
export function loadAndValidateManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = readManifest(manifestPath);

  // Validate schema
  const schemaResult = validateManifestSchema(manifest);
  if (!schemaResult.valid) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.INVALID_MANIFEST_SCHEMA,
      `Invalid manifest schema: ${schemaResult.errors.join(', ')}`,
      { errors: schemaResult.errors }
    );
  }

  // Validate strategy names
  const strategyResult = validateStrategyNames(manifest.strategies);
  if (!strategyResult.valid) {
    throw new LaunchConfigError(
      LaunchConfigErrorCodes.UNKNOWN_STRATEGY,
      `Unknown strategies: ${strategyResult.unknownStrategies.join(', ')}`,
      { unknownStrategies: strategyResult.unknownStrategies }
    );
  }

  return manifest;
}

/**
 * Merge updates into manifest with validation
 *
 * @param {Object} currentManifest - Current manifest
 * @param {Object} updates - Updates to apply
 * @returns {Object} Merged manifest
 */
export function mergeManifestUpdates(currentManifest, updates) {
  return {
    ...currentManifest,
    ...updates,
  };
}

/**
 * Get default manifest values
 *
 * @returns {Object} Default manifest (deep copy)
 */
export function getDefaultManifest() {
  return {
    ...MANIFEST_DEFAULTS,
    strategies: [...MANIFEST_DEFAULTS.strategies],
    symbols: [...MANIFEST_DEFAULTS.symbols],
  };
}
