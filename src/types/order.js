/**
 * Order type definitions for poly trading system
 *
 * Defines the structure of order data used throughout the system.
 */

/**
 * Order status values (follows lifecycle)
 * @readonly
 * @enum {string}
 */
export const OrderStatus = {
  PENDING: 'pending',           // Order created, not yet submitted
  OPEN: 'open',                 // Submitted and acknowledged by exchange
  PARTIALLY_FILLED: 'partially_filled',  // Some fills received
  FILLED: 'filled',             // Completely filled
  CANCELLED: 'cancelled',       // Cancelled by user or system
  EXPIRED: 'expired',           // Expired without fill
  REJECTED: 'rejected',         // Rejected by exchange
};

/**
 * Order type values
 * @readonly
 * @enum {string}
 */
export const OrderType = {
  LIMIT: 'limit',
  MARKET: 'market',
};

/**
 * Order side values
 * @readonly
 * @enum {string}
 */
export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell',
};

/**
 * Create a new order object
 * @param {Object} params - Order parameters
 * @param {string} params.windowId - Trading window identifier
 * @param {string} params.marketId - Polymarket market identifier
 * @param {string} params.tokenId - YES or NO token identifier
 * @param {string} params.side - 'buy' or 'sell'
 * @param {string} params.orderType - 'limit' or 'market'
 * @param {number} [params.price] - Limit price (null for market orders)
 * @param {number} params.size - Order size in tokens
 * @param {number} [params.intentId] - Associated trade intent ID
 * @param {number} [params.positionId] - Associated position ID
 * @returns {Object} Order object
 */
export function createOrder({
  windowId,
  marketId,
  tokenId,
  side,
  orderType,
  price = null,
  size,
  intentId = null,
  positionId = null,
}) {
  return {
    id: null,           // Set by database
    order_id: null,     // Set by exchange
    intent_id: intentId,
    position_id: positionId,
    window_id: windowId,
    market_id: marketId,
    token_id: tokenId,
    side,
    order_type: orderType,
    price,
    size,
    filled_size: 0,
    avg_fill_price: null,
    status: OrderStatus.PENDING,
    submitted_at: new Date().toISOString(),
    latency_ms: null,
    filled_at: null,
    cancelled_at: null,
  };
}

/**
 * Check if order is in terminal state
 * @param {Object} order - Order object
 * @returns {boolean} True if order is terminal (filled, cancelled, expired, rejected)
 */
export function isOrderTerminal(order) {
  return [
    OrderStatus.FILLED,
    OrderStatus.CANCELLED,
    OrderStatus.EXPIRED,
    OrderStatus.REJECTED,
  ].includes(order.status);
}

/**
 * Check if order can be cancelled
 * @param {Object} order - Order object
 * @returns {boolean} True if order can be cancelled
 */
export function isOrderCancellable(order) {
  return [
    OrderStatus.PENDING,
    OrderStatus.OPEN,
    OrderStatus.PARTIALLY_FILLED,
  ].includes(order.status);
}

/**
 * Calculate remaining unfilled size
 * @param {Object} order - Order object
 * @returns {number} Remaining size to fill
 */
export function getRemainingSize(order) {
  return order.size - order.filled_size;
}

/**
 * Validate an order object has required fields
 * @param {Object} order - Order to validate
 * @returns {boolean} True if valid
 * @throws {Error} If validation fails
 */
export function validateOrder(order) {
  const required = ['window_id', 'market_id', 'token_id', 'side', 'order_type', 'size'];

  for (const field of required) {
    if (order[field] === undefined || order[field] === null) {
      throw new Error(`Order missing required field: ${field}`);
    }
  }

  if (!Object.values(OrderSide).includes(order.side)) {
    throw new Error(`Invalid order side: ${order.side}`);
  }

  if (!Object.values(OrderType).includes(order.order_type)) {
    throw new Error(`Invalid order type: ${order.order_type}`);
  }

  if (order.order_type === OrderType.LIMIT && order.price === null) {
    throw new Error('Limit orders require a price');
  }

  if (order.size <= 0) {
    throw new Error('Order size must be positive');
  }

  return true;
}
