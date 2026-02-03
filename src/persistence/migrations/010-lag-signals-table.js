/**
 * Migration 010: Lag Signals Table
 *
 * Creates the lag_signals table for tracking lag-based trading signals
 * and their outcomes. Used for validating whether lag between price feeds
 * predicts profitable trades.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the lag_signals table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS lag_signals (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol TEXT NOT NULL,
      spot_price_at_signal DECIMAL(20, 8),
      spot_move_direction TEXT,
      spot_move_magnitude DECIMAL(20, 8),
      oracle_price_at_signal DECIMAL(20, 8),
      predicted_direction TEXT,
      predicted_tau_ms INTEGER,
      correlation_at_tau DECIMAL(10, 6),
      window_id TEXT,
      outcome_direction TEXT,
      prediction_correct INTEGER,
      pnl DECIMAL(20, 8),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lag_signals_timestamp ON lag_signals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_lag_signals_symbol ON lag_signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_lag_signals_window ON lag_signals(window_id);
    CREATE INDEX IF NOT EXISTS idx_lag_signals_symbol_timestamp ON lag_signals(symbol, timestamp DESC);
  `);
}

/**
 * Rollback the lag_signals table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_lag_signals_symbol_timestamp;
    DROP INDEX IF EXISTS idx_lag_signals_window;
    DROP INDEX IF EXISTS idx_lag_signals_symbol;
    DROP INDEX IF EXISTS idx_lag_signals_timestamp;
    DROP TABLE IF EXISTS lag_signals;
  `);
}
