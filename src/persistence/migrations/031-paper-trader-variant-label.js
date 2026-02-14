/**
 * Migration 031: Add variant_label to paper_trades_v2
 *
 * Supports parameter sweep: multiple threshold/size combos evaluated per window.
 * Each combo gets its own row with a label like 'tight-sm', 'base-lg', etc.
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE paper_trades_v2
    ADD COLUMN IF NOT EXISTS variant_label TEXT DEFAULT 'base'
  `);

  await exec(`
    ALTER TABLE paper_trades_v2
    ADD COLUMN IF NOT EXISTS position_size_dollars DECIMAL(16, 2)
  `);

  await exec(`
    ALTER TABLE paper_trades_v2
    ADD COLUMN IF NOT EXISTS vwap_delta_threshold DECIMAL(16, 2)
  `);
}

export async function down() {
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS variant_label');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS position_size_dollars');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS vwap_delta_threshold');
}
