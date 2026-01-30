/**
 * Migration 002: Add Positions Table
 *
 * Creates the positions table for tracking open positions.
 * Includes indexes on status and strategy_id for query optimization.
 */

import { exec } from '../database.js';

/**
 * Apply the positions table migration
 */
export function up() {
  exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('long', 'short')),
      size REAL NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'liquidated')),
      strategy_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_price REAL,
      pnl REAL,
      exchange_verified_at TEXT,
      UNIQUE(window_id, market_id, token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy_id);
  `);
}

/**
 * Rollback the positions table migration
 */
export function down() {
  exec(`
    DROP INDEX IF EXISTS idx_positions_strategy;
    DROP INDEX IF EXISTS idx_positions_status;
    DROP TABLE IF EXISTS positions;
  `);
}
