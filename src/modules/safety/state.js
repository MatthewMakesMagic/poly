/**
 * Safety Module State Management
 *
 * In-memory state for the safety module.
 * Maintains cached daily performance record for fast access.
 * Manages auto-stop state for drawdown limit enforcement.
 */

import fs from 'fs';
import path from 'path';

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
 * @returns {Object|null} Cached record or null
 */
export function getCachedRecord() {
  return cachedRecord;
}

/**
 * Get the cached date
 * @returns {string|null} Cached date (YYYY-MM-DD) or null
 */
export function getCachedDate() {
  return cachedDate;
}

/**
 * Set the cached daily performance record
 * @param {Object} record - Daily performance record from database
 * @param {string} date - Date string (YYYY-MM-DD)
 */
export function setCachedRecord(record, date) {
  cachedRecord = record;
  cachedDate = date;
}

/**
 * Update fields in the cached record
 * @param {Object} updates - Fields to update
 * @returns {Object} Updated cached record
 */
export function updateCachedRecord(updates) {
  if (!cachedRecord) {
    return null;
  }
  cachedRecord = { ...cachedRecord, ...updates };
  return cachedRecord;
}

/**
 * Clear the cache (e.g., on shutdown or date change)
 */
export function clearCache() {
  cachedRecord = null;
  cachedDate = null;
}

/**
 * Store module configuration
 * @param {Object} config - Module configuration
 */
export function setConfig(config) {
  moduleConfig = config;
}

/**
 * Get module configuration
 * @returns {Object|null} Module configuration
 */
export function getConfig() {
  return moduleConfig;
}

/**
 * Get the starting capital from config
 * @returns {number} Starting capital value
 */
export function getStartingCapital() {
  return moduleConfig?.safety?.startingCapital || 1000;
}

/**
 * Get the daily drawdown limit from config
 * @returns {number} Drawdown limit as decimal (e.g., 0.05 for 5%)
 */
export function getDrawdownLimit() {
  return moduleConfig?.risk?.dailyDrawdownLimit || 0.05;
}

/**
 * Get the drawdown warning threshold from config
 * @returns {number} Warning threshold as decimal (e.g., 0.03 for 3%)
 */
export function getDrawdownWarningThreshold() {
  return moduleConfig?.safety?.drawdownWarningPct || 0.03;
}

/**
 * Get the auto-stop state file path from config
 * @returns {string} Path to auto-stop state file
 */
export function getAutoStopStateFilePath() {
  return moduleConfig?.safety?.autoStopStateFile || './data/auto-stop-state.json';
}

/**
 * Get current auto-stop state
 * @returns {Object} Auto-stop state
 */
export function getAutoStopState() {
  return { ...autoStopState };
}

/**
 * Check if auto-stop is currently active
 * @returns {boolean} True if auto-stopped
 */
export function isAutoStopped() {
  return autoStopState.autoStopped;
}

/**
 * Set auto-stop state
 * @param {boolean} stopped - Whether auto-stop is active
 * @param {string|null} reason - Reason for auto-stop (if stopped=true)
 */
export function setAutoStopped(stopped, reason = null) {
  autoStopState.autoStopped = stopped;
  autoStopState.autoStoppedAt = stopped ? new Date().toISOString() : null;
  autoStopState.autoStopReason = reason;
}

/**
 * Persist auto-stop state to file
 * @param {Object} [log] - Optional logger instance
 */
export function persistAutoStopState(log) {
  const filePath = getAutoStopStateFilePath();
  const today = new Date().toISOString().split('T')[0];

  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = {
      ...autoStopState,
      date: today,
      persistedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    if (log) {
      log.info('auto_stop_state_persisted', { path: filePath, date: today });
    }
  } catch (err) {
    if (log) {
      log.warn('auto_stop_state_persist_failed', { path: filePath, error: err.message });
    }
  }
}

/**
 * Load auto-stop state from file (if exists and current day)
 * @param {Object} [log] - Optional logger instance
 * @returns {Object|null} Loaded state or null if not found/stale
 */
export function loadAutoStopState(log) {
  const filePath = getAutoStopStateFilePath();
  const today = new Date().toISOString().split('T')[0];

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const rawData = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(rawData);

    // Only load if from today (auto-stop resets on new day)
    if (data.date === today) {
      autoStopState = {
        autoStopped: data.autoStopped,
        autoStoppedAt: data.autoStoppedAt,
        autoStopReason: data.autoStopReason,
      };

      if (log) {
        log.info('auto_stop_state_loaded', {
          path: filePath,
          date: today,
          autoStopped: data.autoStopped,
        });
      }

      return data;
    }

    // State is from a previous day - ignore
    if (log) {
      log.info('auto_stop_state_stale', {
        path: filePath,
        stateDate: data.date,
        today,
      });
    }
    return null;
  } catch (err) {
    if (log) {
      log.warn('auto_stop_state_load_failed', { path: filePath, error: err.message });
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
 * Delete auto-stop state file
 * @param {Object} [log] - Optional logger instance
 */
export function deleteAutoStopStateFile(log) {
  const filePath = getAutoStopStateFilePath();

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      if (log) {
        log.info('auto_stop_state_file_deleted', { path: filePath });
      }
    }
  } catch (err) {
    if (log) {
      log.warn('auto_stop_state_file_delete_failed', { path: filePath, error: err.message });
    }
  }
}

/**
 * Check if we've already warned at this drawdown level
 * Uses 0.5% buckets to avoid excessive warnings
 * @param {number} currentDrawdownPct - Current drawdown percentage
 * @returns {boolean} True if already warned at this level
 */
export function hasWarnedAtLevel(currentDrawdownPct) {
  // Round to nearest 0.5% bucket
  const bucket = Math.floor(currentDrawdownPct * 200) / 200;
  return warnedLevels.has(bucket);
}

/**
 * Mark that we've warned at this drawdown level
 * @param {number} currentDrawdownPct - Current drawdown percentage
 */
export function markWarnedAtLevel(currentDrawdownPct) {
  const bucket = Math.floor(currentDrawdownPct * 200) / 200;
  warnedLevels.add(bucket);
}

/**
 * Clear warning levels (e.g., on new day or reset)
 */
export function clearWarnedLevels() {
  warnedLevels.clear();
}

/**
 * Get module state snapshot
 * @returns {Object} Current state
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
