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
 */

import { run } from '../database.js';

/**
 * Apply the probability_predictions table schema
 */
export function up() {
  // Create probability_predictions table
  run(`
    CREATE TABLE IF NOT EXISTS probability_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      symbol TEXT NOT NULL,
      window_id TEXT NOT NULL,
      predicted_p_up REAL NOT NULL,
      bucket TEXT NOT NULL,
      oracle_price_at_prediction REAL,
      strike REAL,
      time_to_expiry_ms INTEGER,
      sigma_used REAL,
      vol_surprise INTEGER DEFAULT 0,
      actual_outcome TEXT,
      prediction_correct INTEGER,
      settled_at TEXT
    )
  `);

  // Create indexes for efficient queries
  run('CREATE INDEX IF NOT EXISTS idx_prob_pred_timestamp ON probability_predictions(timestamp)');
  run('CREATE INDEX IF NOT EXISTS idx_prob_pred_symbol ON probability_predictions(symbol)');
  run('CREATE INDEX IF NOT EXISTS idx_prob_pred_bucket ON probability_predictions(bucket)');
  run('CREATE INDEX IF NOT EXISTS idx_prob_pred_window ON probability_predictions(window_id)');
  // Compound index for calibration queries: GROUP BY bucket WHERE actual_outcome IS NOT NULL
  run('CREATE INDEX IF NOT EXISTS idx_prob_pred_bucket_outcome ON probability_predictions(bucket, actual_outcome)');
}

/**
 * Rollback the probability_predictions table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_prob_pred_bucket_outcome');
  run('DROP INDEX IF EXISTS idx_prob_pred_window');
  run('DROP INDEX IF EXISTS idx_prob_pred_bucket');
  run('DROP INDEX IF EXISTS idx_prob_pred_symbol');
  run('DROP INDEX IF EXISTS idx_prob_pred_timestamp');
  run('DROP TABLE IF EXISTS probability_predictions');
}
