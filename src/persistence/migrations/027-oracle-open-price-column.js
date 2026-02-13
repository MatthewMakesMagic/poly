/**
 * Migration 027: Add oracle_price_at_open to window_close_events
 *
 * Stores the Chainlink oracle price at window open time, enabling
 * correct self-resolved direction: CL@close >= CL@open → UP, else DOWN.
 *
 * Previously, determineResolution() compared CL@close vs strike_price
 * (Polymarket reference ≈ exchange spot, ~$47 above CL) — which was wrong.
 * The actual Polymarket resolution formula is CL@close >= CL@open.
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE window_close_events
    ADD COLUMN IF NOT EXISTS oracle_price_at_open DECIMAL(20, 8);
  `);
}

export async function down() {
  await exec(`
    ALTER TABLE window_close_events
    DROP COLUMN IF EXISTS oracle_price_at_open;
  `);
}
