/**
 * Window-Expiry Logic
 *
 * Core window timing and resolution evaluation functions.
 *
 * Key behaviors:
 * - Parse window_id to extract timing information
 * - Calculate time remaining in a window
 * - Detect "expiring soon" state for warnings
 * - Detect "resolved" state for P&L calculation
 * - Block entries when insufficient time remains
 */

import {
  ExpiryReason,
  Resolution,
  createWindowExpiryResult,
  WindowExpiryError,
  WindowExpiryErrorCodes,
} from './types.js';
import {
  incrementEvaluations,
  incrementExpiring,
  incrementResolved,
  incrementSafe,
} from './state.js';

/**
 * Parse window_id to extract timing information
 *
 * Window ID format: {asset}-{duration}-{date}-{time}
 * Example: btc-15m-2026-01-31-10:00
 *
 * @param {string} windowId - Window identifier
 * @param {Object} [options] - Options
 * @param {number} [options.windowDurationMs] - Window duration in milliseconds
 * @returns {Object} { is_valid, asset, duration, start_time, end_time, duration_ms, error? }
 */
export function parseWindowId(windowId, options = {}) {
  const { windowDurationMs = 15 * 60 * 1000 } = options;

  if (!windowId || typeof windowId !== 'string') {
    return {
      is_valid: false,
      error: 'window_id is required and must be a string',
      start_time: null,
      end_time: null,
      duration_ms: windowDurationMs,
    };
  }

  // Expected format: {asset}-{duration}-{date}-{time}
  // Example: btc-15m-2026-01-31-10:00
  const pattern = /^([a-z]+)-(\d+m)-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/i;
  const match = windowId.match(pattern);

  if (!match) {
    return {
      is_valid: false,
      error: 'Invalid window_id format. Expected: {asset}-{duration}-{date}-{time}',
      start_time: null,
      end_time: null,
      duration_ms: windowDurationMs,
    };
  }

  const [, asset, duration, date, time] = match;

  // Parse start time (assumed UTC)
  const startTimeStr = `${date}T${time}:00.000Z`;
  const startTime = new Date(startTimeStr);

  if (isNaN(startTime.getTime())) {
    return {
      is_valid: false,
      error: 'Invalid date/time in window_id',
      start_time: null,
      end_time: null,
      duration_ms: windowDurationMs,
    };
  }

  const endTime = new Date(startTime.getTime() + windowDurationMs);

  return {
    is_valid: true,
    asset,
    duration,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    duration_ms: windowDurationMs,
  };
}

/**
 * Calculate time remaining in a window
 *
 * @param {string} windowId - Window identifier
 * @param {Object} [options] - Options
 * @param {number} [options.windowDurationMs] - Window duration in ms (default: 15 min)
 * @param {number} [options.expiryWarningThresholdMs] - Warning threshold in ms (default: 30 sec)
 * @param {Date} [options.now] - Current time (for testing)
 * @returns {Object} { time_remaining_ms, is_expiring, is_resolved, window_start_time, window_end_time }
 * @throws {WindowExpiryError} If window_id is invalid
 */
export function calculateTimeRemaining(windowId, options = {}) {
  const {
    windowDurationMs = 15 * 60 * 1000,
    expiryWarningThresholdMs = 30 * 1000,
    now = new Date(),
  } = options;

  const parsed = parseWindowId(windowId, { windowDurationMs });

  if (!parsed.is_valid) {
    throw new WindowExpiryError(
      WindowExpiryErrorCodes.INVALID_WINDOW_ID,
      parsed.error,
      { window_id: windowId }
    );
  }

  const endTime = new Date(parsed.end_time);
  const currentTime = now instanceof Date ? now : new Date(now);
  const time_remaining_ms = endTime.getTime() - currentTime.getTime();

  return {
    time_remaining_ms,
    is_expiring: time_remaining_ms > 0 && time_remaining_ms <= expiryWarningThresholdMs,
    is_resolved: time_remaining_ms <= 0,
    window_start_time: parsed.start_time,
    window_end_time: parsed.end_time,
  };
}

/**
 * Check if a position's window is expiring or resolved
 *
 * @param {Object} position - Position to check
 * @param {number} position.id - Position ID
 * @param {string} position.window_id - Window identifier
 * @param {string} position.side - 'long' or 'short'
 * @param {number} position.size - Position size
 * @param {number} position.entry_price - Entry price
 * @param {number} [position.current_price] - Current market price
 * @param {Object} [windowData] - Optional window resolution data
 * @param {number} [windowData.resolution_price] - Resolution price (0 or 1)
 * @param {Object} [options] - Evaluation options
 * @param {number} [options.windowDurationMs] - Window duration in ms
 * @param {number} [options.expiryWarningThresholdMs] - Warning threshold in ms
 * @param {Object} [options.log] - Logger instance
 * @param {Date} [options.now] - Current time (for testing)
 * @returns {Object} WindowExpiryResult
 */
