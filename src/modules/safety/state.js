/**
 * Safety Module State Management (V3 Stage 4: DB persistence)
 *
 * In-memory state for the safety module.
 * Maintains cached daily performance record for fast access.
 * Auto-stop state persisted to PostgreSQL instead of filesystem.
 */

import persistence from '../../persistence/index.js';

// Cached daily performance record
let cachedRecord = null;
let cachedDate = null;

// Module configuration
let moduleConfig = null;

// Auto-stop state
let autoStopState = {
  autoStopped: false,
  autoStoppedAt: null,
  autoStopReason: null,
};

// Warning level tracking (to avoid spam)
let warnedLevels = new Set();

/**
 * Get the cached daily performance record
 */
export function getCachedRecord() {
  return cachedRecord;
}

/**
 * Get the cached date
 */
export function getCachedDate() {
  return cachedDate;
}

/**
 * Set the cached daily performance record
 */
export function setCachedRecord(record, date) {
  cachedRecord = record;
  cachedDate = date;
}

/**
 * Update fields in the cached record
 */
export function updateCachedRecord(updates) {
  if (!cachedRecord) {
    return null;
  }
  cachedRecord = { ...cachedRecord, ...updates };
  return cachedRecord;
}

/**
 * Clear the cache
 */
export function clearCache() {
  cachedRecord = null;
  cachedDate = null;
}

/**
 * Store module configuration
 */
export function setConfig(config) {
  moduleConfig = config;
}

/**
 * Get module configuration
 */
export function getConfig() {
  return moduleConfig;
}

/**
 * Get the starting capital from config
 */
export function getStartingCapital() {
  return moduleConfig?.safety?.startingCapital || 1000;
}

/**
 * Get the daily drawdown limit from config
 */
export function getDrawdownLimit() {
  return moduleConfig?.risk?.dailyDrawdownLimit || 0.05;
}

/**
 * Get the drawdown warning threshold from config
 */
export function getDrawdownWarningThreshold() {
  return moduleConfig?.safety?.drawdownWarningPct || 0.03;
}

/**
 * Get current auto-stop state
 */
export function getAutoStopState() {
  return { ...autoStopState };
}

/**
 * Check if auto-stop is currently active
 */
export function isAutoStopped() {
  return autoStopState.autoStopped;
}

/**
 * Set auto-stop state
 */
export function setAutoStopped(stopped, reason = null) {
  autoStopState.autoStopped = stopped;
  autoStopState.autoStoppedAt = stopped ? new Date().toISOString() : null;
  autoStopState.autoStopReason = reason;
}

/**
 * Persist auto-stop state to database
 */
export async function persistAutoStopState(log) {
  const today = new Date().toISOString().split('T')[0];

  try {
    await persistence.run(
      `UPDATE auto_stop_state
       SET auto_stopped = $1, auto_stopped_at = $2, auto_stop_reason = $3, date = $4, updated_at = NOW()
       WHERE id = 1`,
      [autoStopState.autoStopped, autoStopState.autoStoppedAt, autoStopState.autoStopReason, today]
    );

    if (log) {
      log.info('auto_stop_state_persisted', { date: today });
    }
  } catch (err) {
    if (log) {
      log.warn('auto_stop_state_persist_failed', { error: err.message });
    }
  }
}

/**
 * Load auto-stop state from database (if exists and current day)
 */
export async function loadAutoStopState(log) {
  const today = new Date().toISOString().split('T')[0];

  try {
    const data = await persistence.get(
      `SELECT * FROM auto_stop_state WHERE id = 1`
    );

    if (!data) {
      return null;
    }

    // Only load if from today (auto-stop resets on new day)
    if (data.date === today) {
      autoStopState = {
        autoStopped: data.auto_stopped,
        autoStoppedAt: data.auto_stopped_at,
        autoStopReason: data.auto_stop_reason,
      };

      if (log) {
        log.info('auto_stop_state_loaded', {
          date: today,
          autoStopped: data.auto_stopped,
        });
      }

      return {
        autoStopped: data.auto_stopped,
        autoStoppedAt: data.auto_stopped_at,
        autoStopReason: data.auto_stop_reason,
        date: data.date,
      };
    }

    // State is from a previous day - ignore
    if (log) {
      log.info('auto_stop_state_stale', {
        stateDate: data.date,
        today,
      });
    }
    return null;
  } catch (err) {
    if (log) {
      log.warn('auto_stop_state_load_failed', { error: err.message });
    }
    return null;
  }
}

/**
 * Clear auto-stop state (reset)
 */
export function clearAutoStopState() {
  autoStopState = {
    autoStopped: false,
    autoStoppedAt: null,
    autoStopReason: null,
  };
  warnedLevels.clear();
}

/**
 * Reset auto-stop state in database
 */
export async function resetAutoStopStateInDb(log) {
  try {
    await persistence.run(
      `UPDATE auto_stop_state
       SET auto_stopped = FALSE, auto_stopped_at = NULL, auto_stop_reason = NULL, updated_at = NOW()
       WHERE id = 1`
    );
    if (log) {
      log.info('auto_stop_state_db_reset');
    }
  } catch (err) {
    if (log) {
      log.warn('auto_stop_state_db_reset_failed', { error: err.message });
    }
  }
}

/**
 * Check if we've already warned at this drawdown level
 */
export function hasWarnedAtLevel(currentDrawdownPct) {
  const bucket = Math.floor(currentDrawdownPct * 200) / 200;
  return warnedLevels.has(bucket);
}

/**
 * Mark that we've warned at this drawdown level
 */
export function markWarnedAtLevel(currentDrawdownPct) {
  const bucket = Math.floor(currentDrawdownPct * 200) / 200;
  warnedLevels.add(bucket);
}

/**
 * Clear warning levels
 */
export function clearWarnedLevels() {
  warnedLevels.clear();
}

/**
 * Get module state snapshot
 */
export function getStateSnapshot() {
  return {
    hasCachedRecord: cachedRecord !== null,
    cachedDate,
    startingCapital: getStartingCapital(),
    autoStopped: autoStopState.autoStopped,
    autoStoppedAt: autoStopState.autoStoppedAt,
    autoStopReason: autoStopState.autoStopReason,
  };
}
