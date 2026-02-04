/**
 * Order Manager Module (V3 Stage 4: DB as single source of truth)
 *
 * Public interface for order lifecycle management.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Place orders with write-ahead logging
 * - Track order status through lifecycle
 * - Query orders by ID, status, or window
 *
 * @module modules/order-manager
 */

import { child } from '../logger/index.js';
import { OrderManagerError, OrderManagerErrorCodes } from './types.js';
import * as logic from './logic.js';
import { getStats, clearStats } from './state.js';

// Module state
let log = null;
let config = null;
let initialized = false;

/**
 * Initialize the order manager module
 *
 * @param {Object} cfg - Configuration object
 * @returns {Promise<void>}
 */
export async function init(cfg) {
  if (initialized) {
    return;
  }

  // Create child logger for this module
  log = child({ module: 'order-manager' });
  config = cfg;

  log.info('module_init_start');

  initialized = true;
  log.info('module_initialized');
}

/**
 * Place a new order
 *
 * @param {Object} params - Order parameters
 * @param {string} params.tokenId - Token to trade
 * @param {string} params.side - 'buy' or 'sell'
 * @param {number} params.size - Size to trade (dollars for buy, shares for sell)
 * @param {number} params.price - Limit price (0.01-0.99)
 * @param {string} params.orderType - Order type (GTC, FOK, IOC)
 * @param {string} params.windowId - Window ID for tracking
 * @param {string} params.marketId - Market ID
 * @returns {Promise<Object>} Order result { orderId, status, latencyMs, intentId }
 * @throws {OrderManagerError} If validation fails or submission fails
 */
export async function placeOrder(params) {
  ensureInitialized();
  return logic.placeOrder(params, log);
}

/**
 * Update order status
 *
 * @param {string} orderId - Order ID
 * @param {string} newStatus - New status
 * @param {Object} [updates={}] - Additional fields to update
 * @returns {Promise<Object>} Updated order
 * @throws {OrderManagerError} If order not found or invalid transition
 */
export async function updateOrderStatus(orderId, newStatus, updates = {}) {
  ensureInitialized();
  return logic.updateOrderStatus(orderId, newStatus, updates, log);
}

/**
 * Get a single order by ID
 *
 * @param {string} orderId - Order ID
 * @returns {Promise<Object|undefined>} Order details or undefined
 */
export async function getOrder(orderId) {
  ensureInitialized();
  return logic.getOrder(orderId);
}

/**
 * Get all open orders
 *
 * @returns {Promise<Object[]>} Array of open orders (status: open or partially_filled)
 */
export async function getOpenOrders() {
  ensureInitialized();
  return logic.getOpenOrders();
}

/**
 * Get orders by window ID
 *
 * @param {string} windowId - Window ID
 * @returns {Promise<Object[]>} Array of orders for the window
 */
export async function getOrdersByWindow(windowId) {
  ensureInitialized();
  return logic.getOrdersByWindow(windowId);
}

/**
 * Cancel an open order
 *
 * Uses write-ahead logging before calling Polymarket API.
 * Records cancellation latency for monitoring.
 *
 * @param {string} orderId - Order ID to cancel
 * @returns {Promise<Object>} Cancel result { orderId, latencyMs, intentId }
 * @throws {OrderManagerError} If order not found, invalid state, or API error
 */
export async function cancelOrder(orderId) {
  ensureInitialized();
  return logic.cancelOrder(orderId, log);
}

/**
 * Handle a partial fill event for an order
 *
 * Updates filled_size, avg_fill_price, and status.
 * Transitions to 'filled' when complete.
 *
 * @param {string} orderId - Order ID
 * @param {number} fillSize - Size of this fill
 * @param {number} fillPrice - Price of this fill
 * @returns {Promise<Object>} Updated order
 * @throws {OrderManagerError} If order not found or invalid state
 */
export async function handlePartialFill(orderId, fillSize, fillPrice) {
  ensureInitialized();
  return logic.handlePartialFill(orderId, fillSize, fillPrice, log);
}

/**
 * Get all partially filled orders
 *
 * @returns {Promise<Object[]>} Array of partially filled orders
 */
export async function getPartiallyFilledOrders() {
  ensureInitialized();
  return logic.getPartiallyFilledOrders();
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

  // Clear session stats
  clearStats();

  config = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {OrderManagerError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_INITIALIZED,
      'Order manager not initialized. Call init() first.'
    );
  }
}

// Re-export types and constants
export {
  OrderManagerError,
  OrderManagerErrorCodes,
  OrderStatus,
  OrderType,
  Side,
} from './types.js';
