/**
 * Migration 037: Add live order columns to paper_trades_v2
 *
 * Tracks real FOK order results alongside simulated fills.
 * Entry order fields capture the initial buy, exit fields capture thesis-exit sells.
 * live_order_status defaults to 'paper' for backward compatibility.
 */
import { exec } from '../database.js';

export async function up() {
  // Entry order columns
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS live_order_id TEXT`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS live_fill_price DECIMAL(10,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS live_fill_shares DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS live_cost DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS live_tx_hash TEXT`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS live_order_status TEXT DEFAULT 'paper'`);

  // Exit order columns
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_order_id TEXT`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_live_fill_price DECIMAL(10,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_live_proceeds DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_live_fee DECIMAL(16,6)`);
  await exec(`ALTER TABLE paper_trades_v2 ADD COLUMN IF NOT EXISTS exit_live_tx_hash TEXT`);
}

export async function down() {
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_live_tx_hash');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_live_fee');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_live_proceeds');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_live_fill_price');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS exit_order_id');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS live_order_status');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS live_tx_hash');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS live_cost');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS live_fill_shares');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS live_fill_price');
  await exec('ALTER TABLE paper_trades_v2 DROP COLUMN IF EXISTS live_order_id');
}
