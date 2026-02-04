/**
 * Migration 018: Order Book Snapshots Table
 *
 * Creates the order_book_snapshots table for periodic order book captures.
 *
 * V3 Philosophy Implementation - Phase 5: Data Capture Infrastructure (Task 5.2)
 */

import { exec } from '../database.js';

/**
 * Apply the order_book_snapshots table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS order_book_snapshots (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      token_id VARCHAR(100) NOT NULL,
      best_bid DECIMAL(10, 4),
      best_ask DECIMAL(10, 4),
      spread DECIMAL(10, 6),
      mid_price DECIMAL(10, 4),
      bid_depth_100 DECIMAL(20, 2),
      ask_depth_100 DECIMAL(20, 2),
      bid_depth_500 DECIMAL(20, 2),
      ask_depth_500 DECIMAL(20, 2)
    );

    CREATE INDEX IF NOT EXISTS idx_orderbook_symbol_time
      ON order_book_snapshots (symbol, timestamp DESC);
  `);
}

/**
 * Rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_orderbook_symbol_time;
    DROP TABLE IF EXISTS order_book_snapshots;
  `);
}
