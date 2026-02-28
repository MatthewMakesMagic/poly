/**
 * Migration 039: Allow multi-strategy positions per window
 *
 * Changes UNIQUE constraint from (window_id, market_id, token_id)
 * to (window_id, market_id, token_id, strategy_id) so two different
 * strategies can independently hold positions on the same window/token.
 */

import { exec } from '../database.js';

export async function up() {
  // PostgreSQL: drop the old constraint by name, add new one
  // The constraint name from CREATE TABLE UNIQUE(...) is auto-generated
  // as "positions_window_id_market_id_token_id_key"
  await exec(`
    ALTER TABLE positions
      DROP CONSTRAINT IF EXISTS positions_window_id_market_id_token_id_key;

    ALTER TABLE positions
      ADD CONSTRAINT positions_window_market_token_strategy_key
      UNIQUE(window_id, market_id, token_id, strategy_id);
  `);
}

export async function down() {
  await exec(`
    ALTER TABLE positions
      DROP CONSTRAINT IF EXISTS positions_window_market_token_strategy_key;

    ALTER TABLE positions
      ADD CONSTRAINT positions_window_id_market_id_token_id_key
      UNIQUE(window_id, market_id, token_id);
  `);
}
