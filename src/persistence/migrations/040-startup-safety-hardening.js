/**
 * Migration 040: Startup Safety + Order Execution Hardening
 *
 * 1. instance_locks table - distributed lock for single active trader
 * 2. fee_amount column on orders table - capture fees from fills
 * 3. orders_per_window_instrument index - support hard cap enforcement
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    -- Distributed lock table: only one active_trader instance allowed
    CREATE TABLE IF NOT EXISTS instance_locks (
      lock_name TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'
    );

    -- Add fee_amount column to orders table for fee capture
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(20, 8) DEFAULT 0;

    -- Add 'unknown' to the status CHECK constraint
    -- Drop old constraint and add new one with 'unknown'
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK(status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'rejected', 'unknown'));

    -- Index to support max-orders-per-window-per-instrument hard cap
    CREATE INDEX IF NOT EXISTS idx_orders_window_token
      ON orders(window_id, token_id);
  `);
}

export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_orders_window_token;
    ALTER TABLE orders DROP COLUMN IF EXISTS fee_amount;
    DROP TABLE IF EXISTS instance_locks;
  `);
}
