/**
 * Migration 008: Oracle Updates Table
 *
 * Creates the oracle_updates table for tracking Chainlink oracle price updates.
 * Used for learning oracle update patterns, frequency analysis, and
 * deviation threshold discovery.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the oracle_updates table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS oracle_updates (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol TEXT NOT NULL,
      price DECIMAL(20, 8) NOT NULL,
      previous_price DECIMAL(20, 8),
      deviation_from_previous_pct DECIMAL(10, 6),
      time_since_previous_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_oracle_updates_symbol ON oracle_updates(symbol);
    CREATE INDEX IF NOT EXISTS idx_oracle_updates_timestamp ON oracle_updates(timestamp);
    CREATE INDEX IF NOT EXISTS idx_oracle_updates_symbol_timestamp ON oracle_updates(symbol, timestamp DESC);
  `);
}

/**
 * Rollback the oracle_updates table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_oracle_updates_symbol_timestamp;
    DROP INDEX IF EXISTS idx_oracle_updates_timestamp;
    DROP INDEX IF EXISTS idx_oracle_updates_symbol;
    DROP TABLE IF EXISTS oracle_updates;
  `);
}
