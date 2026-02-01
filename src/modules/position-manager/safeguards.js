/**
 * Position Entry Safeguards Module (Story 8-7, Enhanced in Story 8-9)
 *
 * Enforces entry safeguards to prevent:
 * - Duplicate window entries within a session (now per strategy)
 * - Rapid-fire entries (rate limiting)
 * - Excessive concurrent positions
 * - Too many entries per tick cycle
 *
 * Story 8-9 Enhancements:
 * - Strategy-aware tracking: {window_id, strategy_id} pairs
 * - Reserve/Confirm flow for race condition prevention
 * - Position manager integration for position open/close events
 * - Startup initialization from existing positions
 *
 * @module modules/position-manager/safeguards
 */

import { child } from '../logger/index.js';

// Module state
let log = null;
let config = {
  max_concurrent_positions: 8,
  min_entry_interval_ms: 5000,
  max_entries_per_tick: 2,
  duplicate_window_prevention: true,
  reservation_timeout_ms: 30000,  // Story 8-9: Auto-release stale reservations
};
let initialized = false;

// Tracking state (Story 8-9: Enhanced with strategy-aware tracking)
let enteredEntries = new Set();                      // Confirmed entries: "window_id:strategy_id"
let reservedEntries = new Set();                     // Pending reservations: "window_id:strategy_id"
let reservationTimestamps = new Map();               // Reservation timestamps for timeout
let lastEntryTimeBySymbol = new Map();               // Symbol -> timestamp
let tickEntryCount = 0;                              // Entries this tick cycle

// Position manager callback - removed, using direct integration instead (Story 8-9)

/**
 * Create composite entry key for strategy-aware tracking (Story 8-9)
 *
 * @param {string} windowId - Window identifier
 * @param {string} [strategyId='default'] - Strategy identifier
 * @returns {string} Composite key "window_id:strategy_id"
 */
function makeEntryKey(windowId, strategyId) {
  return `${windowId}:${strategyId || 'default'}`;
}

/**
 * Clean up stale reservations (Story 8-9)
 * Called internally to remove reservations that exceeded timeout
 */
function cleanupStaleReservations() {
  const now = Date.now();
  const staleKeys = [];

  for (const [key, timestamp] of reservationTimestamps.entries()) {
    if (now - timestamp > config.reservation_timeout_ms) {
      staleKeys.push({ key, timestamp });
    }
  }

  for (const { key, timestamp } of staleKeys) {
    reservedEntries.delete(key);
    reservationTimestamps.delete(key);
    if (log) {
      log.warn('reservation_timeout_released', {
        entry_key: key,
        age_ms: now - timestamp,
      });
    }
  }

  return staleKeys.length;
}

/**
 * Initialize the safeguards module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.safeguards] - Safeguards configuration
 * @param {number} [cfg.safeguards.max_concurrent_positions=8] - Maximum open positions
 * @param {number} [cfg.safeguards.min_entry_interval_ms=5000] - Minimum time between entries per symbol
 * @param {number} [cfg.safeguards.max_entries_per_tick=2] - Maximum entries per tick cycle
 * @param {boolean} [cfg.safeguards.duplicate_window_prevention=true] - Prevent re-entry to same window
 * @param {number} [cfg.safeguards.reservation_timeout_ms=30000] - Reservation auto-release timeout
 */
