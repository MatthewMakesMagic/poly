/**
 * Migration 005: Strategy Instances Table
 *
 * Creates the strategy_instances table for the strategy composition registry.
 * This table stores registered strategies with their component version references.
 *
 * Epic 6 - Story 6.1: Strategy Component Registry
 * Covers FR31 (version components independently) and FR32 (track component versions)
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the strategy_instances table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS strategy_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_strategy_id TEXT,
      probability_component TEXT NOT NULL,
      entry_component TEXT NOT NULL,
      exit_component TEXT NOT NULL,
      sizing_component TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_strategy_active ON strategy_instances(active);
    CREATE INDEX IF NOT EXISTS idx_strategy_base ON strategy_instances(base_strategy_id);
    CREATE INDEX IF NOT EXISTS idx_strategy_created ON strategy_instances(created_at);
  `);
}

/**
 * Rollback the strategy_instances table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_strategy_created;
    DROP INDEX IF EXISTS idx_strategy_base;
    DROP INDEX IF EXISTS idx_strategy_active;
    DROP TABLE IF EXISTS strategy_instances;
  `);
}
