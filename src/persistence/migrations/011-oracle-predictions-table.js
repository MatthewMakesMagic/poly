/**
 * Migration 011: Oracle Update Predictions Table
 *
 * Creates the oracle_update_predictions table for tracking oracle update
 * probability predictions and their outcomes for calibration analysis.
 *
 * Used by the oracle-predictor module to:
 * - Log predictions with inputs and bucket assignment
 * - Track actual outcomes when windows expire
 * - Calculate calibration error per bucket
 * - Detect model miscalibration
 */

import { run } from '../database.js';

/**
 * Apply the oracle_update_predictions table schema
 */
export function up() {
  // Create oracle_update_predictions table
  run(`
    CREATE TABLE IF NOT EXISTS oracle_update_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      window_id TEXT,
      time_to_expiry_ms INTEGER NOT NULL,
      time_since_last_update_ms INTEGER NOT NULL,
      current_deviation_pct REAL NOT NULL,
      predicted_p_update REAL NOT NULL,
      confidence_low REAL,
      confidence_high REAL,
      bucket TEXT NOT NULL,
      inputs_json TEXT,
      actual_outcome INTEGER,
      settled_at TEXT
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_oracle_pred_timestamp ON oracle_update_predictions(timestamp)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_pred_symbol ON oracle_update_predictions(symbol)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_pred_window ON oracle_update_predictions(window_id)');
  run('CREATE INDEX IF NOT EXISTS idx_oracle_pred_bucket ON oracle_update_predictions(bucket)');
  // Compound index for calibration queries: GROUP BY bucket WHERE actual_outcome IS NOT NULL
  run('CREATE INDEX IF NOT EXISTS idx_oracle_pred_bucket_outcome ON oracle_update_predictions(bucket, actual_outcome)');
  // Compound index for symbol + timestamp queries
  run('CREATE INDEX IF NOT EXISTS idx_oracle_pred_symbol_timestamp ON oracle_update_predictions(symbol, timestamp DESC)');
}

/**
 * Rollback the oracle_update_predictions table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_oracle_pred_symbol_timestamp');
  run('DROP INDEX IF EXISTS idx_oracle_pred_bucket_outcome');
  run('DROP INDEX IF EXISTS idx_oracle_pred_bucket');
  run('DROP INDEX IF EXISTS idx_oracle_pred_window');
  run('DROP INDEX IF EXISTS idx_oracle_pred_symbol');
  run('DROP INDEX IF EXISTS idx_oracle_pred_timestamp');
  run('DROP TABLE IF EXISTS oracle_update_predictions');
}
