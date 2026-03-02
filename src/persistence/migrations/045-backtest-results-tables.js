/**
 * Migration 045: Backtest Results Tables
 *
 * Persistent storage for backtest runs and individual trades.
 * Enables dashboard review, historical comparison, and cheap entry analysis.
 */

import { exec } from '../database.js';

export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id SERIAL PRIMARY KEY,
      run_id UUID DEFAULT gen_random_uuid(),
      status VARCHAR(20) DEFAULT 'running',
      config JSONB,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      total_strategies INT,
      total_symbols INT,
      total_windows INT,
      completed_pairs INT DEFAULT 0,
      progress_pct NUMERIC(5,2) DEFAULT 0,
      summary JSONB,
      ai_commentary TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS backtest_trades (
      id SERIAL PRIMARY KEY,
      run_id UUID,
      strategy VARCHAR(50) NOT NULL,
      strategy_description TEXT,
      symbol VARCHAR(10) NOT NULL,
      window_epoch BIGINT,
      window_close_time TIMESTAMPTZ,
      direction VARCHAR(10),
      entry_price NUMERIC(10,6),
      exit_price NUMERIC(10,6),
      size NUMERIC(12,4),
      cost NUMERIC(10,4),
      pnl NUMERIC(10,4),
      payout NUMERIC(10,4),
      won BOOLEAN,
      reason TEXT,
      confidence NUMERIC(5,4),
      time_to_close_ms INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bt_runs_run_id ON backtest_runs(run_id);
    CREATE INDEX IF NOT EXISTS idx_bt_trades_run ON backtest_trades(run_id);
    CREATE INDEX IF NOT EXISTS idx_bt_trades_strategy ON backtest_trades(run_id, strategy, symbol);
    CREATE INDEX IF NOT EXISTS idx_bt_trades_entry ON backtest_trades(run_id, entry_price);
    CREATE INDEX IF NOT EXISTS idx_bt_trades_cheap ON backtest_trades(run_id, entry_price) WHERE entry_price < 0.20;
  `);
}

export async function down() {
  await exec(`
    DROP TABLE IF EXISTS backtest_trades;
    DROP TABLE IF EXISTS backtest_runs;
  `);
}
