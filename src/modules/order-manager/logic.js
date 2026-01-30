/**
 * Order Manager Business Logic
 *
 * Core order lifecycle management:
 * - Order placement with write-ahead logging
 * - Order status tracking
 * - Database persistence
 */

import persistence from '../../persistence/index.js';
import * as writeAhead from '../../persistence/write-ahead.js';
import * as polymarketClient from '../../clients/polymarket/index.js';
import {
  OrderManagerError,
  OrderManagerErrorCodes,
  OrderStatus,
  Side,
  ValidStatusTransitions,
} from './types.js';
import {
  cacheOrder,
  getCachedOrder,
  updateCachedOrder,
  getCachedOpenOrders,
  getCachedOrders,
  recordLatency,
  loadOrdersIntoCache,
} from './state.js';

/**
 * Validate order parameters
 * @param {Object} params - Order parameters
 * @throws {OrderManagerError} If validation fails
 */
function validateOrderParams(params) {
  const { tokenId, side, size, price, orderType, windowId, marketId } = params;

  const errors = [];

  if (!tokenId || typeof tokenId !== 'string') {
    errors.push('tokenId is required and must be a string');
  }

  if (!side || ![Side.BUY, Side.SELL].includes(side)) {
    errors.push(`side must be '${Side.BUY}' or '${Side.SELL}'`);
  }

  if (typeof size !== 'number' || size <= 0) {
    errors.push('size must be a positive number');
  }

  // Price can be null for market orders, but if provided must be valid
  if (price !== null && price !== undefined) {
    if (typeof price !== 'number' || price < 0.01 || price > 0.99) {
      errors.push('price must be a number between 0.01 and 0.99');
    }
  }

  if (!orderType || typeof orderType !== 'string') {
    errors.push('orderType is required');
  }

  if (!windowId || typeof windowId !== 'string') {
    errors.push('windowId is required and must be a string');
  }

  if (!marketId || typeof marketId !== 'string') {
    errors.push('marketId is required and must be a string');
  }

  if (errors.length > 0) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      `Order validation failed: ${errors.join(', ')}`,
      { params, errors }
    );
  }
}

/**
 * Map Polymarket status to our internal status
 * @param {string} polymarketStatus - Status from Polymarket API
 * @param {boolean} isFoK - Whether order was Fill-or-Kill
 * @returns {string} Internal order status
 */
function mapPolymarketStatus(polymarketStatus, isFoK = false) {
  switch (polymarketStatus) {
    case 'live':
      return OrderStatus.OPEN;
    case 'matched':
      return OrderStatus.FILLED;
    default:
      // For FOK orders that weren't matched, they're rejected
      if (isFoK) {
        return OrderStatus.REJECTED;
      }
      return OrderStatus.OPEN;
  }
}

/**
 * Place an order with write-ahead logging
 *
 * Flow:
 * 1. Validate parameters
 * 2. Log intent BEFORE API call
 * 3. Mark intent as executing
 * 4. Call Polymarket API
 * 5. Record latency and persist order
 * 6. Mark intent completed/failed
 *
 * @param {Object} params - Order parameters
 * @param {string} params.tokenId - Token to trade
 * @param {string} params.side - 'buy' or 'sell'
 * @param {number} params.size - Size to trade
 * @param {number} params.price - Limit price (0.01-0.99)
 * @param {string} params.orderType - Order type (GTC, FOK, IOC)
 * @param {string} params.windowId - Window ID for tracking
 * @param {string} params.marketId - Market ID
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Order result with orderId, status, latencyMs
 */
