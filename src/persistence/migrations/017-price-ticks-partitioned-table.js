/**
 * Migration 017: Partitioned Price Ticks Table + Failed Batches
 *
 * Creates the price_ticks partitioned table for high-frequency price data
 * and the failed_batches table for batch failure recovery.
 *
 * V3 Philosophy Implementation - Phase 5: Data Capture Infrastructure
 */

import { exec } from '../database.js';

/**
 * Apply the partitioned price_ticks and failed_batches schemas
 */
export async function up() {
  // Partitioned price ticks table
  await exec(`
    CREATE TABLE IF NOT EXISTS price_ticks (
      id BIGSERIAL,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      source VARCHAR(30) NOT NULL,
      price DECIMAL(20, 8) NOT NULL,
      token_id VARCHAR(100),
      PRIMARY KEY (timestamp, id)
    ) PARTITION BY RANGE (timestamp);

    CREATE INDEX IF NOT EXISTS idx_price_ticks_symbol_source
      ON price_ticks (symbol, source, timestamp DESC);
  `);

  // Failed batches table for recovery
  await exec(`
    CREATE TABLE IF NOT EXISTS failed_batches (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      batch_data JSONB NOT NULL,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      replayed_at TIMESTAMPTZ
    );
  `);
}

/**
 * Rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_price_ticks_symbol_source;
    DROP TABLE IF EXISTS price_ticks CASCADE;
    DROP TABLE IF EXISTS failed_batches;
  `);
}
