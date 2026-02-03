/**
 * Migration 015: Position Counters Table
 *
 * Creates the position_counters table for database-level enforcement of position limits.
 * This implements V3 Philosophy Principle 5: Atomic Operations.
 *
 * Uses CHECK constraints to enforce limits at the database level, not application level:
 * - open_count <= 5 (max simultaneous positions)
 * - total_exposure <= 1000 (max $ exposure)
 *
 * Concurrent update protection uses atomic UPDATE with RETURNING:
 * - Prevents race conditions between concurrent position opens
 * - Never use SELECT then UPDATE pattern (race window)
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the position_counters table schema
 */
export async function up() {
  await exec(`
    -- Position counters table with CHECK constraints
    -- Only one row (id=1) - enforced by CHECK constraint
    CREATE TABLE IF NOT EXISTS position_counters (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      open_count INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0 AND open_count <= 5),
      total_exposure DECIMAL(20, 8) NOT NULL DEFAULT 0 CHECK (total_exposure >= 0 AND total_exposure <= 1000),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Insert the single row if it doesn't exist
    INSERT INTO position_counters (id, open_count, total_exposure, updated_at)
    VALUES (1, 0, 0, NOW())
    ON CONFLICT (id) DO NOTHING;

    -- Create index for the atomic update pattern
    CREATE INDEX IF NOT EXISTS idx_position_counters_id ON position_counters(id);
  `);
}

/**
 * Rollback the position_counters table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_position_counters_id;
    DROP TABLE IF EXISTS position_counters;
  `);
}

/**
 * Atomic increment of open_count
 * Returns true if increment succeeded, false if limit reached
 *
 * Usage example (not part of migration, for reference):
 *
 * const result = await persistence.get(`
 *   UPDATE position_counters
 *   SET open_count = open_count + 1, updated_at = NOW()
 *   WHERE id = 1 AND open_count < 5
 *   RETURNING open_count
 * `);
 * const success = result !== undefined;
 */

/**
 * Atomic increment of total_exposure
 * Returns true if increment succeeded, false if limit reached
 *
 * Usage example (not part of migration, for reference):
 *
 * const result = await persistence.get(`
 *   UPDATE position_counters
 *   SET total_exposure = total_exposure + $1, updated_at = NOW()
 *   WHERE id = 1 AND total_exposure + $1 <= 1000
 *   RETURNING total_exposure
 * `, [newPositionSize]);
 * const success = result !== undefined;
 */
