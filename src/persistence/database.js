/**
 * PostgreSQL database connection management
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 *
 * Provides async database access using pg (node-postgres).
 * Implements:
 * - Dual connection pools (main + circuit-breaker)
 * - Startup guard with retry
 * - Query timeout (5s default)
 * - Exponential backoff for connection errors
 * - SSL requirement for LIVE mode
 */

import pg from 'pg';
import { PersistenceError, ErrorCodes } from '../types/errors.js';
import { child as createLoggerChild } from '../modules/logger/index.js';

const { Pool } = pg;

// Create module-scoped logger
const log = createLoggerChild({ module: 'persistence' });

/** @type {pg.Pool|null} Main connection pool */
let mainPool = null;

/** @type {pg.Pool|null} Dedicated circuit-breaker pool */
let cbPool = null;

/** @type {boolean} */
let connected = false;

/** @type {Object|null} Pool configuration (for state reporting) */
let poolConfig = null;

/**
 * Retryable PostgreSQL error codes
 * These errors indicate transient connection issues that may succeed on retry
 */
const RETRYABLE_ERRORS = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

/**
 * Check if error is retryable
 * @param {Error} error - Error to check
 * @returns {boolean}
 */
function isRetryableError(error) {
  if (RETRYABLE_ERRORS.has(error.code)) return true;
  if (error.errno && RETRYABLE_ERRORS.has(error.errno)) return true;
  return false;
}

/**
 * Redact DATABASE_URL for safe logging
 * @param {string} url - Database URL
 * @returns {string} Redacted URL
 */
function redactDatabaseUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.username ? '***:***@' : ''}${parsed.hostname}:${parsed.port || 5432}/${parsed.pathname.slice(1)}`;
  } catch {
    return '[INVALID_URL]';
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Open database connection pools
 * @param {Object} config - Database configuration from config/index.js
 * @param {string} config.url - PostgreSQL connection URL (DATABASE_URL)
 * @param {Object} config.pool - Main pool configuration
 * @param {Object} config.circuitBreakerPool - CB pool configuration
 * @param {number} config.queryTimeoutMs - Query timeout
 * @param {Object} config.retry - Retry configuration
 * @returns {Promise<void>}
 */
export async function open(config) {
  if (mainPool) {
    return; // Already connected
  }

  const {
    url,
    pool: mainPoolConfig,
    circuitBreakerPool: cbPoolConfig,
    queryTimeoutMs = 5000,
    retry = { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 2000 },
  } = config;

  if (!url) {
    throw new PersistenceError(
      ErrorCodes.DB_CONNECTION_FAILED,
      'DATABASE_URL not configured',
      {}
    );
  }

  // Create pool configurations
  const baseConfig = {
    connectionString: url,
    // SSL configuration - pg handles sslmode in connection string
    statement_timeout: queryTimeoutMs,
  };

  const mainConfig = {
    ...baseConfig,
    min: mainPoolConfig?.min ?? 2,
    max: mainPoolConfig?.max ?? 10,
    idleTimeoutMillis: mainPoolConfig?.idleTimeoutMs ?? 30000,
    connectionTimeoutMillis: mainPoolConfig?.connectionTimeoutMs ?? 5000,
  };

  const cbConfig = {
    ...baseConfig,
    min: cbPoolConfig?.min ?? 1,
    max: cbPoolConfig?.max ?? 2,
    idleTimeoutMillis: cbPoolConfig?.idleTimeoutMs ?? 30000,
    connectionTimeoutMillis: cbPoolConfig?.connectionTimeoutMs ?? 1000,
  };

  // Attempt connection with retry
  let lastError;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      log.info('db_connecting', {
        attempt,
        maxAttempts: retry.maxAttempts,
        url: redactDatabaseUrl(url),
      });

      // Create pools
      mainPool = new Pool(mainConfig);
      cbPool = new Pool(cbConfig);

      // Test connection with main pool
      const client = await mainPool.connect();
      await client.query('SELECT 1');
      client.release();

      // Test CB pool too
      const cbClient = await cbPool.connect();
      await cbClient.query('SELECT 1');
      cbClient.release();

      connected = true;
      poolConfig = { main: mainPoolConfig, cb: cbPoolConfig, queryTimeoutMs };

      log.info('db_connected', {
        url: redactDatabaseUrl(url),
        mainPool: { min: mainConfig.min, max: mainConfig.max },
        cbPool: { min: cbConfig.min, max: cbConfig.max },
      });

      return;
    } catch (error) {
      lastError = error;

      // Clean up failed pools
      if (mainPool) {
        await mainPool.end().catch(() => {});
        mainPool = null;
      }
      if (cbPool) {
        await cbPool.end().catch(() => {});
        cbPool = null;
      }

      if (attempt < retry.maxAttempts) {
        const delay = Math.min(
          retry.initialDelayMs * Math.pow(2, attempt - 1),
          retry.maxDelayMs
        );
        log.warn('db_connection_retry', {
          attempt,
          maxAttempts: retry.maxAttempts,
          delay,
          error: error.message,
          code: error.code,
        });
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  log.error('db_connection_failed', {
    attempts: retry.maxAttempts,
    error: lastError?.message,
    code: lastError?.code,
  });

  throw new PersistenceError(
    ErrorCodes.DB_CONNECTION_FAILED,
    `Failed to connect to PostgreSQL after ${retry.maxAttempts} attempts: ${lastError?.message}`,
    { attempts: retry.maxAttempts, code: lastError?.code }
  );
}

/**
 * Get the main connection pool
 * @returns {pg.Pool} Main pool
 * @throws {PersistenceError} If database not initialized
 */
export function getPool() {
  if (!mainPool) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Database not initialized. Call open() first.',
      {}
    );
  }
  return mainPool;
}

/**
 * Get the circuit-breaker dedicated pool
 * @returns {pg.Pool} CB pool
 * @throws {PersistenceError} If database not initialized
 */
export function getCBPool() {
  if (!cbPool) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Database not initialized. Call open() first.',
      {}
    );
  }
  return cbPool;
}

/**
 * Close all database connections
 * @returns {Promise<void>}
 */
export async function close() {
  if (mainPool) {
    await mainPool.end();
    mainPool = null;
  }
  if (cbPool) {
    await cbPool.end();
    cbPool = null;
  }
  connected = false;
  poolConfig = null;
}

/**
 * Get connection state
 * @returns {{ connected: boolean, poolConfig: Object|null }}
 */
export function getState() {
  return {
    connected,
    poolConfig,
    mainPoolStats: mainPool ? {
      totalCount: mainPool.totalCount,
      idleCount: mainPool.idleCount,
      waitingCount: mainPool.waitingCount,
    } : null,
    cbPoolStats: cbPool ? {
      totalCount: cbPool.totalCount,
      idleCount: cbPool.idleCount,
      waitingCount: cbPool.waitingCount,
    } : null,
  };
}

/**
 * Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ...
 * @param {string} sql - SQL with ? placeholders
 * @returns {string} SQL with $n placeholders
 */
function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/**
 * Execute query with retry for transient errors
 * @param {pg.Pool} pool - Pool to use
 * @param {string} sql - SQL statement
 * @param {any[]} params - Query parameters
 * @param {Object} retryConfig - Retry configuration
 * @returns {Promise<pg.QueryResult>}
 */
async function queryWithRetry(pool, sql, params, retryConfig = { maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 400 }) {
  let lastError;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      lastError = error;

      // Don't retry non-retryable errors (constraint violations, syntax errors, etc.)
      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt < retryConfig.maxAttempts) {
        const delay = Math.min(
          retryConfig.initialDelayMs * Math.pow(2, attempt - 1),
          retryConfig.maxDelayMs
        );
        log.warn('db_query_retry', {
          attempt,
          delay,
          error: error.message,
          code: error.code,
        });
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Execute SQL that modifies data (INSERT, UPDATE, DELETE)
 * @param {string} sql - SQL statement (can use ? or $n placeholders)
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {Promise<{ changes: number, lastInsertRowid: number|null }>}
 */
export async function run(sql, params = []) {
  const pool = getPool();
  const pgSql = convertPlaceholders(sql);

  try {
    const result = await queryWithRetry(pool, pgSql, params);
    return {
      changes: result.rowCount ?? 0,
      // PostgreSQL doesn't return lastInsertRowid by default
      // Caller should use RETURNING id for inserts
      lastInsertRowid: result.rows?.[0]?.id ?? null,
    };
  } catch (error) {
    log.error('db_query_failed', {
      operation: 'run',
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code,
    });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, code: error.code }
    );
  }
}

/**
 * Execute INSERT and return the inserted row's ID
 * Use this instead of run() when you need lastInsertRowid
 * @param {string} sql - INSERT statement (will have RETURNING id appended)
 * @param {any[]} [params=[]] - Parameters
 * @returns {Promise<{ changes: number, lastInsertRowid: number }>}
 */
export async function runReturningId(sql, params = []) {
  const pool = getPool();
  let pgSql = convertPlaceholders(sql);

  // Append RETURNING id if not present
  if (!/RETURNING/i.test(pgSql)) {
    pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
  }

  try {
    const result = await queryWithRetry(pool, pgSql, params);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: result.rows?.[0]?.id ?? null,
    };
  } catch (error) {
    log.error('db_query_failed', {
      operation: 'runReturningId',
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code,
    });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, code: error.code }
    );
  }
}

/**
 * Get single row from query
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {Promise<any|undefined>} Single row or undefined
 */
export async function get(sql, params = []) {
  const pool = getPool();
  const pgSql = convertPlaceholders(sql);

  try {
    const result = await queryWithRetry(pool, pgSql, params);
    return result.rows[0];
  } catch (error) {
    log.error('db_query_failed', {
      operation: 'get',
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code,
    });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, code: error.code }
    );
  }
}

/**
 * Get all rows from query
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {Promise<any[]>} Array of rows
 */
export async function all(sql, params = []) {
  const pool = getPool();
  const pgSql = convertPlaceholders(sql);

  try {
    const result = await queryWithRetry(pool, pgSql, params);
    return result.rows;
  } catch (error) {
    log.error('db_query_failed', {
      operation: 'all',
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code,
    });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, code: error.code }
    );
  }
}

/**
 * Execute raw SQL (for schema changes)
 * Supports multiple statements separated by semicolons
 * @param {string} sql - SQL to execute
 * @returns {Promise<void>}
 */
export async function exec(sql) {
  const pool = getPool();

  try {
    // PostgreSQL can execute multiple statements in one query
    await pool.query(sql);
  } catch (error) {
    log.error('db_schema_error', {
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code,
    });
    throw new PersistenceError(
      ErrorCodes.DB_SCHEMA_ERROR,
      `Schema execution failed: ${error.message}`,
      { sql: sql.substring(0, 200), code: error.code }
    );
  }
}

/**
 * Execute a function within a transaction
 *
 * Provides atomic execution of multiple database operations.
 * If the function throws, the transaction is rolled back.
 *
 * @param {Function} fn - Async function to execute within transaction
 *   Receives a client object with query(sql, params) method
 * @param {Object} options - Transaction options
 * @param {string} options.isolationLevel - 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'
 * @returns {Promise<any>} Return value of the function
 */
export async function transaction(fn, options = {}) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    const isolationLevel = options.isolationLevel || 'READ COMMITTED';
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevel}`);

    // Create a wrapped client with helper methods
    const txClient = {
      query: (sql, params = []) => client.query(convertPlaceholders(sql), params),
      run: async (sql, params = []) => {
        const result = await client.query(convertPlaceholders(sql), params);
        return { changes: result.rowCount ?? 0, lastInsertRowid: result.rows?.[0]?.id ?? null };
      },
      runReturningId: async (sql, params = []) => {
        let pgSql = convertPlaceholders(sql);
        if (!/RETURNING/i.test(pgSql)) {
          pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
        }
        const result = await client.query(pgSql, params);
        return { changes: result.rowCount ?? 0, lastInsertRowid: result.rows?.[0]?.id ?? null };
      },
      get: async (sql, params = []) => {
        const result = await client.query(convertPlaceholders(sql), params);
        return result.rows[0];
      },
      all: async (sql, params = []) => {
        const result = await client.query(convertPlaceholders(sql), params);
        return result.rows;
      },
    };

    const result = await fn(txClient);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Execute query using the circuit-breaker dedicated pool
 * Use this for critical circuit-breaker state checks
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters
 * @returns {Promise<any[]>} Result rows
 */
export async function cbQuery(sql, params = []) {
  const pool = getCBPool();
  const pgSql = convertPlaceholders(sql);

  try {
    const result = await pool.query(pgSql, params);
    return result.rows;
  } catch (error) {
    log.error('cb_query_failed', {
      sql: sql.substring(0, 200),
      error: error.message,
      code: error.code,
    });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Circuit breaker query failed: ${error.message}`,
      { sql, code: error.code }
    );
  }
}
