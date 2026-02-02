/**
 * Orchestrator Module State
 *
 * Manages module references, loop state, and initialization order.
 * All coordination flows through the orchestrator - modules never import each other.
 */

import { OrchestratorState } from './types.js';

/**
 * Error timestamps for 1-minute error counting
 * Used by health endpoint to report error_count_1m
 */
let errorTimestamps = [];

/**
 * Maximum number of error timestamps to keep in memory
 * Prevents memory exhaustion during error storms (100 errors/sec = 30k in 5 min)
 */
const MAX_ERROR_TIMESTAMPS = 1000;

/**
 * Module initialization order - critical for dependency management
 *
 * Order:
 * 1. Logger - initialized before orchestrator by app entry point
 * 2. Persistence - needed for write-ahead logging
 * 3. Polymarket client - API access
 * 4. Spot client - price feeds
 * 5. Position manager - depends on persistence
 * 6. Order manager - depends on persistence, polymarket
 *
 * Future modules will be added here as they're implemented.
 */
export const MODULE_INIT_ORDER = [
  // Logger is initialized before orchestrator by app entry point, not managed here
  // Launch-config - reads launch manifest, must be first to provide strategy filter
  { name: 'launch-config', module: null, configKey: null },
  { name: 'persistence', module: null, configKey: 'database' },
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  { name: 'spot', module: null, configKey: 'spot' },
  // TEMP SOLUTION: Window manager for fetching active 15-min markets
  { name: 'window-manager', module: null, configKey: null },
  { name: 'position-manager', module: null, configKey: null },
  // Virtual position manager - PAPER mode position tracking for stop-loss/take-profit
  { name: 'virtual-position-manager', module: null, configKey: null },
  // Safeguards module - entry rate limiting, duplicate prevention (Story 8-7)
  { name: 'safeguards', module: null, configKey: null },
  { name: 'order-manager', module: null, configKey: null },
  // Safety module - after order-manager so it can reference it for auto-stop
  { name: 'safety', module: null, configKey: null },
  // Strategy modules
  { name: 'strategy-evaluator', module: null, configKey: null },
  { name: 'position-sizer', module: null, configKey: null },
  // Exit condition modules
  { name: 'stop-loss', module: null, configKey: null },
  { name: 'take-profit', module: null, configKey: null },
  { name: 'window-expiry', module: null, configKey: null },
  // Monitoring modules (Epic 5)
  { name: 'trade-event', module: null, configKey: null },
];

/**
 * Create initial state object
 *
 * @returns {Object} Initial orchestrator state
 */
export function createInitialState() {
  return {
    state: OrchestratorState.STOPPED,
    modules: {},
    loopState: null,
    errorCount: 0,
    recoveryCount: 0,
    lastError: null,
    inFlightOperations: 0,
    initializationOrder: [],
    startedAt: null,
    stoppedAt: null,
  };
}

/**
 * Module reference storage
 * Keeps track of loaded module instances for coordination
 */
let moduleRefs = {};

/**
 * Get a module reference by name
 *
 * @param {string} name - Module name
 * @returns {Object|null} Module reference or null
 */
export function getModule(name) {
  return moduleRefs[name] || null;
}

/**
 * Set a module reference
 *
 * @param {string} name - Module name
 * @param {Object} moduleInstance - Module instance
 */
export function setModule(name, moduleInstance) {
  moduleRefs[name] = moduleInstance;
}

/**
 * Get all module references
 *
 * @returns {Object} Object with module names as keys
 */
export function getAllModules() {
  return { ...moduleRefs };
}

/**
 * Clear all module references
 */
export function clearModules() {
  moduleRefs = {};
}

/**
 * Get module count
 *
 * @returns {number} Number of loaded modules
 */
export function getModuleCount() {
  return Object.keys(moduleRefs).length;
}

/**
 * Record an error timestamp for 1-minute error counting
 *
 * Called by orchestrator's handleLoopError() to track errors.
 * Timestamps older than 5 minutes are pruned to save memory.
 * Also enforces a hard cap to prevent memory exhaustion during error storms.
 */
export function recordError() {
  const now = Date.now();
  errorTimestamps.push(now);

  // Prune old timestamps (older than 5 minutes to save memory)
  errorTimestamps = errorTimestamps.filter((ts) => now - ts < 5 * 60 * 1000);

  // Hard cap to prevent memory exhaustion during error storms
  // Keep only the most recent timestamps if over limit
  if (errorTimestamps.length > MAX_ERROR_TIMESTAMPS) {
    errorTimestamps = errorTimestamps.slice(-MAX_ERROR_TIMESTAMPS);
  }
}

/**
 * Get count of errors in the last minute
 *
 * @returns {number} Number of errors recorded in the last 60 seconds
 */
export function getErrorCount1m() {
  const oneMinuteAgo = Date.now() - 60 * 1000;
  return errorTimestamps.filter((ts) => ts > oneMinuteAgo).length;
}

/**
 * Clear all error timestamps (for testing)
 */
export function clearErrorTimestamps() {
  errorTimestamps = [];
}
