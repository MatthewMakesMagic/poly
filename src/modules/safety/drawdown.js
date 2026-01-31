/**
 * Drawdown Tracking Logic
 *
 * Core drawdown calculation and daily performance record management.
 * Implements the business logic for tracking realized and unrealized P&L,
 * calculating drawdown percentages, and maintaining trade statistics.
 */

import persistence from '../../persistence/index.js';
import {
  getCachedRecord,
  getCachedDate,
  setCachedRecord,
  updateCachedRecord,
  getStartingCapital,
} from './state.js';
import { SafetyError, SafetyErrorCodes } from './types.js';

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string} Today's date
 */
export function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get or create today's daily performance record
 *
 * If a record exists for today, returns it from cache or database.
 * If no record exists, creates a new one with initial values.
 *
 * @param {Object} [log] - Optional logger instance
 * @returns {Object} Daily performance record
 */
export function getOrCreateTodayRecord(log) {
  const today = getTodayDate();
  const startingCapital = getStartingCapital();

  // Check cache first
  if (getCachedRecord() && getCachedDate() === today) {
    return getCachedRecord();
  }

  // Query database for existing record
  let record = persistence.get(
    'SELECT * FROM daily_performance WHERE date = ?',
    [today]
  );

  if (!record) {
    // Create new record for today
    const now = new Date().toISOString();

    try {
      persistence.run(
        `INSERT INTO daily_performance
          (date, starting_balance, current_balance, realized_pnl, unrealized_pnl,
           drawdown_pct, max_drawdown_pct, trades_count, wins, losses, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?)`,
        [today, startingCapital, startingCapital, now]
      );

      record = persistence.get(
        'SELECT * FROM daily_performance WHERE date = ?',
        [today]
      );

      if (log) {
        log.info('daily_performance_created', {
          date: today,
          startingBalance: startingCapital,
        });
      }
    } catch (err) {
      // Handle race condition where another process created the record
      if (err.message && err.message.includes('UNIQUE constraint')) {
        record = persistence.get(
          'SELECT * FROM daily_performance WHERE date = ?',
          [today]
        );
      } else {
        throw new SafetyError(
          SafetyErrorCodes.DATABASE_ERROR,
          `Failed to create daily performance record: ${err.message}`,
          { date: today, originalError: err.message }
        );
      }
    }
  }

  // Update cache
  setCachedRecord(record, today);

  return record;
}

/**
 * Record realized P&L from a closed position
 *
 * Updates the daily performance record with:
 * - Cumulative realized P&L
 * - Current balance recalculation
 * - Drawdown percentage calculation
 * - Max drawdown tracking
 * - Trade count and win/loss statistics
 *
 * @param {number} pnl - Realized P&L amount (positive for profit, negative for loss)
 * @param {Object} [log] - Optional logger instance
 * @returns {Object} Updated daily performance record
 */
