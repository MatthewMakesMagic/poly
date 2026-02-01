/**
 * Position Entry Safeguards Module (Story 8-7)
 *
 * Enforces entry safeguards to prevent:
 * - Duplicate window entries within a session
 * - Rapid-fire entries (rate limiting)
 * - Excessive concurrent positions
 * - Too many entries per tick cycle
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
};
let initialized = false;

// Tracking state
let enteredWindowIds = new Set();                    // Windows entered this session
let lastEntryTimeBySymbol = new Map();               // Symbol -> timestamp
let tickEntryCount = 0;                              // Entries this tick cycle

/**
 * Initialize the safeguards module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.safeguards] - Safeguards configuration
 * @param {number} [cfg.safeguards.max_concurrent_positions=8] - Maximum open positions
 * @param {number} [cfg.safeguards.min_entry_interval_ms=5000] - Minimum time between entries per symbol
 * @param {number} [cfg.safeguards.max_entries_per_tick=2] - Maximum entries per tick cycle
 * @param {boolean} [cfg.safeguards.duplicate_window_prevention=true] - Prevent re-entry to same window
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
    };
  }

  initialized = true;
  log.info('safeguards_initialized', {
    max_concurrent_positions: config.max_concurrent_positions,
    min_entry_interval_ms: config.min_entry_interval_ms,
    max_entries_per_tick: config.max_entries_per_tick,
    duplicate_window_prevention: config.duplicate_window_prevention,
  });
}

/**
 * Check if a position entry is allowed
 *
 * Evaluates all safeguard conditions:
 * 1. Duplicate window check - no re-entry to same window_id within session
 * 2. Rate limiting - max 1 entry per symbol per min_entry_interval_ms
 * 3. Concurrent cap - max concurrent open positions
 * 4. Per-tick limit - max entries per tick cycle
 *
 * @param {Object} signal - Entry signal with window_id and symbol
 * @param {string} signal.window_id - Window identifier
 * @param {string} signal.symbol - Trading symbol (e.g., 'BTC', 'ETH')
 * @param {Object[]} openPositions - Array of currently open positions
 * @returns {Object} Result object { allowed: boolean, reason?: string }
 */
export function canEnterPosition(signal, openPositions = []) {
  if (!initialized) {
    // Fail-safe: block entries when not initialized
    return { allowed: false, reason: 'safeguards_not_initialized' };
  }

  const windowId = signal?.window_id;
  const symbol = (signal?.symbol || '').toUpperCase();

  // 1. Duplicate window check
  if (config.duplicate_window_prevention && windowId && enteredWindowIds.has(windowId)) {
    const result = { allowed: false, reason: 'duplicate_window_entry' };
    log.info('entry_blocked', {
      reason: result.reason,
      window_id: windowId,
      symbol,
    });
    return result;
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
 * Record a successful entry
 *
 * Updates tracking state after a position entry is completed.
 * Must be called after successful order placement.
 *
 * @param {string} windowId - Window identifier
 * @param {string} symbol - Trading symbol
 */
export function recordEntry(windowId, symbol) {
  if (!initialized) {
    return;
  }

  const normalizedSymbol = (symbol || '').toUpperCase();

  // Track window as entered
  if (windowId) {
    enteredWindowIds.add(windowId);
  }

  // Record entry time for rate limiting
  if (normalizedSymbol) {
    lastEntryTimeBySymbol.set(normalizedSymbol, Date.now());
  }

  // Increment tick counter
  tickEntryCount++;

  log.info('entry_recorded', {
    window_id: windowId,
    symbol: normalizedSymbol,
    tick_entry_count: tickEntryCount,
    total_windows_entered: enteredWindowIds.size,
  });
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
 * Get current safeguards state
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return {
    initialized,
    config: { ...config },
    stats: {
      windows_entered: enteredWindowIds.size,
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
      windows_entered: enteredWindowIds.size,
      symbols_tracked: lastEntryTimeBySymbol.size,
    });
  }

  enteredWindowIds.clear();
  lastEntryTimeBySymbol.clear();
  tickEntryCount = 0;
  initialized = false;
  log = null;
}

/**
 * Reset all tracking state (for testing)
 *
 * Clears entered windows, rate limit tracking, and tick counter
 * without full shutdown.
 */
export function resetState() {
  enteredWindowIds.clear();
  lastEntryTimeBySymbol.clear();
  tickEntryCount = 0;

  if (log) {
    log.debug('safeguards_state_reset');
  }
}

/**
 * Check if a window has been entered this session
 *
 * @param {string} windowId - Window identifier
 * @returns {boolean} True if window was already entered
 */
export function hasEnteredWindow(windowId) {
  return enteredWindowIds.has(windowId);
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
