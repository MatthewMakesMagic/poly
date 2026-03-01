/**
 * Position Entry Safeguards Module (V3 Stage 4: Atomic DB Safeguards)
 *
 * Enforces entry safeguards using PostgreSQL as single source of truth:
 * - Duplicate window entries via UNIQUE constraint on window_entries table
 * - Rate limiting via confirmed_at timestamps
 * - Excessive concurrent positions
 * - Too many entries per tick cycle
 *
 * @module modules/position-manager/safeguards
 */

import { child } from '../logger/index.js';
import persistence from '../../persistence/index.js';

// Module state
let log = null;
let config = {
  max_concurrent_positions: 8,
  min_entry_interval_ms: 5000,
  max_entries_per_tick: 2,
  duplicate_window_prevention: true,
  reservation_timeout_ms: 30000,
};
let initialized = false;

// Keep in-memory: ephemeral per-tick counter (resets each tick, not trading state)
let tickEntryCount = 0;

/**
 * Initialize the safeguards module
 */
export function init(cfg = {}) {
  if (initialized) {
    return;
  }

  log = child({ module: 'safeguards' });

  if (cfg.safeguards) {
    config = {
      max_concurrent_positions: cfg.safeguards.max_concurrent_positions ?? config.max_concurrent_positions,
      min_entry_interval_ms: cfg.safeguards.min_entry_interval_ms ?? config.min_entry_interval_ms,
      max_entries_per_tick: cfg.safeguards.max_entries_per_tick ?? config.max_entries_per_tick,
      duplicate_window_prevention: cfg.safeguards.duplicate_window_prevention ?? config.duplicate_window_prevention,
      reservation_timeout_ms: cfg.safeguards.reservation_timeout_ms ?? config.reservation_timeout_ms,
    };
  }

  initialized = true;
  log.info('safeguards_initialized', {
    max_concurrent_positions: config.max_concurrent_positions,
    min_entry_interval_ms: config.min_entry_interval_ms,
    max_entries_per_tick: config.max_entries_per_tick,
    duplicate_window_prevention: config.duplicate_window_prevention,
    reservation_timeout_ms: config.reservation_timeout_ms,
  });
}

/**
 * Clean up stale reservations from DB
 */
async function cleanupStaleReservations() {
  const timeoutMs = config.reservation_timeout_ms;
  const result = await persistence.run(
    `DELETE FROM window_entries WHERE status = 'reserved' AND reserved_at < NOW() - INTERVAL '1 millisecond' * $1`,
    [timeoutMs]
  );

  if (result.changes > 0 && log) {
    log.warn('stale_reservations_cleaned', { count: result.changes, timeout_ms: timeoutMs });
  }

  return result.changes;
}

/**
 * Check if a position entry is allowed (async, DB-backed)
 */
