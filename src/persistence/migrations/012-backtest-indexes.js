/**
 * Migration 012: Backtest Indexes
 *
 * Adds optimized indexes for date-range queries used by the backtesting engine.
 * These indexes support efficient retrieval of historical data for replay.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the backtest indexes
 */
export async function up() {
  await exec(`
    -- Compound index for efficient date-range + symbol queries on rtds_ticks
    -- This is the primary query pattern for backtesting: WHERE timestamp BETWEEN ? AND ? AND symbol = ?
    CREATE INDEX IF NOT EXISTS idx_rtds_ticks_symbol_timestamp ON rtds_ticks(symbol, timestamp);

    -- Compound index for trade_events date-range queries
    CREATE INDEX IF NOT EXISTS idx_trade_events_created_at ON trade_events(created_at);

    -- Compound index for probability predictions date-range queries
    CREATE INDEX IF NOT EXISTS idx_probability_predictions_timestamp ON probability_predictions(timestamp);
  `);
}

/**
 * Rollback the backtest indexes
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_probability_predictions_timestamp;
    DROP INDEX IF EXISTS idx_trade_events_created_at;
    DROP INDEX IF EXISTS idx_rtds_ticks_symbol_timestamp;
  `);
}
