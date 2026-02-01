/**
 * Migration 010: Lag Signals Table
 *
 * Creates the lag_signals table for tracking lag-based trading signals
 * and their outcomes. Used for validating whether lag between price feeds
 * predicts profitable trades.
 */

import { run } from '../database.js';

/**
 * Apply the lag_signals table schema
 */
export function up() {
  // Create lag_signals table
  run(`
    CREATE TABLE IF NOT EXISTS lag_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      spot_price_at_signal REAL,
      spot_move_direction TEXT,
      spot_move_magnitude REAL,
      oracle_price_at_signal REAL,
      predicted_direction TEXT,
      predicted_tau_ms INTEGER,
      correlation_at_tau REAL,
      window_id TEXT,
      outcome_direction TEXT,
      prediction_correct INTEGER,
      pnl REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_lag_signals_timestamp ON lag_signals(timestamp)');
  run('CREATE INDEX IF NOT EXISTS idx_lag_signals_symbol ON lag_signals(symbol)');
  run('CREATE INDEX IF NOT EXISTS idx_lag_signals_window ON lag_signals(window_id)');
  // Compound index for common query pattern: WHERE symbol = ? ORDER BY timestamp DESC
  run('CREATE INDEX IF NOT EXISTS idx_lag_signals_symbol_timestamp ON lag_signals(symbol, timestamp DESC)');
}

/**
 * Rollback the lag_signals table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_lag_signals_symbol_timestamp');
  run('DROP INDEX IF EXISTS idx_lag_signals_window');
  run('DROP INDEX IF EXISTS idx_lag_signals_symbol');
  run('DROP INDEX IF EXISTS idx_lag_signals_timestamp');
  run('DROP TABLE IF EXISTS lag_signals');
}
