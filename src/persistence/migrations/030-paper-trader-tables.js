/**
 * Migration 030: Paper Trader V2 Tables
 *
 * Creates tables for the VWAP edge paper trading system:
 * - l2_book_snapshots: Streaming L2 order book snapshots
 * - paper_trades_v2: Realistic paper trade ledger with fill simulation
 * - latency_measurements: API round-trip latency log
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS l2_book_snapshots (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      token_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      best_bid DECIMAL(10, 6),
      best_ask DECIMAL(10, 6),
      mid_price DECIMAL(10, 6),
      spread DECIMAL(10, 6),
      bid_depth_1pct DECIMAL(16, 2),
      ask_depth_1pct DECIMAL(16, 2),
      full_book_json JSONB
    )
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_l2_book_snapshots_token_ts
    ON l2_book_snapshots (token_id, timestamp)
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_l2_book_snapshots_type_ts
    ON l2_book_snapshots (snapshot_type, timestamp)
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS paper_trades_v2 (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      window_id TEXT,
      symbol TEXT NOT NULL,
      signal_time TIMESTAMPTZ NOT NULL,
      signal_type TEXT NOT NULL DEFAULT 'vwap_edge',
      vwap_direction TEXT,
      clob_direction TEXT,
      vwap_delta DECIMAL(16, 2),
      vwap_price DECIMAL(20, 8),
      chainlink_price DECIMAL(20, 8),
      clob_up_price DECIMAL(10, 6),
      exchange_count INTEGER,
      total_volume DECIMAL(20, 8),
      entry_side TEXT,
      entry_token_id TEXT,
      entry_book_snapshot_id INTEGER REFERENCES l2_book_snapshots(id),
      sim_entry_price DECIMAL(10, 6),
      sim_shares DECIMAL(16, 6),
      sim_cost DECIMAL(16, 6),
      sim_slippage DECIMAL(10, 6),
      sim_levels_consumed INTEGER,
      sim_market_impact DECIMAL(10, 6),
      sim_fee DECIMAL(16, 6),
      latency_ms DECIMAL(10, 2),
      adjusted_entry_price DECIMAL(10, 6),
      settlement_time TIMESTAMPTZ,
      resolved_direction TEXT,
      won BOOLEAN,
      gross_pnl DECIMAL(16, 6),
      net_pnl DECIMAL(16, 6)
    )
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_paper_trades_v2_window_id
    ON paper_trades_v2 (window_id)
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_paper_trades_v2_symbol_signal
    ON paper_trades_v2 (symbol, signal_time)
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS latency_measurements (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      measurement_type TEXT NOT NULL,
      round_trip_ms DECIMAL(10, 2) NOT NULL,
      token_id TEXT,
      details JSONB
    )
  `);

  await exec(`
    CREATE INDEX IF NOT EXISTS idx_latency_measurements_ts
    ON latency_measurements (timestamp)
  `);
}

export async function down() {
  await exec('DROP TABLE IF EXISTS paper_trades_v2');
  await exec('DROP TABLE IF EXISTS l2_book_snapshots');
  await exec('DROP TABLE IF EXISTS latency_measurements');
}