export async function placeOrder(params, log) {
  const { tokenId, side, size, price, orderType, windowId, marketId } = params;

  // 1. Validate parameters
  validateOrderParams(params);

  // 2. Log intent BEFORE API call
  const intentPayload = {
    tokenId,
    side,
    size,
    price,
    orderType,
    windowId,
    marketId,
    requestedAt: new Date().toISOString(),
  };

  const intentId = writeAhead.logIntent(
    writeAhead.INTENT_TYPES.PLACE_ORDER,
    windowId,
    intentPayload
  );

  log.info('order_intent_logged', { intentId, tokenId, side, size, price, orderType });

  // 3. Mark intent as executing
  writeAhead.markExecuting(intentId);

  // 4. Record start time for latency
  const startTime = Date.now();

  try {
    // 5. Call Polymarket API based on side
    let result;
    if (side === Side.BUY) {
      // For buy orders, size is in dollars
      result = await polymarketClient.buy(tokenId, size, price, orderType);
    } else {
      // For sell orders, size is in shares
      result = await polymarketClient.sell(tokenId, size, price, orderType);
    }

    // 6. Calculate latency
    const latencyMs = Date.now() - startTime;
    recordLatency(latencyMs);

    // 7. Determine order status from API response
    const isFoK = orderType === 'FOK';
    const status = mapPolymarketStatus(result.status, isFoK);
    const submittedAt = new Date().toISOString();

    // 8. Build order record
    const orderRecord = {
      order_id: result.orderID,
      intent_id: intentId,
      position_id: null, // Will be set by position manager
      window_id: windowId,
      market_id: marketId,
      token_id: tokenId,
      side,
      order_type: orderType,
      price,
      size,
      filled_size: status === OrderStatus.FILLED ? size : 0,
      avg_fill_price: status === OrderStatus.FILLED ? price : null,
      status,
      submitted_at: submittedAt,
      latency_ms: latencyMs,
      filled_at: status === OrderStatus.FILLED ? submittedAt : null,
      cancelled_at: null,
      error_message: null,
    };

    // 9. Insert order into database
    persistence.run(
      `INSERT INTO orders (
        order_id, intent_id, position_id, window_id, market_id, token_id,
        side, order_type, price, size, filled_size, avg_fill_price,
        status, submitted_at, latency_ms, filled_at, cancelled_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderRecord.order_id,
        orderRecord.intent_id,
        orderRecord.position_id,
        orderRecord.window_id,
        orderRecord.market_id,
        orderRecord.token_id,
        orderRecord.side,
        orderRecord.order_type,
        orderRecord.price,
        orderRecord.size,
        orderRecord.filled_size,
        orderRecord.avg_fill_price,
        orderRecord.status,
        orderRecord.submitted_at,
        orderRecord.latency_ms,
        orderRecord.filled_at,
        orderRecord.cancelled_at,
        orderRecord.error_message,
      ]
    );

    // 10. Cache the order
    cacheOrder(orderRecord);

    // 11. Mark intent completed
    writeAhead.markCompleted(intentId, {
      orderId: result.orderID,
      status,
      latencyMs,
    });

    log.info('order_placed', {
      orderId: result.orderID,
      status,
      latencyMs,
      side,
      size,
      price,
    });

    return {
      orderId: result.orderID,
      status,
      latencyMs,
      intentId,
    };
  } catch (err) {
    // Calculate latency even on failure
    const latencyMs = Date.now() - startTime;

    // ALWAYS mark intent as failed on error
    writeAhead.markFailed(intentId, {
      code: err.code || 'UNKNOWN',
      message: err.message,
      context: err.context,
      latencyMs,
    });

    log.error('order_placement_failed', {
      intentId,
      error: err.message,
      code: err.code,
      latencyMs,
    });

    // Re-throw with additional context
    throw new OrderManagerError(
      OrderManagerErrorCodes.SUBMISSION_FAILED,
      `Order submission failed: ${err.message}`,
      {
        intentId,
        originalError: err.message,
        code: err.code,
        params,
      }
    );
  }
}

/**
 * Update order status with validation
 *
 * @param {string} orderId - Order ID
 * @param {string} newStatus - New status
 * @param {Object} [updates={}] - Additional fields to update
 * @param {Object} log - Logger instance
 * @returns {Object} Updated order
 */
export function updateOrderStatus(orderId, newStatus, updates = {}, log) {
  // Get current order
  const order = getCachedOrder(orderId);
  if (!order) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_FOUND,
      `Order not found: ${orderId}`,
      { orderId }
    );
  }

  // Validate status transition
  const allowedTransitions = ValidStatusTransitions[order.status] || [];
  if (!allowedTransitions.includes(newStatus)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Invalid status transition: ${order.status} → ${newStatus}`,
      { orderId, currentStatus: order.status, newStatus, allowedTransitions }
    );
  }

  // Build update object
  const updateFields = {
    status: newStatus,
    ...updates,
  };

  // Set timestamps based on status
  if (newStatus === OrderStatus.FILLED && !updateFields.filled_at) {
    updateFields.filled_at = new Date().toISOString();
  }
  if (newStatus === OrderStatus.CANCELLED && !updateFields.cancelled_at) {
    updateFields.cancelled_at = new Date().toISOString();
  }

  // Update database
  const setClauses = Object.keys(updateFields)
    .map((key) => `${key} = ?`)
    .join(', ');
  const values = [...Object.values(updateFields), orderId];

  persistence.run(
    `UPDATE orders SET ${setClauses} WHERE order_id = ?`,
    values
  );

  // Update cache
  const updatedOrder = updateCachedOrder(orderId, updateFields);

  // Update intent if this is a terminal state
  if (order.intent_id) {
    if (
      [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.REJECTED].includes(
        newStatus
      )
    ) {
      try {
        writeAhead.markCompleted(order.intent_id, {
          orderId,
          finalStatus: newStatus,
          ...updateFields,
        });
      } catch {
        // Intent may already be completed - that's OK
      }
    }
  }

  log.info('order_status_updated', {
    orderId,
    previousStatus: order.status,
    newStatus,
    ...updates,
  });

  return updatedOrder;
}

