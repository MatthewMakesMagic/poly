/**
 * Migration Runner
 *
 * Discovers and runs database migrations in order.
 * Migrations are tracked in the schema_migrations table.
 */

import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { migrationApplied, recordMigration } from '../schema-manager.js';
import { PersistenceError, ErrorCodes } from '../../types/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get all migration files in order
 * @returns {string[]} Array of migration filenames
 */
function getMigrationFiles() {
  try {
    const files = readdirSync(__dirname);
    return files
      .filter(f => f.match(/^\d{3}-.*\.js$/) && f !== 'index.js')
      .sort();
  } catch {
    return [];
  }
}

/**
 * Parse migration version and name from filename
 * @param {string} filename - Migration filename (e.g., '001-initial-schema.js')
 * @returns {{ version: string, name: string }}
 */
function parseMigrationFilename(filename) {
  const match = filename.match(/^(\d{3})-(.+)\.js$/);
  if (!match) {
    throw new PersistenceError(
      ErrorCodes.DB_MIGRATION_FAILED,
      `Invalid migration filename: ${filename}`,
      { filename }
    );
  }
  return {
    version: match[1],
    name: match[2],
  };
}

/**
 * Run all pending migrations
 * @returns {Promise<string[]>} Array of applied migration versions
 */
export async function runMigrations() {
  const applied = [];
  const migrations = getMigrationFiles();

  console.log(`[migrations] Found ${migrations.length} migration files: ${migrations.join(', ')}`);

  for (const filename of migrations) {
    const { version, name } = parseMigrationFilename(filename);

    if (migrationApplied(version)) {
      console.log(`[migrations] Skipping ${version}-${name} (already applied)`);
      continue;
    }

    console.log(`[migrations] Running ${version}-${name}...`);

    try {
      // Dynamically import migration
      const migrationPath = join(__dirname, filename);
      const migration = await import(migrationPath);

      // Run the migration
      if (typeof migration.up === 'function') {
        await migration.up();
      } else if (typeof migration.default === 'function') {
        await migration.default();
      } else {
        throw new Error('Migration must export an up() function or default function');
      }

      // Record the migration
      recordMigration(version, name);
      applied.push(version);
      console.log(`[migrations] Applied ${version}-${name}`);
    } catch (error) {
      console.error(`[migrations] Failed ${version}-${name}:`, error.message);
      throw new PersistenceError(
        ErrorCodes.DB_MIGRATION_FAILED,
        `Migration ${version}-${name} failed: ${error.message}`,
        { version, name, originalError: error.message }
      );
    }
  }

  return applied;
}

/**
 * Get list of pending migrations
 * @returns {string[]} Array of pending migration versions
 */
export function getPendingMigrations() {
  const pending = [];
  const migrations = getMigrationFiles();

  for (const filename of migrations) {
    const { version } = parseMigrationFilename(filename);
    if (!migrationApplied(version)) {
      pending.push(version);
    }
  }

  return pending;
}
