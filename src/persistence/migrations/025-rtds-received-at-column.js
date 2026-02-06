/**
 * Migration 025: Add received_at column to rtds_ticks
 *
 * Captures the local receipt timestamp (ms precision) when a WebSocket
 * message arrives, independent of the source timestamp which is
 * truncated to whole seconds by Polymarket's RTDS feed.
 *
 * This enables sub-second lag measurement between Binance and Chainlink
 * price feeds — critical for FINDTHEGOLD oracle lag analysis.
 */

import { exec } from '../database.js';

export const id = '025-rtds-received-at-column';

export async function up() {
  await exec(`
    ALTER TABLE rtds_ticks
    ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ
  `);
}

export async function down() {
  await exec(`
    ALTER TABLE rtds_ticks
    DROP COLUMN IF EXISTS received_at
  `);
}