/**
 * Get a single order by ID
 *
 * @param {string} orderId - Order ID
 * @returns {Object|undefined} Order or undefined
 */
export function getOrder(orderId) {
  // Try cache first
  let order = getCachedOrder(orderId);

  if (!order) {
    // Fall back to database
    const dbOrder = persistence.get(
      'SELECT * FROM orders WHERE order_id = ?',
      [orderId]
    );

    if (dbOrder) {
      // Add to cache
      cacheOrder(dbOrder);
      order = dbOrder;
    }
  }

  return order;
}

/**
 * Get all open orders
 *
 * @returns {Object[]} Array of open orders
 */
export function getOpenOrders() {
  // Sync cache from database to ensure consistency
  const dbOrders = persistence.all(
    `SELECT * FROM orders WHERE status IN (?, ?)`,
    [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED]
  );

  // Update cache with database state
  loadOrdersIntoCache(dbOrders);

  return getCachedOpenOrders();
}

/**
 * Get orders by window ID
 *
 * @param {string} windowId - Window ID
 * @returns {Object[]} Array of orders
 */
export function getOrdersByWindow(windowId) {
  // Get from database for accuracy
  const dbOrders = persistence.all(
    'SELECT * FROM orders WHERE window_id = ?',
    [windowId]
  );

  // Update cache
  loadOrdersIntoCache(dbOrders);

  return getCachedOrders((order) => order.window_id === windowId);
}

/**
 * Load recent orders into cache on module init
 *
 * @param {Object} log - Logger instance
 */
export function loadRecentOrders(log) {
  // Load open orders and recent orders (last 24 hours) into cache
  const recentOrders = persistence.all(
    `SELECT * FROM orders
     WHERE status IN (?, ?)
     OR submitted_at > datetime('now', '-1 day')
     ORDER BY submitted_at DESC`,
    [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED]
  );

  loadOrdersIntoCache(recentOrders);
  log.info('orders_loaded_to_cache', { count: recentOrders.length });
}
