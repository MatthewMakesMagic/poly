/**
 * Migration 019: Window Entries Table
 *
 * Creates the window_entries table for atomic safeguard tracking.
 *
 * V3 Stage 4: Single Book + Atomic Safeguards (Phase 1)
 * Replaces in-memory Sets/Maps with PostgreSQL as single source of truth.
 */

import { exec } from '../database.js';

/**
 * Apply the window_entries table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS window_entries (
      id SERIAL PRIMARY KEY,
      window_id TEXT NOT NULL,
      strategy_id TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved', 'confirmed')),
      symbol TEXT,
      reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      UNIQUE(window_id, strategy_id)
    );
    CREATE INDEX IF NOT EXISTS idx_window_entries_status ON window_entries(status);
    CREATE INDEX IF NOT EXISTS idx_window_entries_symbol ON window_entries(symbol);
  `);
}

/**
 * Rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_window_entries_symbol;
    DROP INDEX IF EXISTS idx_window_entries_status;
    DROP TABLE IF EXISTS window_entries;
  `);
}
