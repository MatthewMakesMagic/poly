/**
 * Migration 026: Create vwap_snapshots table
 *
 * Lightweight table for periodic VWAP snapshots computed from
 * real-time WebSocket trade streams across 21 exchanges.
 *
 * ~1 row/sec × 4 symbols = ~345K rows/day = ~50 MB/day.
 */

import { exec } from '../database.js';

export const id = '026-vwap-snapshots-table';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS vwap_snapshots (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      composite_vwap DECIMAL(20, 8) NOT NULL,
      composite_volume DECIMAL(30, 8) NOT NULL,
      exchange_count INT NOT NULL,
      chainlink_price DECIMAL(20, 8),
      vwap_cl_spread DECIMAL(20, 8),
      window_ms INT NOT NULL,
      exchange_detail JSONB
    );

    CREATE INDEX IF NOT EXISTS idx_vwap_snap_symbol_time
      ON vwap_snapshots (symbol, timestamp DESC);
  `);
}

export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_vwap_snap_symbol_time;
    DROP TABLE IF EXISTS vwap_snapshots;
  `);
}
