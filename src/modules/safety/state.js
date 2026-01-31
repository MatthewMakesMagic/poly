/**
 * Safety Module State Management
 *
 * In-memory state for the safety module.
 * Maintains cached daily performance record for fast access.
 */

// Cached daily performance record
let cachedRecord = null;
let cachedDate = null;

// Module configuration
let moduleConfig = null;

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
 * Get module state snapshot
 * @returns {Object} Current state
 */
export function getStateSnapshot() {
  return {
    hasCachedRecord: cachedRecord !== null,
    cachedDate,
    startingCapital: getStartingCapital(),
  };
}
