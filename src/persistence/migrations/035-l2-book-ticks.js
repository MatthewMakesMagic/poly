/**
 * Migration 035: Create l2_book_ticks table for continuous tick recording
 *
 * Records every L2 book update from the CLOB WebSocket during active windows.
 * ~350 bytes/tick × ~2.6M ticks/day ≈ 910MB/day.
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE l2_book_ticks (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      token_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      window_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      best_bid REAL,
      best_ask REAL,
      mid_price REAL,
      spread REAL,
      bid_depth_1pct REAL,
      ask_depth_1pct REAL,
      top_levels JSONB
    );

    CREATE INDEX idx_l2_ticks_window_token ON l2_book_ticks (window_id, token_id, timestamp);
    CREATE INDEX idx_l2_ticks_symbol_time ON l2_book_ticks (symbol, timestamp DESC);
  `);
}

export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_l2_ticks_symbol_time;
    DROP INDEX IF EXISTS idx_l2_ticks_window_token;
    DROP TABLE IF EXISTS l2_book_ticks;
  `);
}