export function checkExpiry(position, windowData = {}, options = {}) {
  const {
    windowDurationMs = 15 * 60 * 1000,
    expiryWarningThresholdMs = 30 * 1000,
    log,
    now = new Date(),
  } = options;

  incrementEvaluations();

  const timing = calculateTimeRemaining(position.window_id, {
    windowDurationMs,
    expiryWarningThresholdMs,
    now,
  });

  let is_expiring = timing.is_expiring;
  let is_resolved = timing.is_resolved;
  let reason = ExpiryReason.SAFE;
  let resolution_price = null;
  let outcome = null;
  let pnl = 0;
  let pnl_pct = 0;

  if (is_resolved) {
    reason = ExpiryReason.WINDOW_RESOLVED;
    incrementResolved();

    // Get resolution price from window data (0 or 1 for binary options)
    resolution_price = windowData.resolution_price ?? null;

    if (resolution_price !== null) {
      // Calculate outcome and P&L
      if (position.side === 'long') {
        // Long position wins if resolution is 1 (YES won)
        outcome = resolution_price === 1 ? Resolution.WIN : Resolution.LOSE;
        pnl = position.size * (resolution_price - position.entry_price);
      } else {
        // Short position wins if resolution is 0 (NO won / YES lost)
        outcome = resolution_price === 0 ? Resolution.WIN : Resolution.LOSE;
        pnl = position.size * (position.entry_price - resolution_price);
      }
      // Calculate P&L percentage relative to cost basis
      const costBasis = position.size * position.entry_price;
      pnl_pct = costBasis > 0 ? pnl / costBasis : 0;
    }

    if (log) {
      log.info('window_resolved', {
        position_id: position.id,
        window_id: position.window_id,
        side: position.side,
        expected: {
          entry_price: position.entry_price,
          position_side: position.side,
        },
        actual: {
          resolution_price,
          outcome,
          pnl,
          pnl_pct,
        },
      });
    }
  } else if (is_expiring) {
    reason = ExpiryReason.WINDOW_EXPIRING;
    incrementExpiring();

    if (log) {
      log.info('window_expiring_soon', {
        position_id: position.id,
        window_id: position.window_id,
        time_remaining_ms: timing.time_remaining_ms,
        entry_price: position.entry_price,
        current_price: position.current_price,
      });
    }
  } else {
    // Safe - plenty of time remaining
    incrementSafe();
    if (log) {
      log.debug('window_expiry_checked', {
        position_id: position.id,
        window_id: position.window_id,
        time_remaining_ms: timing.time_remaining_ms,
      });
    }
  }

  return createWindowExpiryResult({
    position_id: position.id,
    window_id: position.window_id,
    side: position.side,
    entry_price: position.entry_price,
    current_price: position.current_price || 0,
    window_start_time: timing.window_start_time,
    window_end_time: timing.window_end_time,
    time_remaining_ms: timing.time_remaining_ms,
    is_expiring,
    is_resolved,
    reason,
    resolution_price,
    outcome,
    pnl,
    pnl_pct,
  });
}

/**
 * Check if entry is allowed for a window
 *
 * @param {string} windowId - Window identifier
 * @param {Object} [options] - Options
 * @param {number} [options.windowDurationMs] - Window duration in ms
 * @param {number} [options.minTimeRemainingMs] - Minimum time required to enter
 * @param {Object} [options.log] - Logger instance
 * @param {Date} [options.now] - Current time (for testing)
 * @returns {Object} { allowed: boolean, reason: string, time_remaining_ms }
 */
export function canEnterWindow(windowId, options = {}) {
  const {
    windowDurationMs = 15 * 60 * 1000,
    minTimeRemainingMs = 60 * 1000,
    log,
    now = new Date(),
  } = options;

  try {
    const timing = calculateTimeRemaining(windowId, {
      windowDurationMs,
      now,
    });

    const allowed = timing.time_remaining_ms >= minTimeRemainingMs;
    const reason = allowed
      ? 'sufficient_time_remaining'
      : `insufficient_time_remaining: ${timing.time_remaining_ms}ms < ${minTimeRemainingMs}ms required`;

    if (!allowed && log) {
      log.info('entry_blocked_expiry', {
        window_id: windowId,
        time_remaining_ms: timing.time_remaining_ms,
        min_required_ms: minTimeRemainingMs,
      });
    }

    return {
      allowed,
      reason,
      time_remaining_ms: timing.time_remaining_ms,
    };
  } catch (err) {
    return {
      allowed: false,
      reason: `window_id_error: ${err.message}`,
      time_remaining_ms: 0,
    };
  }
}

/**
 * Evaluate window expiry for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} [getWindowData] - Function to get window data (resolution info)
 * @param {Object} [options] - Evaluation options
 * @param {number} [options.windowDurationMs] - Window duration in ms
 * @param {number} [options.expiryWarningThresholdMs] - Warning threshold in ms
 * @param {Object} [options.log] - Logger instance
 * @param {Date} [options.now] - Current time (for testing)
 * @returns {Object} { expiring: WindowExpiryResult[], resolved: WindowExpiryResult[], summary }
 */
export function evaluateAll(positions, getWindowData, options = {}) {
  const { log } = options;
  const expiring = [];
  const resolved = [];
  let evaluatedCount = 0;
  let safeCount = 0;

  for (const position of positions) {
    try {
      // Get window resolution data (if available)
      const windowData = getWindowData ? getWindowData(position.window_id) : {};

      const result = checkExpiry(position, windowData, options);
      evaluatedCount++;

      if (result.is_resolved) {
        resolved.push(result);
      } else if (result.is_expiring) {
        expiring.push(result);
      } else {
        safeCount++;
      }
    } catch (err) {
      if (log) {
        log.error('window_expiry_evaluation_error', {
          position_id: position.id,
          window_id: position.window_id,
          error: err.message,
          code: err.code,
        });
      }
    }
  }

  const summary = {
    evaluated: evaluatedCount,
    expiring: expiring.length,
    resolved: resolved.length,
    safe: safeCount,
  };

  if (log && evaluatedCount > 0) {
    log.info('window_expiry_evaluation_complete', {
      total_positions: positions.length,
      ...summary,
    });
  }

  return { expiring, resolved, summary };
}