export function recordRealizedPnl(pnl, log) {
  if (typeof pnl !== 'number' || !Number.isFinite(pnl)) {
    throw new SafetyError(
      SafetyErrorCodes.INVALID_AMOUNT,
      `Invalid P&L amount: ${pnl}. Must be a finite number.`,
      { pnl }
    );
  }

  const record = getOrCreateTodayRecord(log);

  // Calculate new values
  const newRealizedPnl = record.realized_pnl + pnl;
  const newCurrentBalance = record.starting_balance + newRealizedPnl;

  // Calculate drawdown: (starting - current) / starting
  // Positive drawdown means loss, negative means profit
  const newDrawdownPct = (record.starting_balance - newCurrentBalance) / record.starting_balance;

  // Max drawdown tracks the worst (highest positive) drawdown
  const newMaxDrawdown = Math.max(record.max_drawdown_pct, newDrawdownPct);

  // Update trade statistics
  const newTradesCount = record.trades_count + 1;
  const newWins = pnl > 0 ? record.wins + 1 : record.wins;
  const newLosses = pnl < 0 ? record.losses + 1 : record.losses;

  const now = new Date().toISOString();

  // Persist to database
  persistence.run(
    `UPDATE daily_performance
     SET realized_pnl = ?,
         current_balance = ?,
         drawdown_pct = ?,
         max_drawdown_pct = ?,
         trades_count = ?,
         wins = ?,
         losses = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      newRealizedPnl,
      newCurrentBalance,
      newDrawdownPct,
      newMaxDrawdown,
      newTradesCount,
      newWins,
      newLosses,
      now,
      record.id,
    ]
  );

  // Update cache
  const updatedRecord = updateCachedRecord({
    realized_pnl: newRealizedPnl,
    current_balance: newCurrentBalance,
    drawdown_pct: newDrawdownPct,
    max_drawdown_pct: newMaxDrawdown,
    trades_count: newTradesCount,
    wins: newWins,
    losses: newLosses,
    updated_at: now,
  });

  if (log) {
    log.info('realized_pnl_recorded', {
      pnl,
      realizedPnl: newRealizedPnl,
      currentBalance: newCurrentBalance,
      drawdownPct: newDrawdownPct,
      tradesCount: newTradesCount,
    });
  }

  return updatedRecord;
}

/**
 * Update unrealized P&L from open positions
 *
 * Updates the daily performance record with the total unrealized P&L
 * from all open positions. This is typically called periodically by
 * the orchestrator to reflect current market value.
 *
 * @param {number} unrealizedPnl - Total unrealized P&L across all positions
 * @param {Object} [log] - Optional logger instance
 * @returns {Object} Updated daily performance record
 */
export function updateUnrealizedPnl(unrealizedPnl, log) {
  if (typeof unrealizedPnl !== 'number' || !Number.isFinite(unrealizedPnl)) {
    throw new SafetyError(
      SafetyErrorCodes.INVALID_AMOUNT,
      `Invalid unrealized P&L amount: ${unrealizedPnl}. Must be a finite number.`,
      { unrealizedPnl }
    );
  }

  const record = getOrCreateTodayRecord(log);
  const now = new Date().toISOString();

  // Persist to database
  persistence.run(
    `UPDATE daily_performance
     SET unrealized_pnl = ?,
         updated_at = ?
     WHERE id = ?`,
    [unrealizedPnl, now, record.id]
  );

  // Update cache
  const updatedRecord = updateCachedRecord({
    unrealized_pnl: unrealizedPnl,
    updated_at: now,
  });

  if (log) {
    log.debug('unrealized_pnl_updated', {
      unrealizedPnl,
      date: record.date,
    });
  }

  return updatedRecord;
}

/**
 * Get current drawdown status
 *
 * Returns a comprehensive snapshot of the current drawdown state,
 * including realized, unrealized, and total drawdown.
 *
 * @returns {Object} Drawdown status object
 */
export function getDrawdownStatus() {
  const record = getCachedRecord();

  if (!record) {
    return {
      initialized: false,
      drawdown_pct: 0,
      max_drawdown_pct: 0,
      total_drawdown_pct: 0,
    };
  }

  // Calculate effective balance (includes unrealized P&L)
  const effectiveBalance = record.current_balance + record.unrealized_pnl;

  // Calculate total drawdown including unrealized
  const totalDrawdownPct = (record.starting_balance - effectiveBalance) / record.starting_balance;

  return {
    initialized: true,
    date: record.date,
    starting_balance: record.starting_balance,
    current_balance: record.current_balance,
    effective_balance: effectiveBalance,
    realized_pnl: record.realized_pnl,
    unrealized_pnl: record.unrealized_pnl,
    drawdown_pct: record.drawdown_pct,
    max_drawdown_pct: record.max_drawdown_pct,
    total_drawdown_pct: totalDrawdownPct,
    trades_count: record.trades_count,
    wins: record.wins,
    losses: record.losses,
    updated_at: record.updated_at,
  };
}

/**
 * Check if cache needs refresh (date changed)
 *
 * @returns {boolean} True if cache is stale
 */
export function isCacheStale() {
  const cachedDate = getCachedDate();
  if (!cachedDate) return true;

  const today = getTodayDate();
  return cachedDate !== today;
}
