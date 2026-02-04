/**
 * Migration 020: Auto-Stop State Table
 *
 * Creates the auto_stop_state table for persisting auto-stop state in DB
 * instead of the filesystem.
 *
 * V3 Stage 4: Safety Module File Persistence to DB
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS auto_stop_state (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      auto_stopped BOOLEAN NOT NULL DEFAULT FALSE,
      auto_stopped_at TIMESTAMPTZ,
      auto_stop_reason TEXT,
      date TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO auto_stop_state (id, auto_stopped, date)
    VALUES (1, FALSE, '')
    ON CONFLICT (id) DO NOTHING;
  `);
}

export async function down() {
  await exec(`DROP TABLE IF EXISTS auto_stop_state;`);
}
