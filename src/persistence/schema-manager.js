/**
 * Schema Manager
 *
 * Handles database schema application and migrations.
 * Uses CREATE IF NOT EXISTS for idempotent schema application.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
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
 * @returns {Promise<void>}
 */
export async function applySchema() {
  try {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    await exec(schema);
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
 * @returns {Promise<boolean>} True if table exists
 */
export async function tableExists(tableName) {
  const result = await get(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return result?.exists === true;
}

/**
 * Get list of columns for a table
 * @param {string} tableName - Name of table
 * @returns {Promise<string[]>} Array of column names
 */
export async function getTableColumns(tableName) {
  // Validate table name to prevent SQL injection (only allow alphanumeric and underscore)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Invalid table name: ${tableName}`,
      { tableName }
    );
  }

  const rows = await all(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
     AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );
  return rows.map(row => row.column_name);
}

/**
 * Check if an index exists
 * @param {string} indexName - Name of index to check
 * @returns {Promise<boolean>} True if index exists
 */
export async function indexExists(indexName) {
  const result = await get(
    `SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public'
      AND indexname = $1
    ) AS exists`,
    [indexName]
  );
  return result?.exists === true;
}

/**
 * Get the current schema version (last applied migration)
 * @returns {Promise<string|null>} Version string or null if no migrations applied
 */
export async function getCurrentVersion() {
  const exists = await tableExists('schema_migrations');
  if (!exists) {
    return null;
  }

  const result = await get(
    'SELECT version FROM schema_migrations ORDER BY id DESC LIMIT 1'
  );
  return result ? result.version : null;
}

/**
 * Record a migration as applied
 * @param {string} version - Migration version (e.g., '001')
 * @param {string} name - Migration name (e.g., 'initial-schema')
 * @returns {Promise<void>}
 */
export async function recordMigration(version, name) {
  await run(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
    [version, name, new Date().toISOString()]
  );
}

/**
 * Check if a migration has been applied
 * @param {string} version - Migration version to check
 * @returns {Promise<boolean>} True if migration has been applied
 */
export async function migrationApplied(version) {
  const exists = await tableExists('schema_migrations');
  if (!exists) {
    return false;
  }

  const result = await get(
    'SELECT id FROM schema_migrations WHERE version = $1',
    [version]
  );
  return !!result;
}
