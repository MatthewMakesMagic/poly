/**
 * Migration 005: Strategy Instances Table
 *
 * Creates the strategy_instances table for the strategy composition registry.
 * This table stores registered strategies with their component version references.
 *
 * Epic 6 - Story 6.1: Strategy Component Registry
 * Covers FR31 (version components independently) and FR32 (track component versions)
 *
 * Schema based on architecture.md specification.
 */

import { run } from '../database.js';

/**
 * Apply the strategy_instances table schema
 */
export function up() {
  // Create strategy_instances table per architecture.md
  run(`
    CREATE TABLE IF NOT EXISTS strategy_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_strategy_id TEXT,
      probability_component TEXT NOT NULL,
      entry_component TEXT NOT NULL,
      exit_component TEXT NOT NULL,
      sizing_component TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at TEXT NOT NULL,
      active INTEGER DEFAULT 1
    )
  `);

  // Create index on active column for efficient filtering
  run('CREATE INDEX IF NOT EXISTS idx_strategy_active ON strategy_instances(active)');

  // Create index on base_strategy_id for fork queries
  run('CREATE INDEX IF NOT EXISTS idx_strategy_base ON strategy_instances(base_strategy_id)');

  // Create index on created_at for chronological queries
  run('CREATE INDEX IF NOT EXISTS idx_strategy_created ON strategy_instances(created_at)');
}

/**
 * Rollback the strategy_instances table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_strategy_created');
  run('DROP INDEX IF EXISTS idx_strategy_base');
  run('DROP INDEX IF EXISTS idx_strategy_active');
  run('DROP TABLE IF EXISTS strategy_instances');
}
