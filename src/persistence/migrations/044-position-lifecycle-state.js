/**
 * Migration 044: Position lifecycle state column
 *
 * Phase 2.1: Add lifecycle_state column to positions table.
 * Tracks position through: ENTRY -> MONITORING -> exit triggers -> CLOSED
 *
 * Backfills existing data:
 * - open positions -> 'MONITORING' (already past entry)
 * - closed/liquidated positions -> 'CLOSED'
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS lifecycle_state TEXT DEFAULT 'ENTRY';

    -- Backfill: open positions are already being monitored
    UPDATE positions SET lifecycle_state = 'MONITORING' WHERE status = 'open';

    -- Backfill: closed/liquidated positions are done
    UPDATE positions SET lifecycle_state = 'CLOSED' WHERE status IN ('closed', 'liquidated');

    -- Index for filtering by lifecycle state
    CREATE INDEX IF NOT EXISTS idx_positions_lifecycle_state ON positions(lifecycle_state);
  `);
}

export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_positions_lifecycle_state;
    ALTER TABLE positions DROP COLUMN IF EXISTS lifecycle_state;
  `);
}
