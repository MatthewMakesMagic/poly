/**
 * Migration 003: Daily Performance Table
 *
 * Creates the daily_performance table for tracking daily drawdown and P&L.
 * This table stores daily trading performance metrics including:
 * - Starting and current balance
 * - Realized and unrealized P&L
 * - Drawdown percentages (current and max)
 * - Trade statistics (count, wins, losses)
 */

import { run } from '../database.js';

/**
 * Apply the daily_performance table schema
 */
export function up() {
  // Create daily_performance table with all required columns
  run(`
    CREATE TABLE IF NOT EXISTS daily_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      starting_balance REAL NOT NULL,
      current_balance REAL NOT NULL,
      realized_pnl REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      drawdown_pct REAL DEFAULT 0,
      max_drawdown_pct REAL DEFAULT 0,
      trades_count INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);

  // Create index on date for quick lookups
  run('CREATE INDEX IF NOT EXISTS idx_daily_performance_date ON daily_performance(date)');
}

/**
 * Rollback the daily_performance table
 */
export function down() {
  run('DROP INDEX IF EXISTS idx_daily_performance_date');
  run('DROP TABLE IF EXISTS daily_performance');
}
