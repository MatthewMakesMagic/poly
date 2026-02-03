/**
 * Migration 013: Oracle Edge Signals Table
 *
 * Creates the oracle_edge_signals table for tracking signal outcomes
 * against actual settlement to measure oracle edge hypothesis effectiveness.
 *
 * Story 7-8: Signal Outcome Logger
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the oracle edge signals table migration
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS oracle_edge_signals (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      window_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      time_to_expiry_ms INTEGER,
      ui_price DECIMAL(20, 8),
      oracle_price DECIMAL(20, 8),
      oracle_staleness_ms INTEGER,
      strike DECIMAL(20, 8),
      market_token_price DECIMAL(10, 4),
      signal_direction TEXT,
      confidence DECIMAL(10, 6),
      token_id TEXT,
      side TEXT,
      final_oracle_price DECIMAL(20, 8),
      settlement_outcome TEXT,
      signal_correct INTEGER,
      entry_price DECIMAL(10, 4),
      exit_price DECIMAL(10, 4),
      pnl DECIMAL(20, 8),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_window ON oracle_edge_signals(window_id);
    CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_symbol ON oracle_edge_signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_timestamp ON oracle_edge_signals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_oracle_edge_signals_outcome ON oracle_edge_signals(settlement_outcome);
  `);
}

/**
 * Rollback the oracle edge signals table migration
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_oracle_edge_signals_outcome;
    DROP INDEX IF EXISTS idx_oracle_edge_signals_timestamp;
    DROP INDEX IF EXISTS idx_oracle_edge_signals_symbol;
    DROP INDEX IF EXISTS idx_oracle_edge_signals_window;
    DROP TABLE IF EXISTS oracle_edge_signals;
  `);
}
