/**
 * Migration 002: Add Positions Table
 *
 * Creates the positions table for tracking open positions.
 * Includes indexes on status and strategy_id for query optimization.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the positions table migration
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      window_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('long', 'short')),
      size DECIMAL(20, 8) NOT NULL,
      entry_price DECIMAL(20, 8) NOT NULL,
      current_price DECIMAL(20, 8),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'liquidated')),
      strategy_id TEXT NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ,
      close_price DECIMAL(20, 8),
      pnl DECIMAL(20, 8),
      exchange_verified_at TIMESTAMPTZ,
      UNIQUE(window_id, market_id, token_id)
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy_id);
  `);
}

/**
 * Rollback the positions table migration
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_positions_strategy;
    DROP INDEX IF EXISTS idx_positions_status;
    DROP TABLE IF EXISTS positions;
  `);
}
