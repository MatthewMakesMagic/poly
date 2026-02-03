/**
 * Migration 006: Orders Table
 *
 * Creates the orders table for tracking order lifecycle.
 * This table stores all orders placed through the system,
 * linking them to trade intents for crash recovery.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the orders table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id TEXT UNIQUE NOT NULL,
      intent_id INTEGER,
      position_id INTEGER,
      window_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      order_type TEXT NOT NULL CHECK(order_type IN ('limit', 'market', 'GTC', 'FOK', 'IOC')),
      price DECIMAL(20, 8),
      size DECIMAL(20, 8) NOT NULL,
      filled_size DECIMAL(20, 8) DEFAULT 0,
      avg_fill_price DECIMAL(20, 8),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected')),
      submitted_at TIMESTAMPTZ NOT NULL,
      latency_ms INTEGER,
      filled_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      error_message TEXT,
      FOREIGN KEY (intent_id) REFERENCES trade_intents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_window ON orders(window_id);
    CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
  `);
}

/**
 * Rollback the orders table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_orders_order_id;
    DROP INDEX IF EXISTS idx_orders_window;
    DROP INDEX IF EXISTS idx_orders_status;
    DROP TABLE IF EXISTS orders;
  `);
}