export async function canEnterPosition(signal, openPositions = []) {
  if (!initialized) {
    return { allowed: false, reason: 'safeguards_not_initialized' };
  }

  // Clean up stale reservations before checking
  await cleanupStaleReservations();

  const windowId = signal?.window_id;
  const strategyId = signal?.strategy_id || 'default';
  const symbol = (signal?.symbol || '').toUpperCase();

  // 1. Duplicate entry check (DB-backed)
  if (config.duplicate_window_prevention && windowId) {
    const existing = await persistence.get(
      `SELECT id, status FROM window_entries WHERE window_id = $1 AND strategy_id = $2`,
      [windowId, strategyId]
    );

    if (existing) {
      const result = {
        allowed: false,
        reason: 'duplicate_window_entry',
        details: {
          window_id: windowId,
          strategy_id: strategyId,
          is_reserved: existing.status === 'reserved',
          is_confirmed: existing.status === 'confirmed',
        },
      };
      log.info('entry_blocked', {
        reason: result.reason,
        window_id: windowId,
        strategy_id: strategyId,
        symbol,
      });
      return result;
    }
  }

  // 2. Rate limiting - check most recent confirmed_at by symbol from DB
  if (symbol && config.min_entry_interval_ms > 0) {
    const lastEntry = await persistence.get(
      `SELECT confirmed_at FROM window_entries WHERE symbol = $1 AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1`,
      [symbol]
    );

    if (lastEntry && lastEntry.confirmed_at) {
      const lastEntryTime = new Date(lastEntry.confirmed_at).getTime();
      const timeSinceLastEntry = Date.now() - lastEntryTime;

      if (timeSinceLastEntry < config.min_entry_interval_ms) {
        const result = {
          allowed: false,
          reason: 'rate_limit_exceeded',
          details: {
            symbol,
            time_since_last_ms: timeSinceLastEntry,
            min_interval_ms: config.min_entry_interval_ms,
          },
        };
        log.info('entry_blocked', {
          reason: result.reason,
          window_id: windowId,
          strategy_id: strategyId,
          symbol,
          time_since_last_ms: timeSinceLastEntry,
          min_interval_ms: config.min_entry_interval_ms,
        });
        return result;
      }
    }
  }

  // 3. Concurrent positions cap
  const openCount = Array.isArray(openPositions) ? openPositions.length : 0;
  if (openCount >= config.max_concurrent_positions) {
    const result = {
      allowed: false,
      reason: 'max_concurrent_positions_reached',
      details: {
        current_positions: openCount,
        max_positions: config.max_concurrent_positions,
      },
    };
    log.info('entry_blocked', {
      reason: result.reason,
      window_id: windowId,
      strategy_id: strategyId,
      symbol,
      current_positions: openCount,
      max_positions: config.max_concurrent_positions,
    });
    return result;
  }

  // 4. Per-tick limit
  if (tickEntryCount >= config.max_entries_per_tick) {
    const result = {
      allowed: false,
      reason: 'max_entries_per_tick_reached',
      details: {
        current_tick_entries: tickEntryCount,
        max_per_tick: config.max_entries_per_tick,
      },
    };
    log.info('entry_blocked', {
      reason: result.reason,
      window_id: windowId,
      strategy_id: strategyId,
      symbol,
      current_tick_entries: tickEntryCount,
      max_per_tick: config.max_entries_per_tick,
    });
    return result;
  }

  return { allowed: true };
}

/**
 * Record a successful entry (deprecated - use reserveEntry + confirmEntry)
 */
export async function recordEntry(windowId, symbol, strategyId = 'default') {
  if (!initialized) {
    return;
  }

  const normalizedSymbol = (symbol || '').toUpperCase();
  const now = new Date().toISOString();

  if (windowId) {
    // Insert as confirmed directly (for backward compat)
    await persistence.run(
      `INSERT INTO window_entries (window_id, strategy_id, status, symbol, confirmed_at)
       VALUES ($1, $2, 'confirmed', $3, $4)
       ON CONFLICT (window_id, strategy_id) DO UPDATE SET status = 'confirmed', symbol = $3, confirmed_at = $4`,
      [windowId, strategyId || 'default', normalizedSymbol || null, now]
    );
  }

  tickEntryCount++;

  log.info('entry_recorded', {
    window_id: windowId,
    strategy_id: strategyId,
    symbol: normalizedSymbol,
    tick_entry_count: tickEntryCount,
  });
}

/**
 * Reserve an entry slot before order placement (atomic via UNIQUE constraint)
 * Returns true if reservation successful, false if already reserved/entered
 */
export async function reserveEntry(windowId, strategyId = 'default') {
  if (!initialized) {
    return false;
  }

  // Clean up stale reservations first
  await cleanupStaleReservations();

  try {
    const result = await persistence.run(
      `INSERT INTO window_entries (window_id, strategy_id, status)
       VALUES ($1, $2, 'reserved')
       ON CONFLICT (window_id, strategy_id) DO NOTHING`,
      [windowId, strategyId]
    );

    const success = result.changes === 1;

    if (success) {
      log.info('entry_reserved', {
        window_id: windowId,
        strategy_id: strategyId,
      });
    } else {
      log.info('reservation_blocked', {
        window_id: windowId,
        strategy_id: strategyId,
      });
    }

    return success;
  } catch (err) {
    log.warn('reservation_failed', {
      window_id: windowId,
      strategy_id: strategyId,
      error: err.message,
    });
    return false;
  }
}

/**
 * Confirm a reserved entry after successful order
 */
