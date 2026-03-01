/**
 * Migration 041: Feed Gaps Table
 *
 * Creates the feed_gaps table for tracking data feed interruptions.
 * Used by the feed-monitor module to record when feeds go silent.
 *
 * Each row represents a gap for a specific feed+symbol pair.
 * gap_end and duration_seconds are NULL while the gap is still open.
 */

import persistence from '../index.js';

export async function up() {
  await persistence.run(`
    CREATE TABLE IF NOT EXISTS feed_gaps (
      id SERIAL PRIMARY KEY,
      feed_name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      gap_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      gap_end TIMESTAMPTZ,
      duration_seconds DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Index for querying open gaps (gap_end IS NULL)
  await persistence.run(`
    CREATE INDEX IF NOT EXISTS idx_feed_gaps_open
    ON feed_gaps (feed_name, symbol) WHERE gap_end IS NULL
  `);

  // Index for querying gaps by time range
  await persistence.run(`
    CREATE INDEX IF NOT EXISTS idx_feed_gaps_time
    ON feed_gaps (gap_start DESC)
  `);
}
