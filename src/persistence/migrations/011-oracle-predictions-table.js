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
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the oracle_update_predictions table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS oracle_update_predictions (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol TEXT NOT NULL,
      window_id TEXT,
      time_to_expiry_ms INTEGER NOT NULL,
      time_since_last_update_ms INTEGER NOT NULL,
      current_deviation_pct DECIMAL(10, 6) NOT NULL,
      predicted_p_update DECIMAL(10, 6) NOT NULL,
      confidence_low DECIMAL(10, 6),
      confidence_high DECIMAL(10, 6),
      bucket TEXT NOT NULL,
      inputs_json TEXT,
      actual_outcome INTEGER,
      settled_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_oracle_pred_timestamp ON oracle_update_predictions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_oracle_pred_symbol ON oracle_update_predictions(symbol);
    CREATE INDEX IF NOT EXISTS idx_oracle_pred_window ON oracle_update_predictions(window_id);
    CREATE INDEX IF NOT EXISTS idx_oracle_pred_bucket ON oracle_update_predictions(bucket);
    CREATE INDEX IF NOT EXISTS idx_oracle_pred_bucket_outcome ON oracle_update_predictions(bucket, actual_outcome);
    CREATE INDEX IF NOT EXISTS idx_oracle_pred_symbol_timestamp ON oracle_update_predictions(symbol, timestamp DESC);
  `);
}

/**
 * Rollback the oracle_update_predictions table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_oracle_pred_symbol_timestamp;
    DROP INDEX IF EXISTS idx_oracle_pred_bucket_outcome;
    DROP INDEX IF EXISTS idx_oracle_pred_bucket;
    DROP INDEX IF EXISTS idx_oracle_pred_window;
    DROP INDEX IF EXISTS idx_oracle_pred_symbol;
    DROP INDEX IF EXISTS idx_oracle_pred_timestamp;
    DROP TABLE IF EXISTS oracle_update_predictions;
  `);
}
