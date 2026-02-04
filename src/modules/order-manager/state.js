/**
 * Order Manager State (V3 Stage 4: DB as single source of truth)
 *
 * All order queries go directly to PostgreSQL.
 * Session-level stats kept in memory for monitoring.
 */

import persistence from '../../persistence/index.js';
import { OrderStatus } from './types.js';

/**
 * Session-level statistics (monitoring only, not trading state)
 */
const stats = {
  ordersPlaced: 0,
  ordersFilled: 0,
  ordersCancelled: 0,
  ordersRejected: 0,
  ordersPartiallyFilled: 0,
  totalLatencyMs: 0,
  cancelLatencyMs: 0,
  cancelCount: 0,
  lastOrderTime: null,
};

/**
 * Get an order from the DB
 * @param {string} orderId - Order ID
 * @returns {Promise<Object|undefined>} Order object or undefined
 */
export async function getOrder(orderId) {
  return persistence.get('SELECT * FROM orders WHERE order_id = $1', [orderId]);
}

/**
 * Get open orders from DB
 * @returns {Promise<Object[]>} Array of open orders
 */
export async function getOpenOrders() {
  return persistence.all(
    `SELECT * FROM orders WHERE status IN ($1, $2)`,
    [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED]
  );
}

/**
 * Get orders by window ID from DB
 * @param {string} windowId - Window ID
 * @returns {Promise<Object[]>} Array of orders for the window
 */
export async function getOrdersByWindow(windowId) {
  return persistence.all(
    'SELECT * FROM orders WHERE window_id = $1',
    [windowId]
  );
}

/**
 * Record a new order placement in stats
 */
export function recordOrderPlaced() {
  stats.ordersPlaced++;
  stats.lastOrderTime = new Date().toISOString();
}

/**
 * Record status change in stats
 * @param {string} newStatus - New order status
 */
export function recordStatusChange(newStatus) {
  if (newStatus === OrderStatus.FILLED) {
    stats.ordersFilled++;
  } else if (newStatus === OrderStatus.CANCELLED) {
    stats.ordersCancelled++;
  } else if (newStatus === OrderStatus.REJECTED) {
    stats.ordersRejected++;
  }
}

/**
 * Record latency for statistics
 * @param {number} latencyMs - Latency in milliseconds
 */
export function recordLatency(latencyMs) {
  stats.totalLatencyMs += latencyMs;
}

/**
 * Record cancel operation latency
 * @param {number} latencyMs - Latency in milliseconds
 */
export function recordCancelLatency(latencyMs) {
  stats.cancelLatencyMs += latencyMs;
  stats.cancelCount++;
}

/**
 * Record a partial fill event
 */
export function recordPartialFill() {
  stats.ordersPartiallyFilled++;
}

/**
 * Get current state statistics
 * @returns {Object} State statistics
 */
export function getStats() {
  const avgLatencyMs =
    stats.ordersPlaced > 0
      ? Math.round(stats.totalLatencyMs / stats.ordersPlaced)
      : 0;
  const avgCancelLatencyMs =
    stats.cancelCount > 0
      ? Math.round(stats.cancelLatencyMs / stats.cancelCount)
      : 0;

  return {
    ordersPlaced: stats.ordersPlaced,
    ordersFilled: stats.ordersFilled,
    ordersCancelled: stats.ordersCancelled,
    ordersRejected: stats.ordersRejected,
    ordersPartiallyFilled: stats.ordersPartiallyFilled,
    avgLatencyMs,
    avgCancelLatencyMs,
    lastOrderTime: stats.lastOrderTime,
  };
}

/**
 * Clear stats (for shutdown or testing)
 */
export function clearStats() {
  stats.ordersPlaced = 0;
  stats.ordersFilled = 0;
  stats.ordersCancelled = 0;
  stats.ordersRejected = 0;
  stats.ordersPartiallyFilled = 0;
  stats.totalLatencyMs = 0;
  stats.cancelLatencyMs = 0;
  stats.cancelCount = 0;
  stats.lastOrderTime = null;
}
