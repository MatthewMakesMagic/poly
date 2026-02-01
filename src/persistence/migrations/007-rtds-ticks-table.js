/**
 * Migration 007: RTDS Ticks Table
 *
 * Creates the rtds_ticks table for logging real-time price ticks
 * from the RTDS WebSocket feed. Used for offline analysis,
 * strategy validation, and oracle edge infrastructure.
 */

import { run } from '../database.js';

/**
 * Apply the rtds_ticks table schema
 */
export function up() {
  // Create rtds_ticks table
  run(`
    CREATE TABLE IF NOT EXISTS rtds_ticks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      topic TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price REAL NOT NULL,
      raw_payload TEXT
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_rtds_ticks_timestamp ON rtds_ticks(timestamp)');
  run('CREATE INDEX IF NOT EXISTS idx_rtds_ticks_symbol_topic ON rtds_ticks(symbol, topic)');
}

/**
 * Rollback the rtds_ticks table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_rtds_ticks_symbol_topic');
  run('DROP INDEX IF EXISTS idx_rtds_ticks_timestamp');
  run('DROP TABLE IF EXISTS rtds_ticks');
}
