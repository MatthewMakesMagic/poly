/**
 * Orchestrator Module State
 *
 * Manages module references, loop state, and initialization order.
 * All coordination flows through the orchestrator - modules never import each other.
 */

import { OrchestratorState } from './types.js';

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
  { name: 'persistence', module: null, configKey: 'database' },
  { name: 'polymarket', module: null, configKey: 'polymarket' },
  { name: 'spot', module: null, configKey: 'spot' },
  { name: 'position-manager', module: null, configKey: null },
  { name: 'order-manager', module: null, configKey: null },
  // Strategy modules
  { name: 'strategy-evaluator', module: null, configKey: null },
  { name: 'position-sizer', module: null, configKey: null },
  // Exit condition modules
  { name: 'stop-loss', module: null, configKey: null },
  { name: 'take-profit', module: null, configKey: null },
  { name: 'window-expiry', module: null, configKey: null },
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
