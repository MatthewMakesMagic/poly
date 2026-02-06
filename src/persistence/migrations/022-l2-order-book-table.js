/**
 * Migration 022: L2 Order Book Levels Table
 *
 * Creates the order_book_levels table for per-level bid/ask data capture.
 * Supports market making analysis: queue position, depth collapse detection.
 *
 * FINDTHEGOLD Data Capture Infrastructure - Phase 1 (Task 1.1)
 */

import { exec } from '../database.js';

/**
 * Apply the order_book_levels table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS order_book_levels (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      token_id VARCHAR(100) NOT NULL,
      symbol VARCHAR(20) NOT NULL,
      side VARCHAR(4) NOT NULL,
      price DECIMAL(10, 6) NOT NULL,
      size DECIMAL(20, 8) NOT NULL,
      level_index SMALLINT NOT NULL,
      snapshot_id BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_obl_token_time
      ON order_book_levels (token_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_obl_snapshot
      ON order_book_levels (snapshot_id);
  `);
}

/**
 * Rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_obl_snapshot;
    DROP INDEX IF EXISTS idx_obl_token_time;
    DROP TABLE IF EXISTS order_book_levels;
  `);
}
