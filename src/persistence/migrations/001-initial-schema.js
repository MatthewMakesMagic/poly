/**
 * Migration 001: Initial Schema
 *
 * Records that the initial schema has been applied.
 * The actual schema is applied via applySchema() in init(),
 * which uses CREATE IF NOT EXISTS for idempotent application.
 *
 * This migration exists to:
 * 1. Establish the migration pattern for future schema changes
 * 2. Record that the initial schema version is applied
 * 3. Prevent future migrations from running before the base schema exists
 */

/**
 * Apply the initial schema
 * Note: Schema is already applied in init() via applySchema().
 * This migration only records that initial schema is complete.
 */
export function up() {
  // No-op: Schema already applied in init() before migrations run.
  // This migration just records that initial schema version is complete.
}

/**
 * Rollback is not supported for initial schema
 */
export function down() {
  throw new Error('Cannot rollback initial schema migration');
}
