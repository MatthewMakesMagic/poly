/**
 * Migration 002: Orders Table
 *
 * Creates the orders table for tracking order lifecycle.
 * This table stores all orders placed through the system,
 * linking them to trade intents for crash recovery.
 */

import { run } from '../database.js';

/**
 * Apply the orders table schema
 */
export function up() {
  // Create orders table with all required columns
  run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      intent_id INTEGER,
      position_id INTEGER,
      window_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      order_type TEXT NOT NULL CHECK(order_type IN ('limit', 'market', 'GTC', 'FOK', 'IOC')),
      price REAL,
      size REAL NOT NULL,
      filled_size REAL DEFAULT 0,
      avg_fill_price REAL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected')),
      submitted_at TEXT NOT NULL,
      latency_ms INTEGER,
      filled_at TEXT,
      cancelled_at TEXT,
      error_message TEXT,
      FOREIGN KEY (intent_id) REFERENCES trade_intents(id)
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
  run('CREATE INDEX IF NOT EXISTS idx_orders_window ON orders(window_id)');
  run('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
}

/**
 * Rollback the orders table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_orders_order_id');
  run('DROP INDEX IF EXISTS idx_orders_window');
  run('DROP INDEX IF EXISTS idx_orders_status');
  run('DROP TABLE IF EXISTS orders');
}
