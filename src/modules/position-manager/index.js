/**
 * Position Manager Module
 *
 * Public interface for position lifecycle management.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Track open positions with write-ahead logging
 * - Query positions by ID or status
 * - Update position prices for unrealized P&L calculation
 *
 * @module modules/position-manager
 */

import { child } from '../logger/index.js';
import { PositionManagerError, PositionManagerErrorCodes } from './types.js';
import * as logic from './logic.js';
import { getStats, clearCache } from './state.js';

// Module state
let log = null;
let config = null;
let initialized = false;

/**
 * Initialize the position manager module
 *
 * @param {Object} cfg - Configuration object
 * @returns {Promise<void>}
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'position-manager' });
  config = cfg;

  log.info('module_init_start');

  // Load positions from database into cache
  logic.loadPositionsFromDb(log);

  initialized = true;
  log.info('module_initialized');
}

/**
 * Add a new position
 *
 * @param {Object} params - Position parameters
 * @param {string} params.windowId - Window ID
 * @param {string} params.marketId - Market ID
 * @param {string} params.tokenId - Token ID
 * @param {string} params.side - 'long' or 'short'
 * @param {number} params.size - Position size
 * @param {number} params.entryPrice - Entry price
 * @param {string} params.strategyId - Strategy ID
 * @returns {Promise<Object>} Created position with id
 * @throws {PositionManagerError} If validation fails or database error
 */
export async function addPosition(params) {
  ensureInitialized();
  return logic.addPosition(params, log);
}

/**
 * Get a single position by ID
 *
 * @param {number} positionId - Position ID
 * @returns {Object|undefined} Position details including unrealized_pnl or undefined
 */
export function getPosition(positionId) {
  ensureInitialized();
  return logic.getPosition(positionId);
}

/**
 * Get all open positions
 *
 * @returns {Object[]} Array of open positions with unrealized_pnl
 */
export function getPositions() {
  ensureInitialized();
  return logic.getPositions();
}

/**
 * Close a position (stub - full implementation in Story 2.6)
 *
 * @param {number} positionId - Position ID
 * @param {Object} params - Close parameters
 * @returns {Promise<Object>} Closed position
 */
export async function closePosition(positionId, params) {
  ensureInitialized();
  // Stub for Story 2.6
  throw new PositionManagerError(
    PositionManagerErrorCodes.NOT_FOUND,
    'closePosition() will be implemented in Story 2.6',
    { positionId, params }
  );
}

/**
 * Update position price
 *
 * @param {number} positionId - Position ID
 * @param {number} newPrice - New current price
 * @returns {Object} Updated position with unrealized_pnl
 * @throws {PositionManagerError} If position not found
 */
export function updatePrice(positionId, newPrice) {
  ensureInitialized();
  return logic.updatePrice(positionId, newPrice, log);
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including initialization status and stats
 */
export function getState() {
  return {
    initialized,
    ...getStats(),
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  // Clear the cache
  clearCache();

  config = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {PositionManagerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new PositionManagerError(
      PositionManagerErrorCodes.NOT_INITIALIZED,
      'Position manager not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  PositionManagerError,
  PositionManagerErrorCodes,
  PositionStatus,
  Side,
} from './types.js';
