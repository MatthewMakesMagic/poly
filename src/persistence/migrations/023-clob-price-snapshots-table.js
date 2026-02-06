/**
 * Migration 023: CLOB Price Snapshots Table
 *
 * Creates the clob_price_snapshots table for continuous UP/DOWN token
 * price capture throughout full 15-minute windows.
 *
 * FINDTHEGOLD Data Capture Infrastructure - Phase 1 (Task 1.2)
 */

import { exec } from '../database.js';

/**
 * Apply the clob_price_snapshots table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS clob_price_snapshots (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      token_id VARCHAR(100) NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      window_epoch BIGINT NOT NULL,
      best_bid DECIMAL(10, 6),
      best_ask DECIMAL(10, 6),
      mid_price DECIMAL(10, 6),
      spread DECIMAL(10, 6),
      last_trade_price DECIMAL(10, 6),
      bid_size_top DECIMAL(20, 8),
      ask_size_top DECIMAL(20, 8)
    );

    CREATE INDEX IF NOT EXISTS idx_clob_snap_token_time
      ON clob_price_snapshots (token_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_clob_snap_epoch
      ON clob_price_snapshots (window_epoch, timestamp);
  `);
}

/**
 * Rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_clob_snap_epoch;
    DROP INDEX IF EXISTS idx_clob_snap_token_time;
    DROP TABLE IF EXISTS clob_price_snapshots;
  `);
}
