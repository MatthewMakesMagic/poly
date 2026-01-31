/**
 * Schema Manager
 *
 * Handles database schema application and migrations.
 * Uses CREATE IF NOT EXISTS for idempotent schema application.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec, get, run, all } from './database.js';
import { PersistenceError, ErrorCodes } from '../types/errors.js';
import { child as createLoggerChild } from '../modules/logger/index.js';

// Create module-scoped logger
const log = createLoggerChild({ module: 'schema-manager' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Apply the base schema from schema.sql
 * Uses CREATE IF NOT EXISTS for idempotent application
 */
export function applySchema() {
  try {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    exec(schema);
  } catch (error) {
    if (error instanceof PersistenceError) {
      throw error;
    }
    log.error('db_schema_apply_failed', { error: error.message });
    throw new PersistenceError(
      ErrorCodes.DB_SCHEMA_ERROR,
      `Failed to apply schema: ${error.message}`,
      { originalError: error.message }
    );
  }
}

/**
 * Check if a table exists
 * @param {string} tableName - Name of table to check
 * @returns {boolean} True if table exists
 */
export function tableExists(tableName) {
  const result = get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    [tableName]
  );
  return !!result;
}

/**
 * Get list of columns for a table
 * @param {string} tableName - Name of table
 * @returns {string[]} Array of column names
 */
export function getTableColumns(tableName) {
  // Validate table name to prevent SQL injection (only allow alphanumeric and underscore)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Invalid table name: ${tableName}`,
      { tableName }
    );
  }

  // PRAGMA table_info returns multiple rows with: cid, name, type, notnull, dflt_value, pk
  const rows = all(`PRAGMA table_info(${tableName})`);
  return rows.map(row => row.name);
}

/**
 * Check if an index exists
 * @param {string} indexName - Name of index to check
 * @returns {boolean} True if index exists
 */
export function indexExists(indexName) {
  const result = get(
    "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
    [indexName]
  );
  return !!result;
}

/**
 * Get the current schema version (last applied migration)
 * @returns {string|null} Version string or null if no migrations applied
 */
export function getCurrentVersion() {
  if (!tableExists('schema_migrations')) {
    return null;
  }

  const result = get(
    'SELECT version FROM schema_migrations ORDER BY id DESC LIMIT 1'
  );
  return result ? result.version : null;
}

/**
 * Record a migration as applied
 * @param {string} version - Migration version (e.g., '001')
 * @param {string} name - Migration name (e.g., 'initial-schema')
 */
export function recordMigration(version, name) {
  run(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    [version, name, new Date().toISOString()]
  );
}

/**
 * Check if a migration has been applied
 * @param {string} version - Migration version to check
 * @returns {boolean} True if migration has been applied
 */
export function migrationApplied(version) {
  if (!tableExists('schema_migrations')) {
    return false;
  }

  const result = get(
    'SELECT id FROM schema_migrations WHERE version = ?',
    [version]
  );
  return !!result;
}
