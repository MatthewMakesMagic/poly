/**
 * BacktestOrderBook — Passive Limit Order Simulation
 *
 * Tracks resting limit orders and simulates fills against L2 orderbook data.
 * Designed for backtesting market-making strategies that post passive quotes.
 *
 * Fill model: Queue-aware depth depletion.
 *   - On placement, records queue position = bid depth at our level * queuePositionFraction
 *   - On each L2 tick, tracks bid-side depth changes at our price level
 *   - When depth decreases, orders ahead of us were filled → reduces queueAhead
 *   - Fills only when queueAhead <= 0 AND opposing side crosses our price
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
    // Carry cumulative depletion credit across cancel/re-place at same level
    this._volumeMemory = new Map(); // "token:side:price" -> { queueAhead, prevDepth }
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
    const levelKey = `${token}:${side}:${price.toFixed(4)}`;
    // Restore queue state from previous order at same level (cancel/re-place)
    const prior = this._volumeMemory.get(levelKey);
    this.orders.set(orderId, {
      id: orderId,
      token,
      side,
      price,
      size,
      timestamp,
      reason,
      status: 'OPEN',
      queueAhead: prior ? prior.queueAhead : null, // null = needs init on first tick
      prevDepth: prior ? prior.prevDepth : null,     // previous tick's depth at our level
      queueInitialized: !!prior,
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
    const levelKey = `${order.token}:${order.side}:${order.price.toFixed(4)}`;
    // Save queue state for re-placement at same level
    if (order.queueInitialized) {
      this._volumeMemory.set(levelKey, {
        queueAhead: order.queueAhead,
        prevDepth: order.prevDepth,
      });
    }
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
      const levelKey = `${order.token}:${order.side}:${order.price.toFixed(4)}`;
      if (order.queueInitialized) {
        this._volumeMemory.set(levelKey, {
          queueAhead: order.queueAhead,
          prevDepth: order.prevDepth,
        });
      }
      order.status = 'CANCELLED';
      this.orders.delete(id);
    }
  }

  /**
   * Process an L2 tick — update queue positions and check for fills.
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
        this._processBidFill(order, bids, asks, timestamp, newFills);
      } else {
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
   * Get bid-side depth at or above a given price.
   * For a resting bid at P, this is the volume ahead of us in the queue.
   *
   * Assumes bids are sorted descending by price (best bid first).
   * Early-exits when prices drop below our level.
   *
   * @param {Array} bids - [[price, size], ...] sorted descending
   * @param {number} price - Our resting bid price
   * @returns {number} Total volume at price levels >= price
   */
  _bidDepthAtLevel(bids, price) {
    let depth = 0;
    for (let i = 0; i < bids.length; i++) {
      if (bids[i][0] < price) break; // sorted descending — all remaining are below us
      depth += bids[i][1];
    }
    return depth;
  }

  /**
   * Get ask-side depth at or below a given price.
   * For a resting ask at P, this is the volume ahead of us in the queue.
   *
   * Assumes asks are sorted ascending by price (best ask first).
   * Early-exits when prices rise above our level.
   *
   * @param {Array} asks - [[price, size], ...] sorted ascending
   * @param {number} price - Our resting ask price
   * @returns {number} Total volume at price levels <= price
   */
  _askDepthAtLevel(asks, price) {
    let depth = 0;
    for (let i = 0; i < asks.length; i++) {
      if (asks[i][0] > price) break; // sorted ascending — all remaining are above us
      depth += asks[i][1];
    }
    return depth;
  }

  /**
   * Check if a resting bid should fill using queue-aware depth depletion.
   *
   * Model:
   *   1. queueAhead = bidDepth at our level * queuePositionFraction (on first tick)
   *   2. Each tick: if bid depth decreased, reduce queueAhead (orders ahead got filled/cancelled)
   *   3. Fill when queueAhead <= 0 AND asks exist at or below our price
   */
  _processBidFill(order, bids, asks, timestamp, fills) {
    const P = order.price;
    const currentBidDepth = this._bidDepthAtLevel(bids, P);

    // Initialize queue position on first L2 tick
    if (!order.queueInitialized) {
      order.queueAhead = currentBidDepth * this.queuePositionFraction;
      order.prevDepth = currentBidDepth;
      order.queueInitialized = true;
      // Don't fill on the initialization tick — need at least one depletion cycle
      return;
    }

    // Track depth depletion: if bid depth decreased, orders ahead of us were consumed
    if (currentBidDepth < order.prevDepth) {
      const depleted = order.prevDepth - currentBidDepth;
      order.queueAhead = Math.max(0, order.queueAhead - depleted);
    }
    order.prevDepth = currentBidDepth;

    // Check fill condition: queue cleared AND asks cross to our level
    if (order.queueAhead > 0) return;

    // Best ask is first element (sorted ascending)
    const bestAsk = asks.length > 0 ? asks[0][0] : Infinity;

    // No asks at or below our price — no fill
    if (bestAsk > P) return;

    const fillPrice = P; // Passive fill: maker always gets their limit price

    order.status = 'FILLED';
    fills.push({
      orderId: order.id,
      token: order.token,
      side: order.side,
      price: fillPrice,
      size: order.size,
      timestamp,
      reason: order.reason,
      queueAhead: 0,
      depletionTicks: order._depletionTicks || 0,
    });
  }

  /**
   * Check if a resting ask should fill using queue-aware depth depletion.
   *
   * Mirror of bid logic: tracks ask-side depth at our level.
   */
  _processAskFill(order, bids, asks, timestamp, fills) {
    const P = order.price;
    const currentAskDepth = this._askDepthAtLevel(asks, P);

    // Initialize queue position on first L2 tick
    if (!order.queueInitialized) {
      order.queueAhead = currentAskDepth * this.queuePositionFraction;
      order.prevDepth = currentAskDepth;
      order.queueInitialized = true;
      return;
    }

    // Track depth depletion
    if (currentAskDepth < order.prevDepth) {
      const depleted = order.prevDepth - currentAskDepth;
      order.queueAhead = Math.max(0, order.queueAhead - depleted);
    }
    order.prevDepth = currentAskDepth;

    // Check fill condition: queue cleared AND bids cross to our level
    if (order.queueAhead > 0) return;

    // Best bid is first element (sorted descending)
    const bestBid = bids.length > 0 ? bids[0][0] : -Infinity;

    if (bestBid < P) return;

    const fillPrice = P; // Passive fill: maker always gets their limit price

    order.status = 'FILLED';
    fills.push({
      orderId: order.id,
      token: order.token,
      side: order.side,
      price: fillPrice,
      size: order.size,
      timestamp,
      reason: order.reason,
      queueAhead: 0,
      depletionTicks: order._depletionTicks || 0,
    });
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
    this._volumeMemory.clear();
  }
}
