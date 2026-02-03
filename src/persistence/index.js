/**
 * Persistence Module
 *
 * Public interface for database operations.
 * Implements the standard module contract: init(), getState(), shutdown()
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 *
 * This module provides:
 * - PostgreSQL database initialization
 * - Schema application
 * - Migration infrastructure
 * - Query methods (run, get, all) - ALL ASYNC
 * - Raw SQL execution (exec)
 * - Transaction support (transaction)
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
 * Connects to PostgreSQL, applies schema, runs migrations.
 *
 * @param {Object} config - Configuration object
 * @param {Object} config.database - Database configuration
 * @param {string} config.database.url - PostgreSQL connection URL (DATABASE_URL)
 * @param {Object} config.database.pool - Main pool configuration
 * @param {Object} config.database.circuitBreakerPool - CB pool configuration
 * @param {number} config.database.queryTimeoutMs - Query timeout
 * @param {Object} config.database.retry - Retry configuration
 * @returns {Promise<void>}
 */
async function init(config) {
  if (initialized) {
    return;
  }

  const dbConfig = config?.database;
  if (!dbConfig) {
    throw new PersistenceError(
      ErrorCodes.DB_CONNECTION_FAILED,
      'Database configuration not provided',
      { config }
    );
  }

  // Require DATABASE_URL for PostgreSQL
  if (!dbConfig.url) {
    throw new PersistenceError(
      ErrorCodes.DB_CONNECTION_FAILED,
      'DATABASE_URL not configured. PostgreSQL is required.',
      {}
    );
  }

  console.log('[persistence] Initializing PostgreSQL connection...');

  // Open database connection pools
  await database.open(dbConfig);
  console.log('[persistence] Database connection established');

  // Apply base schema (idempotent with CREATE IF NOT EXISTS)
  try {
    await applySchema();
    console.log('[persistence] Base schema applied');
  } catch (err) {
    console.error('[persistence] Failed to apply schema:', err.message);
    throw err;
  }

  // Run any pending migrations
  try {
    const applied = await runMigrations();
    console.log(`[persistence] Migrations complete. Applied: ${applied.length > 0 ? applied.join(', ') : 'none (all up to date)'}`);
  } catch (err) {
    console.error('[persistence] Migration failed:', err.message);
    throw err;
  }

  initialized = true;
  console.log('[persistence] Initialization complete');
}

/**
 * Get current module state
 *
 * @returns {{ initialized: boolean, connected: boolean, poolConfig: Object|null }}
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
 * Closes database connection pools.
 *
 * @returns {Promise<void>}
 */
async function shutdown() {
  await database.close();
  initialized = false;
}

/**
 * Execute SQL that modifies data (INSERT, UPDATE, DELETE)
 *
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {Promise<{ changes: number, lastInsertRowid: number|null }>}
 */
async function run(sql, params = []) {
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
 * Execute INSERT and return the inserted row's ID
 * Use this for INSERT statements where you need the new row's ID
 *
 * @param {string} sql - INSERT statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {Promise<{ changes: number, lastInsertRowid: number }>}
 */
async function runReturningId(sql, params = []) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.runReturningId(sql, params);
}

/**
 * Get single row from query
 *
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {Promise<any|undefined>} Single row or undefined
 */
async function get(sql, params = []) {
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
 * @returns {Promise<any[]>} Array of rows
 */
async function all(sql, params = []) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.all(sql, params);
}

/**
 * Execute raw SQL for schema operations
 *
 * Use this for DDL statements (CREATE, ALTER, DROP) or batch operations
 * that don't require prepared statement parameters.
 *
 * @param {string} sql - SQL to execute (can contain multiple statements)
 * @returns {Promise<void>}
 */
async function exec(sql) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.exec(sql);
}

/**
 * Execute a function within a transaction
 *
 * Provides atomic execution of multiple database operations.
 * If the function throws, the transaction is rolled back.
 *
 * @param {Function} fn - Async function to execute within transaction
 *   Receives a client object with run, get, all methods
 * @param {Object} options - Transaction options
 * @param {string} options.isolationLevel - 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'
 * @returns {Promise<any>} Return value of the function
 */
async function transaction(fn, options = {}) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.transaction(fn, options);
}

/**
 * Execute query using the circuit-breaker dedicated pool
 * Use this for critical circuit-breaker state checks
 *
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters
 * @returns {Promise<any[]>} Result rows
 */
async function cbQuery(sql, params = []) {
  if (!initialized) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Persistence layer not initialized. Call init() first.',
      {}
    );
  }
  return database.cbQuery(sql, params);
}

// Export as default module with standard interface
export default {
  init,
  getState,
  shutdown,
  run,
  runReturningId,
  get,
  all,
  exec,
  transaction,
  cbQuery,
};

// Also export individual functions for convenience
export { init, getState, shutdown, run, runReturningId, get, all, exec, transaction, cbQuery };
