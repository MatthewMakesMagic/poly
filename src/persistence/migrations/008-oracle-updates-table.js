/**
 * Migration 008: Oracle Updates Table
 *
 * Creates the oracle_updates table for tracking Chainlink oracle price updates.
 * Used for learning oracle update patterns, frequency analysis, and
 * deviation threshold discovery.
 */

import { run } from '../database.js';

/**
 * Apply the oracle_updates table schema
 */
export function up() {
  // Create oracle_updates table
  run(`
    CREATE TABLE IF NOT EXISTS oracle_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      previous_price REAL,
      deviation_from_previous_pct REAL,
      time_since_previous_ms INTEGER
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_oracle_updates_symbol ON oracle_updates(symbol)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_updates_timestamp ON oracle_updates(timestamp)');
  // Compound index for common query pattern: WHERE symbol = ? ORDER BY timestamp DESC
  run('CREATE INDEX IF NOT EXISTS idx_oracle_updates_symbol_timestamp ON oracle_updates(symbol, timestamp DESC)');
}

/**
 * Rollback the oracle_updates table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_oracle_updates_symbol_timestamp');
  run('DROP INDEX IF EXISTS idx_oracle_updates_timestamp');
  run('DROP INDEX IF EXISTS idx_oracle_updates_symbol');
  run('DROP TABLE IF EXISTS oracle_updates');
}