export async function confirmEntry(windowId, strategyId = 'default', symbol) {
  if (!initialized) {
    return false;
  }

  const normalizedSymbol = (symbol || '').toUpperCase();
  const now = new Date().toISOString();

  const result = await persistence.run(
    `UPDATE window_entries SET status = 'confirmed', symbol = $1, confirmed_at = $2
     WHERE window_id = $3 AND strategy_id = $4 AND status = 'reserved'`,
    [normalizedSymbol || null, now, windowId, strategyId]
  );

  tickEntryCount++;

  log.info('entry_confirmed', {
    window_id: windowId,
    strategy_id: strategyId,
    symbol: normalizedSymbol,
    tick_entry_count: tickEntryCount,
  });

  return result.changes === 1;
}

/**
 * Release a reserved entry on order failure
 */
export async function releaseEntry(windowId, strategyId = 'default') {
  if (!initialized) {
    return false;
  }

  const result = await persistence.run(
    `DELETE FROM window_entries WHERE window_id = $1 AND strategy_id = $2`,
    [windowId, strategyId]
  );

  const wasReleased = result.changes > 0;

  if (wasReleased) {
    log.info('entry_released', {
      window_id: windowId,
      strategy_id: strategyId,
    });
  }

  return wasReleased;
}

/**
 * Remove an entry when position is closed
 */
export async function removeEntry(windowId, strategyId = 'default') {
  if (!initialized) {
    return false;
  }

  const result = await persistence.run(
    `DELETE FROM window_entries WHERE window_id = $1 AND strategy_id = $2`,
    [windowId, strategyId]
  );

  const wasPresent = result.changes > 0;

  if (wasPresent) {
    log.info('entry_removed', {
      window_id: windowId,
      strategy_id: strategyId,
    });
  }

  return wasPresent;
}

/**
 * Reset tick entries counter
 */
export function resetTickEntries() {
  const previousCount = tickEntryCount;
  tickEntryCount = 0;

  if (log && previousCount > 0) {
    log.debug('tick_entries_reset', { previous_count: previousCount });
  }
}

/**
 * Get current safeguards state
 */
export async function getState() {
  const confirmedCount = initialized
    ? (await persistence.get(`SELECT COUNT(*) as count FROM window_entries WHERE status = 'confirmed'`))?.count || 0
    : 0;
  const reservedCount = initialized
    ? (await persistence.get(`SELECT COUNT(*) as count FROM window_entries WHERE status = 'reserved'`))?.count || 0
    : 0;

  return {
    initialized,
    config: { ...config },
    stats: {
      entries_confirmed: Number(confirmedCount),
      entries_reserved: Number(reservedCount),
      tick_entry_count: tickEntryCount,
    },
  };
}

/**
 * Shutdown the safeguards module
 */
export function shutdown() {
  if (log) {
    log.info('safeguards_shutdown');
  }

  tickEntryCount = 0;
  initialized = false;
  log = null;
}

/**
 * Reset all tracking state (for testing)
 */
export async function resetState() {
  if (initialized) {
    await persistence.run(`DELETE FROM window_entries`);
  }
  tickEntryCount = 0;

  if (log) {
    log.debug('safeguards_state_reset');
  }
}

/**
 * Check if a window/strategy pair has been entered
 */
export async function hasEnteredWindow(windowId, strategyId = 'default') {
  const existing = await persistence.get(
    `SELECT id FROM window_entries WHERE window_id = $1 AND strategy_id = $2`,
    [windowId, strategyId]
  );
  return !!existing;
}

/**
 * Get time since last entry for a symbol
 */
export async function getTimeSinceLastEntry(symbol) {
  const normalizedSymbol = (symbol || '').toUpperCase();
  const lastEntry = await persistence.get(
    `SELECT confirmed_at FROM window_entries WHERE symbol = $1 AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1`,
    [normalizedSymbol]
  );

  if (!lastEntry || !lastEntry.confirmed_at) {
    return null;
  }

  return Date.now() - new Date(lastEntry.confirmed_at).getTime();
}

/**
 * Get current tick entry count
 */
export function getTickEntryCount() {
  return tickEntryCount;
}
