/**
 * Migration 016: Window Close Events Table
 *
 * Creates the window_close_events table for tracking Polymarket window closes.
 * This is critical for Edge 2: Resolution prediction - capturing all price feeds
 * at intervals before window close to analyze oracle resolution patterns.
 *
 * Key data captured:
 * - Oracle prices at 60s, 30s, 10s, 5s, 1s before close
 * - All feed prices (Binance, Chainlink, Pyth, Polymarket) at close
 * - Market prices (UP/DOWN tokens) at same intervals
 * - Resolution outcome and "surprise" detection
 *
 * V3 Philosophy Implementation - Stage 3: Data Capture Running
 */

import { exec } from '../database.js';

/**
 * Apply the window_close_events table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS window_close_events (
      id BIGSERIAL PRIMARY KEY,
      window_id VARCHAR(100) NOT NULL UNIQUE,
      symbol VARCHAR(10) NOT NULL,

      -- Timing
      window_close_time TIMESTAMPTZ NOT NULL,
      oracle_resolution_time TIMESTAMPTZ,

      -- Oracle prices at intervals before close
      oracle_price_60s_before DECIMAL(20, 8),
      oracle_price_30s_before DECIMAL(20, 8),
      oracle_price_10s_before DECIMAL(20, 8),
      oracle_price_5s_before DECIMAL(20, 8),
      oracle_price_1s_before DECIMAL(20, 8),
      oracle_price_at_close DECIMAL(20, 8),

      -- All feed prices at close
      binance_price_at_close DECIMAL(20, 8),
      pyth_price_at_close DECIMAL(20, 8),
      chainlink_price_at_close DECIMAL(20, 8),
      polymarket_binance_at_close DECIMAL(20, 8),

      -- Market prices at intervals (UP token)
      market_up_price_60s DECIMAL(10, 4),
      market_up_price_30s DECIMAL(10, 4),
      market_up_price_10s DECIMAL(10, 4),
      market_up_price_5s DECIMAL(10, 4),
      market_up_price_1s DECIMAL(10, 4),

      -- Market prices at intervals (DOWN token)
      market_down_price_60s DECIMAL(10, 4),
      market_down_price_30s DECIMAL(10, 4),
      market_down_price_10s DECIMAL(10, 4),
      market_down_price_5s DECIMAL(10, 4),
      market_down_price_1s DECIMAL(10, 4),

      -- Resolution
      strike_price DECIMAL(20, 8) NOT NULL,
      resolved_direction VARCHAR(10),

      -- Market consensus analysis
      market_consensus_direction VARCHAR(10),
      market_consensus_confidence DECIMAL(6, 4),
      surprise_resolution BOOLEAN,

      -- Metadata
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Index for querying by symbol and time
    CREATE INDEX IF NOT EXISTS idx_window_close_symbol ON window_close_events (symbol, window_close_time DESC);

    -- Partial index for finding surprise resolutions
    CREATE INDEX IF NOT EXISTS idx_window_close_surprise ON window_close_events (surprise_resolution) WHERE surprise_resolution = TRUE;
  `);
}

/**
 * Rollback the window_close_events table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_window_close_surprise;
    DROP INDEX IF EXISTS idx_window_close_symbol;
    DROP TABLE IF EXISTS window_close_events;
  `);
}
