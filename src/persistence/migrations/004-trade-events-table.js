/**
 * Migration 004: Trade Events Table
 *
 * Creates the trade_events table for logging all trade events with expected vs actual values.
 * This table stores comprehensive trade event data including:
 * - Event identification (type, window, position, order, strategy, module)
 * - Timestamps for each stage (signal, submit, ack, fill)
 * - Price data (at signal, submit, fill, expected)
 * - Slippage calculations (signal to fill, vs expected)
 * - Market context (bid, ask, spread, depth)
 * - Size data (requested, filled, ratio to depth)
 * - Log compatibility (level, event, notes)
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the trade_events table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS trade_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      window_id TEXT NOT NULL,
      position_id INTEGER,
      order_id INTEGER,
      strategy_id TEXT,
      module TEXT NOT NULL,
      signal_detected_at TIMESTAMPTZ,
      order_submitted_at TIMESTAMPTZ,
      order_acked_at TIMESTAMPTZ,
      order_filled_at TIMESTAMPTZ,
      latency_decision_to_submit_ms INTEGER,
      latency_submit_to_ack_ms INTEGER,
      latency_ack_to_fill_ms INTEGER,
      latency_total_ms INTEGER,
      price_at_signal DECIMAL(20, 8),
      price_at_submit DECIMAL(20, 8),
      price_at_fill DECIMAL(20, 8),
      expected_price DECIMAL(20, 8),
      slippage_signal_to_fill DECIMAL(10, 6),
      slippage_vs_expected DECIMAL(10, 6),
      bid_at_signal DECIMAL(20, 8),
      ask_at_signal DECIMAL(20, 8),
      spread_at_signal DECIMAL(10, 6),
      depth_at_signal DECIMAL(20, 8),
      requested_size DECIMAL(20, 8),
      filled_size DECIMAL(20, 8),
      size_vs_depth_ratio DECIMAL(10, 6),
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      diagnostic_flags TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_type ON trade_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_window ON trade_events(window_id);
    CREATE INDEX IF NOT EXISTS idx_events_strategy ON trade_events(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_events_level ON trade_events(level);
  `);
}

/**
 * Rollback the trade_events table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_events_level;
    DROP INDEX IF EXISTS idx_events_strategy;
    DROP INDEX IF EXISTS idx_events_window;
    DROP INDEX IF EXISTS idx_events_type;
    DROP TABLE IF EXISTS trade_events;
  `);
}
