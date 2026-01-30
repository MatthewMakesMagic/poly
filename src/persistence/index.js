/**
 * Persistence Module
 *
 * Public interface for database operations.
 * Implements the standard module contract: init(), getState(), shutdown()
 *
 * This module provides:
 * - SQLite database initialization
 * - Schema application (trade_intents table)
 * - Migration infrastructure
 * - Query methods (run, get, all)
 */

import * as database from './database.js';
import { applySchema } from './schema-manager.js';
import { runMigrations } from './migrations/index.js';
import { PersistenceError, ErrorCodes } from '../types/errors.js';

/** @type {boolean} */
let initialized = false;

/**
 * Initialize the persistence layer
 *
 * Creates database file, applies schema, runs migrations.
 *
 * @param {Object} config - Configuration object
 * @param {Object} config.database - Database configuration
 * @param {string} config.database.path - Path to SQLite database file
 * @returns {Promise<void>}
 */
async function init(config) {
  if (initialized) {
    return;
  }

  const dbPath = config?.database?.path;
  if (!dbPath) {
    throw new PersistenceError(
      ErrorCodes.DB_CONNECTION_FAILED,
      'Database path not configured',
      { config }
    );
  }

  // Open database connection
  database.open(dbPath);

  // Apply base schema (idempotent with CREATE IF NOT EXISTS)
  applySchema();

  // Run any pending migrations
  await runMigrations();

  initialized = true;
}

/**
 * Get current module state
 *
 * @returns {{ initialized: boolean, connected: boolean, path: string|null }}
 */
function getState() {
  const dbState = database.getState();
  return {
    initialized,
    ...dbState,
  };
}

/**
 * Shutdown the persistence layer
 *
 * Closes database connection.
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  database.close();
  initialized = false;
}

/**
 * Execute SQL that modifies data (INSERT, UPDATE, DELETE)
 *
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {{ changes: number, lastInsertRowid: number|bigint }}
 */
function run(sql, params = []) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.run(sql, params);
}

/**
 * Get single row from query
 *
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {any|undefined} Single row or undefined
 */
function get(sql, params = []) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.get(sql, params);
}

/**
 * Get all rows from query
 *
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {any[]} Array of rows
 */
function all(sql, params = []) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.all(sql, params);
}

// Export as default module with standard interface
export default {
  init,
  getState,
  shutdown,
  run,
  get,
  all,
};

// Also export individual functions for convenience
export { init, getState, shutdown, run, get, all };
