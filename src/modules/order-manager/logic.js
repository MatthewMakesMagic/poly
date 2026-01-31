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
  recordCancelLatency,
  recordPartialFill,
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
    const insertResult = persistence.run(
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

    // Verify database insert succeeded
    if (!insertResult || insertResult.changes !== 1) {
      throw new OrderManagerError(
        OrderManagerErrorCodes.DATABASE_ERROR,
        'Failed to insert order into database',
        { orderId: result.orderID, insertResult }
      );
    }

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

  // Whitelist of allowed column names to prevent SQL injection
  const ALLOWED_COLUMNS = new Set([
    'status', 'filled_size', 'avg_fill_price', 'filled_at',
    'cancelled_at', 'error_message', 'position_id',
  ]);

  // Validate all column names against whitelist
  const invalidColumns = Object.keys(updateFields).filter(
    (key) => !ALLOWED_COLUMNS.has(key)
  );
  if (invalidColumns.length > 0) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      `Invalid update columns: ${invalidColumns.join(', ')}`,
      { invalidColumns, allowedColumns: [...ALLOWED_COLUMNS] }
    );
  }

  // Update database - column names are now validated against whitelist
  const setClauses = Object.keys(updateFields)
    .map((key) => `${key} = ?`)
    .join(', ');
  const values = [...Object.values(updateFields), orderId];

  const updateResult = persistence.run(
    `UPDATE orders SET ${setClauses} WHERE order_id = ?`,
    values
  );

  // Verify database update succeeded
  if (!updateResult || updateResult.changes !== 1) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.DATABASE_ERROR,
      'Failed to update order in database',
      { orderId, updateResult }
    );
  }

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

  // Defensive check for null/undefined database result
  const orders = recentOrders || [];
  loadOrdersIntoCache(orders);
  log.info('orders_loaded_to_cache', { count: orders.length });
}

/**
 * Cancel an open order with write-ahead logging
 *
 * Flow:
 * 1. Validate order exists and is in cancellable state
 * 2. Log intent BEFORE API call
 * 3. Mark intent as executing
 * 4. Call Polymarket API
 * 5. Record latency and update order status
 * 6. Mark intent completed/failed
 *
 * @param {string} orderId - Order ID to cancel
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} Cancel result { orderId, latencyMs, intentId }
 * @throws {OrderManagerError} If order not found, invalid state, or API error
 */
export async function cancelOrder(orderId, log) {
  // 0. Validate orderId parameter
  if (!orderId || typeof orderId !== 'string') {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'orderId is required and must be a string',
      { orderId }
    );
  }

  // 1. Get order and validate it exists
  const order = getOrder(orderId);
  if (!order) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_FOUND,
      `Order not found: ${orderId}`,
      { orderId }
    );
  }

  // 2. Validate order is in a cancellable state
  const cancellableStates = [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED];
  if (!cancellableStates.includes(order.status)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_CANCEL_STATE,
      `Cannot cancel order in ${order.status} state`,
      { orderId, currentStatus: order.status }
    );
  }

  // 3. Log intent BEFORE API call
  const intentId = writeAhead.logIntent(
    writeAhead.INTENT_TYPES.CANCEL_ORDER,
    order.window_id,
    { orderId, orderStatus: order.status, requestedAt: new Date().toISOString() }
  );

  log.info('cancel_intent_logged', { intentId, orderId, currentStatus: order.status });

  // 4. Mark as executing
  writeAhead.markExecuting(intentId);

  // 5. Record start time for latency
  const startTime = Date.now();

  try {
    // 6. Call Polymarket API
    await polymarketClient.cancelOrder(orderId);

    // 7. Calculate latency
    const latencyMs = Date.now() - startTime;
    recordCancelLatency(latencyMs);

    // 8. Update order status
    updateOrderStatus(orderId, OrderStatus.CANCELLED, {
      cancelled_at: new Date().toISOString(),
    }, log);

    // 9. Mark intent completed
    writeAhead.markCompleted(intentId, { orderId, latencyMs });

    log.info('order_cancelled', { orderId, latencyMs, intentId });

    return { orderId, latencyMs, intentId };
  } catch (err) {
    const latencyMs = Date.now() - startTime;

    // Record latency even on failure for monitoring
    recordCancelLatency(latencyMs);

    // ALWAYS mark failed on error
    writeAhead.markFailed(intentId, {
      code: err.code || 'CANCEL_FAILED',
      message: err.message,
      latencyMs,
    });

    log.error('order_cancel_failed', {
      orderId,
      error: err.message,
      code: err.code,
      latencyMs,
    });

    throw new OrderManagerError(
      OrderManagerErrorCodes.CANCEL_FAILED,
      `Cancel order failed: ${err.message}`,
      { orderId, originalError: err.message, intentId }
    );
  }
}

