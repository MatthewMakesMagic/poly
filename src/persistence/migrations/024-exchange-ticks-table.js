/**
 * Migration 024: Exchange Ticks Table
 *
 * Creates the exchange_ticks table for multi-exchange price capture
 * via CCXT (Binance, Coinbase, Kraken, Bybit, OKX).
 *
 * FINDTHEGOLD Data Capture Infrastructure - Phase 1 (Task 1.3)
 */

import { exec } from '../database.js';

/**
 * Apply the exchange_ticks table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS exchange_ticks (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      exchange VARCHAR(20) NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      price DECIMAL(20, 8) NOT NULL,
      bid DECIMAL(20, 8),
      ask DECIMAL(20, 8),
      volume_24h DECIMAL(30, 8)
    );

    CREATE INDEX IF NOT EXISTS idx_ext_exchange_symbol_time
      ON exchange_ticks (exchange, symbol, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_ext_symbol_time
      ON exchange_ticks (symbol, timestamp DESC);
  `);
}

/**
 * Rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_ext_symbol_time;
    DROP INDEX IF EXISTS idx_ext_exchange_symbol_time;
    DROP TABLE IF EXISTS exchange_ticks;
  `);
}
