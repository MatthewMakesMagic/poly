/**
 * BacktestOrderBook — Passive Limit Order Simulation
 *
 * Tracks resting limit orders and simulates fills against L2 orderbook data.
 * Designed for backtesting market-making strategies that post passive quotes.
 *
 * Fill model: Level-aware with volume check.
 *   - On placement, records queue position (volume ahead at price level)
 *   - On each L2 tick, checks if cumulative crossing volume exceeds queue position
 *   - Uses configurable queuePositionFraction (default 0.5 = assume midway in queue)
 *   - Fills execute at the limit price (no slippage — passive fill)
 */

export class BacktestOrderBook {
  /**
   * @param {Object} [options]
   * @param {number} [options.queuePositionFraction=0.5] - Where in the queue we sit (0=front, 1=back)
   */
  constructor(options = {}) {
    this.queuePositionFraction = options.queuePositionFraction ?? 0.5;
    this.orders = new Map(); // orderId -> Order
    this.nextId = 0;
    this.fills = [];
  }

  /**
   * Place a resting limit order.
   *
   * @param {Object} params
   * @param {string} params.token - Token identifier (e.g. 'btc-up')
   * @param {'bid'|'ask'} params.side - 'bid' for limit buy, 'ask' for limit sell
   * @param {number} params.price - Limit price
   * @param {number} params.size - Number of tokens
   * @param {string} params.timestamp - Placement timestamp
   * @param {string} [params.reason] - Placement reason
   * @returns {string} Order ID
   */
  placeOrder({ token, side, price, size, timestamp, reason = '' }) {
    const orderId = `lob-${++this.nextId}`;
    this.orders.set(orderId, {
      id: orderId,
      token,
      side,
      price,
      size,
      timestamp,
      reason,
      status: 'OPEN',
      cumulativeVolume: 0,
      queueAhead: 0, // set on first L2 tick
      queueInitialized: false,
    });
    return orderId;
  }

  /**
   * Cancel a resting order.
   *
   * @param {string} orderId
   * @returns {boolean} True if order was found and cancelled
   */
  cancelOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'OPEN') return false;
    order.status = 'CANCELLED';
    this.orders.delete(orderId);
    return true;
  }

  /**
   * Cancel all open orders, optionally filtered by token.
   *
   * @param {string} [token] - If provided, only cancel orders for this token
   */
  cancelAll(token) {
    for (const [id, order] of this.orders) {
      if (order.status !== 'OPEN') continue;
      if (token && order.token !== token) continue;
      order.status = 'CANCELLED';
      this.orders.delete(id);
    }
  }

  /**
   * Process an L2 tick — check all resting orders for fills.
   *
   * @param {Object} params
   * @param {string} params.token - Token this L2 update is for
   * @param {Object} params.levels - { bids: [[price, size], ...], asks: [[price, size], ...] }
   * @param {string} params.timestamp - Tick timestamp
   * @returns {Object[]} Array of fills
   */
  processL2Tick({ token, levels, timestamp }) {
    if (!levels) return [];

    const bids = levels.bids || [];
    const asks = levels.asks || [];
    const newFills = [];

    for (const [orderId, order] of this.orders) {
      if (order.status !== 'OPEN') continue;
      if (order.token !== token) continue;

      if (order.side === 'bid') {
        // Resting bid (limit buy) at price P
        // Fills when asks cross through our level with enough volume
        this._processBidFill(order, bids, asks, timestamp, newFills);
      } else {
        // Resting ask (limit sell) at price P
        // Fills when bids cross through our level with enough volume
        this._processAskFill(order, bids, asks, timestamp, newFills);
      }
    }

    // Remove filled orders
    for (const fill of newFills) {
      this.orders.delete(fill.orderId);
      this.fills.push(fill);
    }

    return newFills;
  }

  /**
   * Check if a resting bid should fill.
   *
   * A resting bid at price P fills when sellers cross through our level:
   *   - There exist asks at or below our price P (someone selling into us)
   *   - Cumulative volume through our level exceeds our queue position
   */
  _processBidFill(order, bids, asks, timestamp, fills) {
    const P = order.price;

    // Initialize queue position on first tick
    if (!order.queueInitialized) {
      // Queue ahead = total bid volume at prices >= P (others ahead of us)
      let totalAhead = 0;
      for (const [bidPrice, bidSize] of bids) {
        if (bidPrice >= P) totalAhead += bidSize;
      }
      order.queueAhead = totalAhead * this.queuePositionFraction;
      order.queueInitialized = true;
    }

    // Volume crossing through our level: asks at prices <= P
    let volumeThrough = 0;
    for (const [askPrice, askSize] of asks) {
      if (askPrice <= P) volumeThrough += askSize;
    }

    if (volumeThrough <= 0) return;

    order.cumulativeVolume += volumeThrough;

    // Fill condition: cumulative crossing volume > queue ahead
    if (order.cumulativeVolume > order.queueAhead) {
      order.status = 'FILLED';
      fills.push({
        orderId: order.id,
        token: order.token,
        side: order.side,
        price: order.price,  // Fill at limit price — passive fill, no slippage
        size: order.size,
        timestamp,
        reason: order.reason,
        queueAhead: order.queueAhead,
        cumulativeVolume: order.cumulativeVolume,
      });
    }
  }

  /**
   * Check if a resting ask should fill.
   *
   * A resting ask at price P fills when buyers cross through our level:
   *   - There exist bids at or above our price P (someone buying into us)
   *   - Cumulative volume through our level exceeds our queue position
   */
  _processAskFill(order, bids, asks, timestamp, fills) {
    const P = order.price;

    // Initialize queue position on first tick
    if (!order.queueInitialized) {
      // Queue ahead = total ask volume at prices <= P (others ahead of us)
      let totalAhead = 0;
      for (const [askPrice, askSize] of asks) {
        if (askPrice <= P) totalAhead += askSize;
      }
      order.queueAhead = totalAhead * this.queuePositionFraction;
      order.queueInitialized = true;
    }

    // Volume crossing through our level: bids at prices >= P
    let volumeThrough = 0;
    for (const [bidPrice, bidSize] of bids) {
      if (bidPrice >= P) volumeThrough += bidSize;
    }

    if (volumeThrough <= 0) return;

    order.cumulativeVolume += volumeThrough;

    // Fill condition: cumulative crossing volume > queue ahead
    if (order.cumulativeVolume > order.queueAhead) {
      order.status = 'FILLED';
      fills.push({
        orderId: order.id,
        token: order.token,
        side: order.side,
        price: order.price,
        size: order.size,
        timestamp,
        reason: order.reason,
        queueAhead: order.queueAhead,
        cumulativeVolume: order.cumulativeVolume,
      });
    }
  }

  /**
   * Get all open orders.
   * @returns {Object[]}
   */
  getOpenOrders() {
    return [...this.orders.values()].filter(o => o.status === 'OPEN');
  }

  /**
   * Get all fills for this session.
   * @returns {Object[]}
   */
  getFills() {
    return [...this.fills];
  }

  /**
   * Check if there are any open orders for a token/side.
   *
   * @param {string} token
   * @param {'bid'|'ask'} [side]
   * @returns {boolean}
   */
  hasOpenOrders(token, side) {
    for (const order of this.orders.values()) {
      if (order.status !== 'OPEN') continue;
      if (order.token !== token) continue;
      if (side && order.side !== side) continue;
      return true;
    }
    return false;
  }

  /**
   * Reset orderbook state (between windows).
   */
  reset() {
    this.orders.clear();
    this.fills = [];
    this.nextId = 0;
  }
}
