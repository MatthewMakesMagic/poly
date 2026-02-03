/**
 * Migration 007: RTDS Ticks Table
 *
 * Creates the rtds_ticks table for logging real-time price ticks
 * from the RTDS WebSocket feed. Used for offline analysis,
 * strategy validation, and oracle edge infrastructure.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the rtds_ticks table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS rtds_ticks (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      topic TEXT NOT NULL,
      symbol TEXT NOT NULL,
      price DECIMAL(20, 8) NOT NULL,
      raw_payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rtds_ticks_timestamp ON rtds_ticks(timestamp);
    CREATE INDEX IF NOT EXISTS idx_rtds_ticks_symbol_topic ON rtds_ticks(symbol, topic);
  `);
}

/**
 * Rollback the rtds_ticks table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_rtds_ticks_symbol_topic;
    DROP INDEX IF EXISTS idx_rtds_ticks_timestamp;
    DROP TABLE IF EXISTS rtds_ticks;
  `);
}
