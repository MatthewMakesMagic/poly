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
 */

import { run } from '../database.js';

/**
 * Apply the trade_events table schema
 */
export function up() {
  // Create trade_events table with all required columns per architecture spec
  run(`
    CREATE TABLE IF NOT EXISTS trade_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      window_id TEXT NOT NULL,
      position_id INTEGER,
      order_id INTEGER,
      strategy_id TEXT,
      module TEXT NOT NULL,
      signal_detected_at TEXT,
      order_submitted_at TEXT,
      order_acked_at TEXT,
      order_filled_at TEXT,
      latency_decision_to_submit_ms INTEGER,
      latency_submit_to_ack_ms INTEGER,
      latency_ack_to_fill_ms INTEGER,
      latency_total_ms INTEGER,
      price_at_signal REAL,
      price_at_submit REAL,
      price_at_fill REAL,
      expected_price REAL,
      slippage_signal_to_fill REAL,
      slippage_vs_expected REAL,
      bid_at_signal REAL,
      ask_at_signal REAL,
      spread_at_signal REAL,
      depth_at_signal REAL,
      requested_size REAL,
      filled_size REAL,
      size_vs_depth_ratio REAL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      diagnostic_flags TEXT,
      notes TEXT,
      FOREIGN KEY (position_id) REFERENCES positions(id)
    )
  `);

  // Create indexes for query performance
  run('CREATE INDEX IF NOT EXISTS idx_events_type ON trade_events(event_type)');
  run('CREATE INDEX IF NOT EXISTS idx_events_window ON trade_events(window_id)');
  run('CREATE INDEX IF NOT EXISTS idx_events_strategy ON trade_events(strategy_id)');
  run('CREATE INDEX IF NOT EXISTS idx_events_level ON trade_events(level)');
}

/**
 * Rollback the trade_events table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_events_level');
  run('DROP INDEX IF EXISTS idx_events_strategy');
  run('DROP INDEX IF EXISTS idx_events_window');
  run('DROP INDEX IF EXISTS idx_events_type');
  run('DROP TABLE IF EXISTS trade_events');
}
