/**
 * Migration 038: Add order_id column to positions table
 *
 * Links positions back to the order that created them for audit trail.
 */
import { exec } from '../database.js';

export async function up() {
  await exec(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS order_id TEXT`);
}

export async function down() {
  await exec('ALTER TABLE positions DROP COLUMN IF EXISTS order_id');
}