/**
 * Handle a partial fill event for an order
 *
 * Updates filled_size, avg_fill_price, and status based on fill progression.
 *
 * @param {string} orderId - Order ID
 * @param {number} fillSize - Size of this fill
 * @param {number} fillPrice - Price of this fill
 * @param {Object} log - Logger instance
 * @returns {Object} Updated order
 * @throws {OrderManagerError} If order not found or invalid state
 */
export function handlePartialFill(orderId, fillSize, fillPrice, log) {
  // 0. Validate input parameters
  if (!orderId || typeof orderId !== 'string') {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'orderId is required and must be a string',
      { orderId }
    );
  }

  if (typeof fillSize !== 'number' || fillSize <= 0) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'fillSize must be a positive number',
      { fillSize }
    );
  }

  if (typeof fillPrice !== 'number' || fillPrice < 0.01 || fillPrice > 0.99) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.VALIDATION_FAILED,
      'fillPrice must be a number between 0.01 and 0.99',
      { fillPrice }
    );
  }

  // 1. Get order and validate it exists
  const order = getOrder(orderId);
  if (!order) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.NOT_FOUND,
      `Order not found: ${orderId}`,
      { orderId }
    );
  }

  // 2. Validate order is in a fillable state
  const fillableStates = [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED];
  if (!fillableStates.includes(order.status)) {
    throw new OrderManagerError(
      OrderManagerErrorCodes.INVALID_STATUS_TRANSITION,
      `Cannot fill order in ${order.status} state`,
      { orderId, currentStatus: order.status }
    );
  }

  // 3. Calculate new cumulative filled size
  const previousFilledSize = order.filled_size || 0;
  const previousAvgPrice = order.avg_fill_price || fillPrice;
  const newFilledSize = previousFilledSize + fillSize;

  // 4. Calculate weighted average price
  // (previousSize * previousPrice + newSize * newPrice) / totalSize
  // Round to 8 decimal places to avoid floating-point precision issues
  const rawAvgPrice =
    previousFilledSize > 0
      ? (previousFilledSize * previousAvgPrice + fillSize * fillPrice) / newFilledSize
      : fillPrice;
  const newAvgPrice = Math.round(rawAvgPrice * 1e8) / 1e8;

  // 5. Determine new status
  const isFullyFilled = newFilledSize >= order.size;
  const newStatus = isFullyFilled ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED;

  // 6. Build updates
  const updates = {
    filled_size: newFilledSize,
    avg_fill_price: newAvgPrice,
  };

  if (isFullyFilled) {
    updates.filled_at = new Date().toISOString();
  }

  // 7. Update order (uses existing updateOrderStatus which handles DB + cache)
  updateOrderStatus(orderId, newStatus, updates, log);

  // 8. Update stats for partial fills
  if (newStatus === OrderStatus.PARTIALLY_FILLED) {
    recordPartialFill();
  }

  log.info('partial_fill_processed', {
    orderId,
    fillSize,
    fillPrice,
    newFilledSize,
    newAvgPrice,
    newStatus,
  });

  return getOrder(orderId);
}

/**
 * Get all partially filled orders
 *
 * @returns {Object[]} Array of partially filled orders
 */
export function getPartiallyFilledOrders() {
  // Sync cache from database to ensure consistency
  const dbOrders = persistence.all(
    'SELECT * FROM orders WHERE status = ?',
    [OrderStatus.PARTIALLY_FILLED]
  );

  // Update cache with database state
  loadOrdersIntoCache(dbOrders);

  return getCachedOrders((order) => order.status === OrderStatus.PARTIALLY_FILLED);
}
