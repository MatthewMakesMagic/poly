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
  getDrawdownLimit,
  getDrawdownWarningThreshold,
  isAutoStopped as checkAutoStopped,
  setAutoStopped,
  persistAutoStopState,
  hasWarnedAtLevel,
  markWarnedAtLevel,
  clearAutoStopState,
  resetAutoStopStateInDb,
  clearWarnedLevels,
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
export async function getOrCreateTodayRecord(log) {
  const today = getTodayDate();
  const startingCapital = getStartingCapital();

  // Check cache first
  if (getCachedRecord() && getCachedDate() === today) {
    return getCachedRecord();
  }

  // Query database for existing record
  let record = await persistence.get(
    'SELECT * FROM daily_performance WHERE date = $1',
    [today]
  );

  if (!record) {
    // Create new record for today
    const now = new Date().toISOString();

    try {
      await persistence.run(
        `INSERT INTO daily_performance
          (date, starting_balance, current_balance, realized_pnl, unrealized_pnl,
           drawdown_pct, max_drawdown_pct, trades_count, wins, losses, updated_at)
        VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0, 0, $4)`,
        [today, startingCapital, startingCapital, now]
      );

      record = await persistence.get(
        'SELECT * FROM daily_performance WHERE date = $1',
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
        record = await persistence.get(
          'SELECT * FROM daily_performance WHERE date = $1',
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
export async function recordRealizedPnl(pnl, log) {
  if (typeof pnl !== 'number' || !Number.isFinite(pnl)) {
    throw new SafetyError(
      SafetyErrorCodes.INVALID_AMOUNT,
      `Invalid P&L amount: ${pnl}. Must be a finite number.`,
      { pnl }
    );
  }

  const record = await getOrCreateTodayRecord(log);

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
  await persistence.run(
    `UPDATE daily_performance
     SET realized_pnl = $1,
         current_balance = $2,
         drawdown_pct = $3,
         max_drawdown_pct = $4,
         trades_count = $5,
         wins = $6,
         losses = $7,
         updated_at = $8
     WHERE id = $9`,
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
export async function updateUnrealizedPnl(unrealizedPnl, log) {
  if (typeof unrealizedPnl !== 'number' || !Number.isFinite(unrealizedPnl)) {
    throw new SafetyError(
      SafetyErrorCodes.INVALID_AMOUNT,
      `Invalid unrealized P&L amount: ${unrealizedPnl}. Must be a finite number.`,
      { unrealizedPnl }
    );
  }

  const record = await getOrCreateTodayRecord(log);
  const now = new Date().toISOString();

  // Persist to database
  await persistence.run(
    `UPDATE daily_performance
     SET unrealized_pnl = $1,
         updated_at = $2
     WHERE id = $3`,
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

/**
 * Check drawdown limit and trigger auto-stop if breached
 *
 * Returns the current drawdown status including whether the limit has been
 * breached and whether auto-stop is active. Logs warnings when approaching
 * the limit and triggers auto-stop when the limit is breached.
 *
 * @param {Object} [log] - Optional logger instance
 * @param {Object} [orderManager] - Optional order manager for cancelling orders
 * @returns {Object} Drawdown limit status:
 *   - breached: boolean (true if limit exceeded)
 *   - current: number (current total drawdown percentage)
 *   - limit: number (configured limit percentage)
 *   - autoStopped: boolean (true if auto-stop is active)
 */
export async function checkDrawdownLimit(log, orderManager = null) {
  const status = getDrawdownStatus();
  const limit = getDrawdownLimit();
  const warningThreshold = getDrawdownWarningThreshold();

  // Handle uninitialized state
  if (!status.initialized) {
    return {
      breached: false,
      current: 0,
      limit,
      autoStopped: checkAutoStopped(),
    };
  }

  const current = status.total_drawdown_pct;
  const breached = current >= limit;
  const alreadyAutoStopped = checkAutoStopped();

  // Check for warning (approaching limit but not breached and not already auto-stopped)
  if (!breached && !alreadyAutoStopped && current >= warningThreshold) {
    if (!hasWarnedAtLevel(current)) {
      if (log) {
        log.warn('drawdown_warning', {
          event: 'drawdown_approaching_limit',
          current_pct: (current * 100).toFixed(2),
          limit_pct: (limit * 100).toFixed(2),
          remaining_pct: ((limit - current) * 100).toFixed(2),
          warning_threshold_pct: (warningThreshold * 100).toFixed(2),
        });
      }
      markWarnedAtLevel(current);
    }
  }

  // Check for breach - trigger auto-stop if not already stopped
  if (breached && !alreadyAutoStopped) {
    triggerAutoStop(
      {
        reason: 'drawdown_limit_breached',
        current_pct: current,
        limit_pct: limit,
      },
      log,
      orderManager
    );
  }

  return {
    breached,
    current,
    limit,
    autoStopped: checkAutoStopped(),
  };
}

/**
 * Trigger auto-stop due to drawdown limit breach or other safety condition
 *
 * Sets the auto-stop flag, persists state, cancels all open orders,
 * and logs the auto-stop event.
 *
 * @param {Object} details - Auto-stop details
 * @param {string} details.reason - Reason for auto-stop
 * @param {number} details.current_pct - Current drawdown percentage
 * @param {number} details.limit_pct - Configured limit percentage
 * @param {Object} [log] - Optional logger instance
 * @param {Object} [orderManager] - Optional order manager for cancelling orders
 */
export function triggerAutoStop(details, log, orderManager = null) {
  const { reason, current_pct, limit_pct } = details;

  // Set auto-stop state
  setAutoStopped(true, reason);

  // Log error-level event
  if (log) {
    log.error('auto_stop_triggered', {
      event: 'AUTO-STOP',
      reason,
      current_pct: (current_pct * 100).toFixed(2),
      limit_pct: (limit_pct * 100).toFixed(2),
      message: `AUTO-STOP: Drawdown limit breached at ${(current_pct * 100).toFixed(2)}%, limit was ${(limit_pct * 100).toFixed(2)}%`,
    });
  }

  // Persist auto-stop state to survive restarts (fire-and-forget)
  persistAutoStopState(log).catch(() => {});

  // Cancel all open orders (fire-and-forget, don't block on failure)
  if (orderManager && typeof orderManager.cancelAllOrders === 'function') {
    try {
      orderManager.cancelAllOrders();
      if (log) {
        log.info('auto_stop_orders_cancelled', {
          event: 'orders_cancelled',
          reason: 'auto_stop',
        });
      }
    } catch (err) {
      // Log warning but don't block auto-stop
      if (log) {
        log.warn('auto_stop_cancel_orders_failed', {
          error: err.message,
          code: err.code,
        });
      }
    }
  } else if (log && orderManager === null) {
    log.debug('auto_stop_no_order_manager', {
      message: 'Order manager not provided, skipping order cancellation',
    });
  }
}

/**
 * Reset auto-stop state (manual resume)
 *
 * Requires explicit confirmation to prevent accidental reset.
 * Clears auto-stop flag, deletes state file, and logs the reset.
 *
 * @param {Object} options - Reset options
 * @param {boolean} options.confirm - Must be true to confirm reset
 * @param {Object} [log] - Optional logger instance
 * @throws {SafetyError} If confirm is not true
 */
export async function resetAutoStop(options = {}, log) {
  const { confirm } = options;

  if (confirm !== true) {
    throw new SafetyError(
      SafetyErrorCodes.RESET_REQUIRES_CONFIRMATION,
      'Auto-stop reset requires explicit confirmation. Pass { confirm: true } to confirm.',
      {}
    );
  }

  // Clear in-memory state
  clearAutoStopState();

  // Clear warning levels
  clearWarnedLevels();

  // Reset persisted state in database
  await resetAutoStopStateInDb(log);

  // Log the reset
  if (log) {
    log.info('auto_stop_reset', {
      event: 'auto_stop_manually_reset',
      message: 'Auto-stop manually reset by user',
    });
  }
}
