/**
 * SQLite database connection management
 *
 * Provides synchronous database access using better-sqlite3.
 * Implements WAL mode for better concurrency.
 */

import Database from 'better-sqlite3';
import { PersistenceError, ErrorCodes } from '../types/errors.js';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

/** @type {Database.Database|null} */
let db = null;

/** @type {string|null} */
let dbPath = null;

/** @type {boolean} */
let connected = false;

/**
 * Open database connection
 * @param {string} path - Path to SQLite database file
 * @returns {Database.Database} Database instance
 */
export function open(path) {
  if (db) {
    return db;
  }

  try {
    // Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database (creates if doesn't exist)
    db = new Database(path);

    // Enable WAL mode for better concurrency and crash recovery
    db.pragma('journal_mode = WAL');

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    dbPath = path;
    connected = true;

    return db;
  } catch (error) {
    // Log before throwing (TODO: replace with logger module from Story 1-4)
    console.error('[persistence] DB_CONNECTION_FAILED:', error.message, { path });
    throw new PersistenceError(
      ErrorCodes.DB_CONNECTION_FAILED,
      `Failed to open database at ${path}: ${error.message}`,
      { path, originalError: error.message }
    );
  }
}

/**
 * Get the database instance
 * @returns {Database.Database} Database instance
 * @throws {PersistenceError} If database not initialized
 */
export function getDb() {
  if (!db) {
    throw new PersistenceError(
      ErrorCodes.DB_NOT_INITIALIZED,
      'Database not initialized. Call init() first.',
      {}
    );
  }
  return db;
}

/**
 * Close database connection
 */
export function close() {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
    connected = false;
  }
}

/**
 * Get connection state
 * @returns {{ connected: boolean, path: string|null }}
 */
export function getState() {
  return {
    connected,
    path: dbPath,
  };
}

/**
 * Execute SQL that modifies data (INSERT, UPDATE, DELETE)
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {{ changes: number, lastInsertRowid: number|bigint }}
 */
export function run(sql, params = []) {
  const database = getDb();
  try {
    const stmt = database.prepare(sql);
    return stmt.run(...params);
  } catch (error) {
    // Log before throwing (TODO: replace with logger module from Story 1-4)
    console.error('[persistence] DB_QUERY_FAILED (run):', error.message, { sql: sql.substring(0, 100) });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, params, originalError: error.message }
    );
  }
}

/**
 * Get single row from query
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {any|undefined} Single row or undefined
 */
export function get(sql, params = []) {
  const database = getDb();
  try {
    const stmt = database.prepare(sql);
    return stmt.get(...params);
  } catch (error) {
    // Log before throwing (TODO: replace with logger module from Story 1-4)
    console.error('[persistence] DB_QUERY_FAILED (get):', error.message, { sql: sql.substring(0, 100) });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, params, originalError: error.message }
    );
  }
}

/**
 * Get all rows from query
 * @param {string} sql - SQL statement
 * @param {any[]} [params=[]] - Parameters for prepared statement
 * @returns {any[]} Array of rows
 */
export function all(sql, params = []) {
  const database = getDb();
  try {
    const stmt = database.prepare(sql);
    return stmt.all(...params);
  } catch (error) {
    // Log before throwing (TODO: replace with logger module from Story 1-4)
    console.error('[persistence] DB_QUERY_FAILED (all):', error.message, { sql: sql.substring(0, 100) });
    throw new PersistenceError(
      ErrorCodes.DB_QUERY_FAILED,
      `Query failed: ${error.message}`,
      { sql, params, originalError: error.message }
    );
  }
}

/**
 * Execute raw SQL (for schema changes)
 * @param {string} sql - SQL to execute
 */
export function exec(sql) {
  const database = getDb();
  try {
    database.exec(sql);
  } catch (error) {
    // Log before throwing (TODO: replace with logger module from Story 1-4)
    console.error('[persistence] DB_SCHEMA_ERROR:', error.message, { sql: sql.substring(0, 100) });
    throw new PersistenceError(
      ErrorCodes.DB_SCHEMA_ERROR,
      `Schema execution failed: ${error.message}`,
      { sql: sql.substring(0, 200), originalError: error.message }
    );
  }
}
