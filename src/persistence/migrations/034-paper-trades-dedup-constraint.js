/**
 * Migration 034: Add unique constraint to prevent duplicate paper trades
 *
 * Railway restarts lose in-memory activeWindows, causing duplicate signal
 * evaluations for the same window/strategy/offset/variant combo.
 *
 * Steps:
 * 1. Delete existing duplicates (keep earliest by id)
 * 2. Add unique index to prevent future dupes
 */
import { exec } from '../database.js';

export async function up() {
  // Delete existing duplicates — keep the row with the lowest id
  await exec(`
    DELETE FROM paper_trades_v2
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM paper_trades_v2
      GROUP BY window_id, signal_type, signal_offset_sec, variant_label
    )
  `);

  // Add unique index
  await exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_trades_v2_dedup
    ON paper_trades_v2 (window_id, signal_type, signal_offset_sec, variant_label)
  `);
}

export async function down() {
  await exec('DROP INDEX IF EXISTS idx_paper_trades_v2_dedup');
}
