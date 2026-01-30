/**
 * Module Template - Example module with standard interface
 *
 * Copy this folder to create a new module:
 *   cp -r src/modules/_template src/modules/your-module-name
 *
 * All modules MUST export:
 * - init(config) - Async initialization
 * - getState() - Returns current module state
 * - shutdown() - Async graceful shutdown
 */

import { PolyError, ErrorCodes } from '../../types/index.js';

// Module-level state (internal)
let state = {
  initialized: false,
  config: null,
};

/**
 * Initialize the module with configuration
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 * @throws {ConfigError} If configuration is invalid
 */
export async function init(config) {
  if (state.initialized) {
    throw new PolyError(
      ErrorCodes.CONFIG_INVALID,
      'Module already initialized',
      { module: '_template' }
    );
  }

  // Validate config
  if (!config) {
    throw new PolyError(
      ErrorCodes.CONFIG_MISSING,
      'Configuration required',
      { module: '_template' }
    );
  }

  // Store config and mark initialized
  state.config = config;
  state.initialized = true;

  // Perform any async initialization here
  // e.g., connect to databases, start timers, etc.
}

/**
 * Get current module state
 *
 * Used for debugging, monitoring, and reconciliation.
 * Should return a snapshot that doesn't expose internal references.
 *
 * @returns {Object} Current state snapshot
 */
export function getState() {
  return {
    initialized: state.initialized,
    // Add other state properties here
    // DO NOT include sensitive data like API keys
  };
}

/**
 * Gracefully shutdown the module
 *
 * Clean up resources, close connections, save state.
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (!state.initialized) {
    return; // Already shut down or never initialized
  }

  // Perform cleanup here
  // e.g., close connections, flush buffers, etc.

  // Reset state
  state = {
    initialized: false,
    config: null,
  };
}
