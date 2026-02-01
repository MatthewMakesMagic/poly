/**
 * Migration 013: Oracle Edge Signals Table
 *
 * Creates the oracle_edge_signals table for tracking signal outcomes
 * against actual settlement to measure oracle edge hypothesis effectiveness.
 *
 * Story 7-8: Signal Outcome Logger
 */

import { run } from '../database.js';

/**
 * Apply the oracle edge signals table migration
 */
export function up() {
  // Create the oracle_edge_signals table
  run(`
    CREATE TABLE IF NOT EXISTS oracle_edge_signals (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      window_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      time_to_expiry_ms INTEGER,
      ui_price REAL,
      oracle_price REAL,
      oracle_staleness_ms INTEGER,
      strike REAL,
      market_token_price REAL,
      signal_direction TEXT,
      confidence REAL,
      token_id TEXT,
      side TEXT,
      final_oracle_price REAL,
      settlement_outcome TEXT,
      signal_correct INTEGER,
      entry_price REAL,
      exit_price REAL,
      pnl REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_window ON oracle_edge_signals(window_id)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_symbol ON oracle_edge_signals(symbol)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_timestamp ON oracle_edge_signals(timestamp)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_outcome ON oracle_edge_signals(settlement_outcome)');
}

/**
 * Rollback the oracle edge signals table migration
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_oracle_edge_signals_outcome');
  run('DROP INDEX IF EXISTS idx_oracle_edge_signals_timestamp');
  run('DROP INDEX IF EXISTS idx_oracle_edge_signals_symbol');
  run('DROP INDEX IF EXISTS idx_oracle_edge_signals_window');
  run('DROP TABLE IF EXISTS oracle_edge_signals');
}
