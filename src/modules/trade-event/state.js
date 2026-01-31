/**
 * Trade Event Module State Management
 *
 * In-memory state for the trade event module.
 * Maintains initialization state and configuration.
 */

import { EventEmitter } from 'events';

// Event emitter for real-time event subscriptions (Story E.1 - Scout)
export const eventEmitter = new EventEmitter();

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

// ═══════════════════════════════════════════════════════════════════════════
// EVENT SUBSCRIPTION (Story E.1 - Scout Real-Time Monitoring)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Subscribe to trade events
 *
 * Available event types: 'signal', 'entry', 'exit', 'alert', 'divergence'
 *
 * @param {string} eventType - Event type to subscribe to
 * @param {Function} callback - Callback function receiving event data
 * @returns {Function} Unsubscribe function
 */
export function subscribe(eventType, callback) {
  eventEmitter.on(eventType, callback);
  return () => eventEmitter.off(eventType, callback);
}

/**
 * Subscribe to all trade events
 *
 * @param {Function} callback - Callback function receiving {type, data}
 * @returns {Function} Unsubscribe function
 */
export function subscribeAll(callback) {
  const handler = (type) => (data) => callback({ type, data });

  const types = ['signal', 'entry', 'exit', 'alert', 'divergence'];
  const handlers = types.map(type => {
    const h = handler(type);
    eventEmitter.on(type, h);
    return { type, handler: h };
  });

  return () => {
    handlers.forEach(({ type, handler: h }) => {
      eventEmitter.off(type, h);
    });
  };
}

/**
 * Emit a trade event
 *
 * @param {string} eventType - Event type
 * @param {Object} data - Event data
 */
export function emitEvent(eventType, data) {
  eventEmitter.emit(eventType, data);
}
