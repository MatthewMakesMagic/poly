/**
 * Migration 046: PG Timeline Cache Table
 *
 * Server-side cache for pre-computed timelines, mirroring the local SQLite
 * timeline cache. Stores MessagePack-serialized timeline blobs as BYTEA.
 * Enables <500ms backtests on Railway by avoiding 3+ raw tick table queries per window.
 *
 * Includes schema_version column (adversarial review requirement) to handle
 * future timeline format changes without serving stale cached data.
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS pg_timelines (
      window_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      window_close_time TIMESTAMPTZ NOT NULL,
      window_open_time TIMESTAMPTZ NOT NULL,
      ground_truth TEXT,
      strike_price REAL,
      oracle_price_at_open REAL,
      chainlink_price_at_close REAL,
      timeline BYTEA NOT NULL,
      event_count INTEGER NOT NULL,
      data_quality JSONB,
      schema_version INTEGER NOT NULL DEFAULT 1,
      built_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pg_timelines_symbol ON pg_timelines(symbol);
    CREATE INDEX IF NOT EXISTS idx_pg_timelines_close ON pg_timelines(window_close_time);
    CREATE INDEX IF NOT EXISTS idx_pg_timelines_symbol_close ON pg_timelines(symbol, window_close_time);
  `);
}

export async function down() {
  await exec(`
    DROP TABLE IF EXISTS pg_timelines;
  `);
}
