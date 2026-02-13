/**
 * Migration 028: Add onchain_resolved_direction to window_close_events
 *
 * Stores the ground-truth resolution direction read directly from the
 * Polymarket CTF (Conditional Token Framework) contract on Polygon.
 *
 * After each window closes, the recorder reads payoutNumerators from
 * the CTF contract to determine the actual on-chain resolution. This
 * is stored alongside the perceived (RTDS-based) resolution so we can
 * measure timing drift and ensure 100% accuracy.
 *
 * Also stores the conditionId used for the on-chain lookup.
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE window_close_events
    ADD COLUMN IF NOT EXISTS onchain_resolved_direction VARCHAR(10),
    ADD COLUMN IF NOT EXISTS condition_id VARCHAR(66);
  `);
}

export async function down() {
  await exec(`
    ALTER TABLE window_close_events
    DROP COLUMN IF EXISTS onchain_resolved_direction,
    DROP COLUMN IF EXISTS condition_id;
  `);
}
