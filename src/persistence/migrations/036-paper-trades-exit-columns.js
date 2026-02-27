/**
 * Migration 036: Add thesis-exit columns to paper_trades_v2
 *
 * Supports early exit when the VWAP thesis deteriorates post-entry.
 * Tracks exit price, proceeds, PnL, and the thesis strength at exit time.
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exited_early BOOLEAN DEFAULT FALSE`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_time TIMESTAMPTZ`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_price DECIMAL(10,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_proceeds DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_fee DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_pnl DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_reason TEXT`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_vwap_price DECIMAL(20,8)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_thesis_strength DECIMAL(10,6)`);
}

export async function down() {
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_thesis_strength');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_vwap_price');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_reason');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_pnl');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_fee');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_proceeds');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_price');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_time');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exited_early');
}
