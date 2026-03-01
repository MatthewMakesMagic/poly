/**
 * Migration 042: DRY_RUN mode columns
 *
 * Phase 0.6 + 0.7: Add mode column to orders and positions tables,
 * and order_book_snapshot JSONB to orders for dry-run fill context.
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'LIVE';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_book_snapshot JSONB;

    ALTER TABLE positions ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'LIVE';
  `);
}

export async function down() {
  await exec(`
    ALTER TABLE orders DROP COLUMN IF EXISTS mode;
    ALTER TABLE orders DROP COLUMN IF EXISTS order_book_snapshot;
    ALTER TABLE positions DROP COLUMN IF EXISTS mode;
  `);
}
