/**
 * Order Manager State
 *
 * In-memory order tracking for fast access.
 * Synchronized with database for persistence.
 */

import { OrderStatus } from './types.js';

/**
 * In-memory order cache
 * Key: order_id, Value: order object
 * @type {Map<string, Object>}
 */
const orderCache = new Map();

/**
 * Module statistics
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
 * Add an order to the cache
 * @param {Object} order - Order object
 * @param {boolean} [isNewOrder=true] - Whether this is a newly placed order (affects stats)
 */
export function cacheOrder(order, isNewOrder = true) {
  orderCache.set(order.order_id, { ...order });
  if (isNewOrder) {
    stats.ordersPlaced++;
    stats.lastOrderTime = new Date().toISOString();
  }
}

/**
 * Get an order from the cache
 * @param {string} orderId - Order ID
 * @returns {Object|undefined} Order object or undefined
 */
export function getCachedOrder(orderId) {
  const order = orderCache.get(orderId);
  return order ? { ...order } : undefined;
}

/**
 * Update an order in the cache
 * @param {string} orderId - Order ID
 * @param {Object} updates - Fields to update
 * @returns {Object|undefined} Updated order or undefined if not found
 */
export function updateCachedOrder(orderId, updates) {
  const order = orderCache.get(orderId);
  if (!order) {
    return undefined;
  }

  const updated = { ...order, ...updates };
  orderCache.set(orderId, updated);

  // Update stats based on status change
  if (updates.status === OrderStatus.FILLED) {
    stats.ordersFilled++;
  } else if (updates.status === OrderStatus.CANCELLED) {
    stats.ordersCancelled++;
  } else if (updates.status === OrderStatus.REJECTED) {
    stats.ordersRejected++;
  }

  return { ...updated };
}

/**
 * Get all cached orders matching a filter
 * @param {Function} filterFn - Filter function
 * @returns {Object[]} Array of matching orders
 */
export function getCachedOrders(filterFn) {
  const orders = [];
  for (const order of orderCache.values()) {
    if (!filterFn || filterFn(order)) {
      orders.push({ ...order });
    }
  }
  return orders;
}

/**
 * Get open orders from cache
 * @returns {Object[]} Array of open orders
 */
export function getCachedOpenOrders() {
  return getCachedOrders(
    (order) =>
      order.status === OrderStatus.OPEN ||
      order.status === OrderStatus.PARTIALLY_FILLED
  );
}

/**
 * Get orders by window ID from cache
 * @param {string} windowId - Window ID
 * @returns {Object[]} Array of orders for the window
 */
export function getCachedOrdersByWindow(windowId) {
  return getCachedOrders((order) => order.window_id === windowId);
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
  const cachedOrderCount = orderCache.size;
  const avgLatencyMs =
    stats.ordersPlaced > 0
      ? Math.round(stats.totalLatencyMs / stats.ordersPlaced)
      : 0;
  const avgCancelLatencyMs =
    stats.cancelCount > 0
      ? Math.round(stats.cancelLatencyMs / stats.cancelCount)
      : 0;

  return {
    cachedOrderCount,
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
 * Clear all cached orders
 * Used during shutdown or testing
 */
export function clearCache() {
  orderCache.clear();
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

/**
 * Load orders into cache from database
 * Does not increment stats since these are historical orders, not new placements.
 * @param {Object[]} orders - Array of orders from database
 */
export function loadOrdersIntoCache(orders) {
  if (!orders || !Array.isArray(orders)) {
    return;
  }
  for (const order of orders) {
    // Use cacheOrder with isNewOrder=false to avoid inflating stats
    cacheOrder(order, false);
  }
}
