/**
 * Migration 032: Add signal_offset_sec to paper_trades_v2
 *
 * Supports multi-timing evaluation: signals evaluated at T-10s, T-30s, T-60s, etc.
 * Each timing gets its own rows so we can compare win rates across signal times.
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE paper_trades_v2
    ADD COLUMN IF NOT EXISTS signal_offset_sec INTEGER DEFAULT 60
  `);
}

export async function down() {
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS signal_offset_sec');
}
