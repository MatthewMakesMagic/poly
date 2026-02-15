/**
 * Migration 033: Add strategy metadata to paper_trades_v2
 *
 * Supports multi-strategy paper trading: strategy-specific metadata (JSONB)
 * and VWAP source tracking (composite, coingecko, vwap20).
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE paper_trades_v2
    ADD COLUMN IF NOT EXISTS strategy_metadata JSONB
  `);

  await exec(`
    ALTER TABLE paper_trades_v2
    ADD COLUMN IF NOT EXISTS vwap_source TEXT DEFAULT 'composite'
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_paper_trades_v2_signal_type
    ON paper_trades_v2 (signal_type)
  `);
}

export async function down() {
  await exec('DROP INDEX IF EXISTS idx_paper_trades_v2_signal_type');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS vwap_source');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS strategy_metadata');
}
