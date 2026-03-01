/**
 * Position Manager Module (V3 Stage 4: DB as single source of truth)
 *
 * Public interface for position lifecycle management.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Track open positions with write-ahead logging
 * - Query positions by ID or status
 * - Update position prices for unrealized P&L calculation
 *
 * All reads go directly to PostgreSQL (no in-memory cache).
 *
 * @module modules/position-manager
 */

import { child } from '../logger/index.js';
import { PositionManagerError, PositionManagerErrorCodes } from './types.js';
import * as logic from './logic.js';
import { getStats, clearState, calculateTotalExposure, getLastReconciliation } from './state.js';
import {
  transitionState as transitionLifecycleState,
  evaluateExit as evaluateExitLogic,
  isLocked as isLifecycleLocked,
  isMonitoring as isLifecycleMonitoring,
} from './lifecycle.js';

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

  // No cache to load - DB is single source of truth

  initialized = true;
  log.info('module_initialized');
}

/**
 * Add a new position with optional limit checking
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
 * @throws {PositionManagerError} If validation fails, limits exceeded, or database error
 */
export async function addPosition(params) {
  ensureInitialized();
  // Pass risk config if available for limit checking
  const riskConfig = config?.risk || null;
  return logic.addPosition(params, log, riskConfig);
}

/**
 * Get a single position by ID
 *
 * @param {number} positionId - Position ID
 * @returns {Promise<Object|undefined>} Position details including unrealized_pnl or undefined
 */
export async function getPosition(positionId) {
  ensureInitialized();
  return logic.getPosition(positionId);
}

/**
 * Get all open positions
 *
 * @param {string} [mode] - Optional mode filter (LIVE, PAPER, DRY_RUN). If omitted, returns all modes.
 * @returns {Promise<Object[]>} Array of open positions with unrealized_pnl
 */
export async function getPositions(mode) {
  ensureInitialized();
  return logic.getPositions(mode);
}

/**
 * Close a position with write-ahead logging
 *
 * @param {number} positionId - Position ID
 * @param {Object} params - Close parameters
 * @param {boolean} [params.emergency=false] - Use market order for emergency close
 * @param {number} [params.closePrice] - Override close price (optional)
 * @returns {Promise<Object>} Closed position with pnl
 * @throws {PositionManagerError} If position not found or invalid status
 */
export async function closePosition(positionId, params = {}) {
  ensureInitialized();
  return logic.closePosition(positionId, params, log);
}

/**
 * Update position price
 *
 * @param {number} positionId - Position ID
 * @param {number} newPrice - New current price
 * @returns {Promise<Object>} Updated position with unrealized_pnl
 * @throws {PositionManagerError} If position not found
 */
export async function updatePrice(positionId, newPrice) {
  ensureInitialized();
  return logic.updatePrice(positionId, newPrice, log);
}

/**
 * Reconcile local position state with exchange
 *
 * Compares local database positions with exchange balances and reports
 * divergences. Updates exchange_verified_at for matching positions.
 *
 * @param {Object} polymarketClient - Initialized Polymarket client with getBalance()
 * @returns {Promise<Object>} Reconciliation result { verified, divergences, timestamp, success }
 */
export async function reconcile(polymarketClient) {
  ensureInitialized();
  return logic.reconcile(polymarketClient, log);
}

/**
 * Get current total exposure across all open positions
 *
 * @returns {Promise<number>} Total exposure (sum of size * entry_price for all open positions)
 */
export async function getCurrentExposure() {
  ensureInitialized();
  return calculateTotalExposure();
}

/**
 * Get current module state
 *
 * @returns {Promise<Object>} Current state including initialization status, stats, limits, and reconciliation
 */
export async function getState() {
  const stats = initialized ? await getStats() : { positions: { open: 0, closed: 0 }, stats: { totalOpened: 0, totalClosed: 0, totalPnl: 0 } };

  const state = {
    initialized,
    ...stats,
  };

  // Add limits info if config available
  if (config?.risk) {
    const currentExposure = initialized ? await calculateTotalExposure() : 0;
    state.limits = {
      maxPositionSize: config.risk.maxPositionSize,
      maxExposure: config.risk.maxExposure,
      currentExposure,
      positionLimitPerMarket: config.risk.positionLimitPerMarket,
    };
  }

  // Add last reconciliation info
  const lastRecon = getLastReconciliation();
  if (lastRecon) {
    state.lastReconciliation = lastRecon;
  }

  return state;
}

/**
 * Transition a position's lifecycle state
 *
 * @param {number} positionId - Position ID
 * @param {string} toState - Target lifecycle state
 * @param {Object} [context] - Additional context for logging
 * @returns {Promise<Object>} Updated position row
 * @throws {PositionManagerError} If transition is invalid
 */
export async function transitionLifecycle(positionId, toState, context = {}) {
  ensureInitialized();
  return transitionLifecycleState(positionId, toState, log, context);
}

/**
 * Evaluate exit conditions for a position (single decision function)
 *
 * Checks stop-loss, take-profit, and expiry in priority order.
 * Only evaluates positions in MONITORING state.
 *
 * @param {Object} position - Position object
 * @param {number} currentPrice - Current market price
 * @param {Object} modules - { stopLoss, takeProfit, windowExpiry }
 * @param {Object} [windowData] - Window resolution data
 * @param {Object} [options] - Additional options
 * @returns {Object|null} Exit trigger or null
 */
export function evaluateExit(position, currentPrice, modules, windowData, options) {
  ensureInitialized();
  return evaluateExitLogic(position, currentPrice, modules, windowData, options);
}

/**
 * Check if a position is in a locked lifecycle state
 *
 * @param {Object} position - Position with lifecycle_state
 * @returns {boolean}
 */
export function isPositionLocked(position) {
  return isLifecycleLocked(position.lifecycle_state);
}

/**
 * Check if a position is being monitored (eligible for exit evaluation)
 *
 * @param {Object} position - Position with lifecycle_state
 * @returns {boolean}
 */
export function isPositionMonitoring(position) {
  return isLifecycleMonitoring(position.lifecycle_state);
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

  // Clear state (reconciliation data)
  clearState();

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

export { LifecycleState } from './lifecycle.js';
