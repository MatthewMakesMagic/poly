/**
 * Migration 009: Probability Predictions (Calibration Tracking) Table
 *
 * Creates the probability_predictions table for tracking Black-Scholes
 * probability predictions and their outcomes for calibration analysis.
 *
 * Used by the window-timing-model component to:
 * - Log probability predictions with bucket assignment
 * - Track actual outcomes when windows settle
 * - Calculate calibration error per bucket
 * - Detect model miscalibration
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the probability_predictions table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS probability_predictions (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      symbol TEXT NOT NULL,
      window_id TEXT NOT NULL,
      predicted_p_up DECIMAL(10, 6) NOT NULL,
      bucket TEXT NOT NULL,
      oracle_price_at_prediction DECIMAL(20, 8),
      strike DECIMAL(20, 8),
      time_to_expiry_ms INTEGER,
      sigma_used DECIMAL(10, 6),
      vol_surprise INTEGER DEFAULT 0,
      actual_outcome TEXT,
      prediction_correct INTEGER,
      settled_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_prob_pred_timestamp ON probability_predictions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_symbol ON probability_predictions(symbol);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_bucket ON probability_predictions(bucket);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_window ON probability_predictions(window_id);
    CREATE INDEX IF NOT EXISTS idx_prob_pred_bucket_outcome ON probability_predictions(bucket, actual_outcome);
  `);
}

/**
 * Rollback the probability_predictions table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_prob_pred_bucket_outcome;
    DROP INDEX IF EXISTS idx_prob_pred_window;
    DROP INDEX IF EXISTS idx_prob_pred_bucket;
    DROP INDEX IF EXISTS idx_prob_pred_symbol;
    DROP INDEX IF EXISTS idx_prob_pred_timestamp;
    DROP TABLE IF EXISTS probability_predictions;
  `);
}
