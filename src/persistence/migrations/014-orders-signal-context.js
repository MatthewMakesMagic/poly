/**
 * Migration 014: Add Signal Context to Orders Table
 *
 * Adds columns to track the original signal context when an order is placed.
 * This enables stale order detection - if edge drops below threshold,
 * the order should be cancelled to prevent bad fills.
 *
 * Columns added:
 * - original_edge: Edge (model_probability - market_price) at order placement
 * - original_model_probability: Model p_up at order placement
 * - symbol: Crypto symbol (btc, eth, sol, xrp) for recalculation
 * - strategy_id: Strategy that generated the signal
 * - side_token: UP or DOWN - which token side this order is for
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the signal context columns
 */
export async function up() {
  await exec(`
    -- Add original_edge column
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_edge DECIMAL(10, 6);

    -- Add original_model_probability column
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_model_probability DECIMAL(10, 6);

    -- Add symbol column (crypto symbol for recalculation)
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS symbol TEXT;

    -- Add strategy_id column (may already exist from previous migration)
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS strategy_id TEXT;

    -- Add side_token column (UP or DOWN)
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS side_token TEXT CHECK(side_token IN ('UP', 'DOWN'));

    -- Add index for efficient stale order queries (open orders with edge data)
    -- PostgreSQL supports partial indexes natively
    CREATE INDEX IF NOT EXISTS idx_orders_stale_check
    ON orders(status, original_edge)
    WHERE status IN ('open', 'partially_filled') AND original_edge IS NOT NULL;
  `);
}

/**
 * Rollback the signal context columns
 * PostgreSQL supports DROP COLUMN, so we can do a clean rollback
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_orders_stale_check;

    -- PostgreSQL allows dropping columns directly
    ALTER TABLE orders DROP COLUMN IF EXISTS side_token;
    ALTER TABLE orders DROP COLUMN IF EXISTS strategy_id;
    ALTER TABLE orders DROP COLUMN IF EXISTS symbol;
    ALTER TABLE orders DROP COLUMN IF EXISTS original_model_probability;
    ALTER TABLE orders DROP COLUMN IF EXISTS original_edge;
  `);
}
