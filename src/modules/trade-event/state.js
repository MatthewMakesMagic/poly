/**
 * Trade Event Module State Management
 *
 * In-memory state for the trade event module.
 * Maintains initialization state and configuration.
 */

// Module configuration
let moduleConfig = null;

// Initialization state
let initialized = false;

// Statistics
let stats = {
  totalEvents: 0,
  signalCount: 0,
  entryCount: 0,
  exitCount: 0,
  alertCount: 0,
};

/**
 * Check if module is initialized
 * @returns {boolean} True if initialized
 */
export function isInitialized() {
  return initialized;
}

/**
 * Set initialization state
 * @param {boolean} state - Initialization state
 */
export function setInitialized(state) {
  initialized = state;
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
 * Increment event count by type
 * @param {string} eventType - Event type (signal, entry, exit, alert)
 */
export function incrementEventCount(eventType) {
  stats.totalEvents++;
  switch (eventType) {
    case 'signal':
      stats.signalCount++;
      break;
    case 'entry':
      stats.entryCount++;
      break;
    case 'exit':
      stats.exitCount++;
      break;
    case 'alert':
    case 'divergence':
      stats.alertCount++;
      break;
  }
}

/**
 * Get current statistics
 * @returns {Object} Current stats
 */
export function getStats() {
  return { ...stats };
}

/**
 * Reset all state (for shutdown)
 */
export function resetState() {
  moduleConfig = null;
  initialized = false;
  stats = {
    totalEvents: 0,
    signalCount: 0,
    entryCount: 0,
    exitCount: 0,
    alertCount: 0,
  };
}

/**
 * Get module state snapshot
 * @returns {Object} Current state
 */
export function getStateSnapshot() {
  return {
    initialized,
    hasConfig: moduleConfig !== null,
    stats: getStats(),
  };
}
