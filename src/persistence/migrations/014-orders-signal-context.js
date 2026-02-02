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
 */

import { run } from '../database.js';

/**
 * Apply the signal context columns
 */
export function up() {
  // Add original_edge column
  run(`ALTER TABLE orders ADD COLUMN original_edge REAL`);

  // Add original_model_probability column
  run(`ALTER TABLE orders ADD COLUMN original_model_probability REAL`);

  // Add symbol column (crypto symbol for recalculation)
  run(`ALTER TABLE orders ADD COLUMN symbol TEXT`);

  // Add strategy_id column
  run(`ALTER TABLE orders ADD COLUMN strategy_id TEXT`);

  // Add side_token column (UP or DOWN)
  run(`ALTER TABLE orders ADD COLUMN side_token TEXT CHECK(side_token IN ('UP', 'DOWN'))`);

  // Add index for efficient stale order queries (open orders with edge data)
  run(`CREATE INDEX IF NOT EXISTS idx_orders_stale_check
       ON orders(status, original_edge)
       WHERE status IN ('open', 'partially_filled') AND original_edge IS NOT NULL`);
}

/**
 * Rollback the signal context columns
 */
export function down() {
  // SQLite doesn't support DROP COLUMN directly in older versions
  // For safety, we'll just drop the index
  run('DROP INDEX IF EXISTS idx_orders_stale_check');

  // Note: To fully rollback columns would require table recreation
  // which is destructive. In practice, unused columns are harmless.
}
