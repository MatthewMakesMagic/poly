/**
 * Migration 043: Runtime Controls Table
 *
 * DB-driven runtime controls that replace Railway env var dependency.
 * Supports kill switch, trading mode, position limits, and strategy filters.
 *
 * Phase 0.3: Runtime Controls
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS runtime_controls (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Seed default rows
    INSERT INTO runtime_controls (key, value) VALUES
      ('kill_switch', 'off'),
      ('trading_mode', 'PAPER'),
      ('max_position_usd', '5'),
      ('max_session_loss', '20'),
      ('allowed_instruments', '*'),
      ('allowed_strategies', '*')
    ON CONFLICT (key) DO NOTHING;
  `);
}

export async function down() {
  await exec(`DROP TABLE IF EXISTS runtime_controls;`);
}
