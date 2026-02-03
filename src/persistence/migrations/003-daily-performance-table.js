/**
 * Migration 003: Daily Performance Table
 *
 * Creates the daily_performance table for tracking daily drawdown and P&L.
 * This table stores daily trading performance metrics including:
 * - Starting and current balance
 * - Realized and unrealized P&L
 * - Drawdown percentages (current and max)
 * - Trade statistics (count, wins, losses)
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 */

import { exec } from '../database.js';

/**
 * Apply the daily_performance table schema
 */
export async function up() {
  await exec(`
    CREATE TABLE IF NOT EXISTS daily_performance (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      starting_balance DECIMAL(20, 8) NOT NULL,
      current_balance DECIMAL(20, 8) NOT NULL,
      realized_pnl DECIMAL(20, 8) DEFAULT 0,
      unrealized_pnl DECIMAL(20, 8) DEFAULT 0,
      drawdown_pct DECIMAL(10, 6) DEFAULT 0,
      max_drawdown_pct DECIMAL(10, 6) DEFAULT 0,
      trades_count INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_daily_performance_date ON daily_performance(date);
  `);
}

/**
 * Rollback the daily_performance table
 */
export async function down() {
  await exec(`
    DROP INDEX IF EXISTS idx_daily_performance_date;
    DROP TABLE IF EXISTS daily_performance;
  `);
}