export function init(cfg = {}) {
  if (initialized) {
    return;
  }

  log = child({ module: 'safeguards' });

  // Merge config with defaults
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
 * Check if a position entry is allowed (Story 8-9: Now strategy-aware)
 *
 * Evaluates all safeguard conditions:
 * 1. Duplicate entry check - no re-entry to same {window_id, strategy_id} pair
 * 2. Rate limiting - max 1 entry per symbol per min_entry_interval_ms
 * 3. Concurrent cap - max concurrent open positions
 * 4. Per-tick limit - max entries per tick cycle
 *
 * @param {Object} signal - Entry signal with window_id, symbol, and strategy_id
 * @param {string} signal.window_id - Window identifier
 * @param {string} signal.symbol - Trading symbol (e.g., 'BTC', 'ETH')
 * @param {string} [signal.strategy_id] - Strategy identifier (defaults to 'default')
 * @param {Object[]} openPositions - Array of currently open positions
 * @returns {Object} Result object { allowed: boolean, reason?: string }
 */
export function canEnterPosition(signal, openPositions = []) {
  if (!initialized) {
    // Fail-safe: block entries when not initialized
    return { allowed: false, reason: 'safeguards_not_initialized' };
  }

  // Clean up stale reservations before checking
  cleanupStaleReservations();

  const windowId = signal?.window_id;
  const strategyId = signal?.strategy_id || 'default';
  const symbol = (signal?.symbol || '').toUpperCase();
  const entryKey = makeEntryKey(windowId, strategyId);

  // 1. Duplicate entry check (Story 8-9: Strategy-aware)
  // Check both confirmed entries AND reserved entries
  if (config.duplicate_window_prevention && windowId) {
    if (enteredEntries.has(entryKey) || reservedEntries.has(entryKey)) {
      const result = {
        allowed: false,
        reason: 'duplicate_window_entry',
        details: {
          window_id: windowId,
          strategy_id: strategyId,
          is_reserved: reservedEntries.has(entryKey),
          is_confirmed: enteredEntries.has(entryKey),
        },
      };
      log.info('entry_blocked', {
        reason: result.reason,
        window_id: windowId,
        strategy_id: strategyId,
        symbol,
        entry_key: entryKey,
      });
      return result;
    }
  }

  // 2. Rate limiting - max 1 entry per symbol per interval
  if (symbol && lastEntryTimeBySymbol.has(symbol)) {
    const lastEntryTime = lastEntryTimeBySymbol.get(symbol);
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

  // All checks passed
  return { allowed: true };
}

/**
 * Record a successful entry (Story 8-9: Now strategy-aware)
 *
 * Updates tracking state after a position entry is completed.
 * Must be called after successful order placement.
 *
 * @deprecated Use reserveEntry() + confirmEntry() flow instead for race condition safety
 * @param {string} windowId - Window identifier
 * @param {string} symbol - Trading symbol
 * @param {string} [strategyId='default'] - Strategy identifier
 */
export function recordEntry(windowId, symbol, strategyId = 'default') {
  if (!initialized) {
    return;
  }

  const normalizedSymbol = (symbol || '').toUpperCase();
  const entryKey = makeEntryKey(windowId, strategyId);

  // Track entry as confirmed (Story 8-9)
  if (windowId) {
    enteredEntries.add(entryKey);
    // Also remove from reservations if it was there
    reservedEntries.delete(entryKey);
    reservationTimestamps.delete(entryKey);
  }

  // Record entry time for rate limiting
  if (normalizedSymbol) {
    lastEntryTimeBySymbol.set(normalizedSymbol, Date.now());
  }

  // Increment tick counter
  tickEntryCount++;

  log.info('entry_recorded', {
    window_id: windowId,
    strategy_id: strategyId,
    symbol: normalizedSymbol,
    entry_key: entryKey,
    tick_entry_count: tickEntryCount,
    total_entries: enteredEntries.size,
  });
}

/**
 * Reserve an entry slot before order placement (Story 8-9)
 *
 * Atomically reserves a {window_id, strategy_id} slot to prevent
 * race conditions when concurrent signals arrive.
 *
 * @param {string} windowId - Window identifier
 * @param {string} [strategyId='default'] - Strategy identifier
 * @returns {boolean} True if reservation successful, false if already reserved/entered
 */
export function reserveEntry(windowId, strategyId = 'default') {
  if (!initialized) {
    return false;
  }

  // Clean up stale reservations first
  cleanupStaleReservations();

  const entryKey = makeEntryKey(windowId, strategyId);

  // Check if already entered or reserved
  if (enteredEntries.has(entryKey) || reservedEntries.has(entryKey)) {
    log.info('reservation_blocked', {
      window_id: windowId,
      strategy_id: strategyId,
      entry_key: entryKey,
      is_entered: enteredEntries.has(entryKey),
      is_reserved: reservedEntries.has(entryKey),
    });
    return false;
  }

  // Reserve the slot
  reservedEntries.add(entryKey);
  reservationTimestamps.set(entryKey, Date.now());

  log.info('entry_reserved', {
    window_id: windowId,
    strategy_id: strategyId,
    entry_key: entryKey,
    total_reservations: reservedEntries.size,
  });

  return true;
}

/**
 * Confirm a reserved entry after successful order (Story 8-9)
 *
 * Moves a reservation to confirmed state. Also updates rate limiting.
 *
 * @param {string} windowId - Window identifier
 * @param {string} [strategyId='default'] - Strategy identifier
 * @param {string} [symbol] - Trading symbol for rate limiting
 * @returns {boolean} True if confirmation successful
 */
export function confirmEntry(windowId, strategyId = 'default', symbol) {
  if (!initialized) {
    return false;
  }

  const entryKey = makeEntryKey(windowId, strategyId);

  // Move from reserved to confirmed
  reservedEntries.delete(entryKey);
  reservationTimestamps.delete(entryKey);
  enteredEntries.add(entryKey);

  // Update rate limiting
  const normalizedSymbol = (symbol || '').toUpperCase();
  if (normalizedSymbol) {
    lastEntryTimeBySymbol.set(normalizedSymbol, Date.now());
  }

  // Increment tick counter
  tickEntryCount++;

  log.info('entry_confirmed', {
    window_id: windowId,
    strategy_id: strategyId,
    symbol: normalizedSymbol,
    entry_key: entryKey,
    tick_entry_count: tickEntryCount,
    total_entries: enteredEntries.size,
  });

  return true;
}

/**
 * Release a reserved entry on order failure (Story 8-9)
 *
 * Removes a reservation to allow retry.
 *
 * @param {string} windowId - Window identifier
 * @param {string} [strategyId='default'] - Strategy identifier
 * @returns {boolean} True if release successful
 */
export function releaseEntry(windowId, strategyId = 'default') {
  if (!initialized) {
    return false;
  }

  const entryKey = makeEntryKey(windowId, strategyId);

  const wasReserved = reservedEntries.has(entryKey);
  reservedEntries.delete(entryKey);
  reservationTimestamps.delete(entryKey);

  if (wasReserved) {
    log.info('entry_released', {
      window_id: windowId,
      strategy_id: strategyId,
      entry_key: entryKey,
      total_reservations: reservedEntries.size,
    });
  }

  return wasReserved;
}

/**
 * Remove an entry when position is closed (Story 8-9)
 *
 * Called by position-manager when a position is fully closed.
 * Allows re-entry to the same {window_id, strategy_id} in future.
 *
 * @param {string} windowId - Window identifier
 * @param {string} [strategyId='default'] - Strategy identifier
 * @returns {boolean} True if entry was removed
 */
export function removeEntry(windowId, strategyId = 'default') {
  if (!initialized) {
    return false;
  }

  const entryKey = makeEntryKey(windowId, strategyId);
  const wasPresent = enteredEntries.has(entryKey);

  enteredEntries.delete(entryKey);
  // Also clean up any stale reservations
  reservedEntries.delete(entryKey);
  reservationTimestamps.delete(entryKey);

  if (wasPresent) {
    log.info('entry_removed', {
      window_id: windowId,
      strategy_id: strategyId,
      entry_key: entryKey,
      total_entries: enteredEntries.size,
    });
  }

  return wasPresent;
}

/**
 * Initialize entries from existing positions (Story 8-9, AC2)
 *
 * Called during orchestrator init AFTER position-manager loads.
 * Populates enteredEntries Set from open positions.
 *
 * @param {Object[]} positions - Array of open positions
 * @param {string} positions[].window_id - Window identifier
 * @param {string} [positions[].strategy_id] - Strategy identifier
 * @returns {number} Count of entries initialized
 */
export function initializeFromPositions(positions = []) {
  if (!initialized) {
    if (log) {
      log.warn('initialize_from_positions_skipped', {
        reason: 'safeguards_not_initialized',
      });
    }
    return 0;
  }

  if (!Array.isArray(positions) || positions.length === 0) {
    log.info('initialize_from_positions', {
      count: 0,
      message: 'No positions to initialize from',
    });
    return 0;
  }

  let initializedCount = 0;
  for (const position of positions) {
    const windowId = position.window_id;
    const strategyId = position.strategy_id || 'default';

    if (windowId) {
      const entryKey = makeEntryKey(windowId, strategyId);
      if (!enteredEntries.has(entryKey)) {
        enteredEntries.add(entryKey);
        initializedCount++;
      }
    }
  }

  log.info('initialize_from_positions', {
    positions_provided: positions.length,
    entries_initialized: initializedCount,
    total_entries: enteredEntries.size,
  });

  return initializedCount;
}

/**
 * Reset tick entries counter
 *
 * Should be called at the start of each tick cycle by the orchestrator.
 */
export function resetTickEntries() {
  const previousCount = tickEntryCount;
  tickEntryCount = 0;

  if (log && previousCount > 0) {
    log.debug('tick_entries_reset', { previous_count: previousCount });
  }
}

/**
 * Get current safeguards state (Story 8-9: Enhanced with reservation tracking)
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return {
    initialized,
    config: { ...config },
    stats: {
      entries_confirmed: enteredEntries.size,
      entries_reserved: reservedEntries.size,
      tick_entry_count: tickEntryCount,
      symbols_tracked: lastEntryTimeBySymbol.size,
    },
  };
}

/**
 * Shutdown the safeguards module
 *
 * Clears all tracking state.
 */
export function shutdown() {
  if (log) {
    log.info('safeguards_shutdown', {
      entries_confirmed: enteredEntries.size,
      entries_reserved: reservedEntries.size,
      symbols_tracked: lastEntryTimeBySymbol.size,
    });
  }

  enteredEntries.clear();
  reservedEntries.clear();
  reservationTimestamps.clear();
  lastEntryTimeBySymbol.clear();
  tickEntryCount = 0;
  initialized = false;
  log = null;
}

/**
 * Reset all tracking state (for testing)
 *
 * Clears entered entries, reservations, rate limit tracking, and tick counter
 * without full shutdown.
 */
export function resetState() {
  enteredEntries.clear();
  reservedEntries.clear();
  reservationTimestamps.clear();
  lastEntryTimeBySymbol.clear();
  tickEntryCount = 0;

  if (log) {
    log.debug('safeguards_state_reset');
  }
}

/**
 * Check if a window/strategy pair has been entered this session (Story 8-9: Strategy-aware)
 *
 * @param {string} windowId - Window identifier
 * @param {string} [strategyId='default'] - Strategy identifier
 * @returns {boolean} True if entry was already made (confirmed or reserved)
 */
export function hasEnteredWindow(windowId, strategyId = 'default') {
  const entryKey = makeEntryKey(windowId, strategyId);
  return enteredEntries.has(entryKey) || reservedEntries.has(entryKey);
}

/**
 * Get time since last entry for a symbol
 *
 * @param {string} symbol - Trading symbol
 * @returns {number|null} Milliseconds since last entry, or null if never entered
 */
export function getTimeSinceLastEntry(symbol) {
  const normalizedSymbol = (symbol || '').toUpperCase();
  if (!lastEntryTimeBySymbol.has(normalizedSymbol)) {
    return null;
  }
  return Date.now() - lastEntryTimeBySymbol.get(normalizedSymbol);
}

/**
 * Get current tick entry count
 *
 * @returns {number} Number of entries in current tick
 */
export function getTickEntryCount() {
  return tickEntryCount;
}
