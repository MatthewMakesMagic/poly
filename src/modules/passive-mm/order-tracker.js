/**
 * Order Tracker v2 — Order Map + Fill Detection + Inventory
 *
 * Core state model for the passive MM engine. Manages a per-side order map,
 * detects fills (paper: ask crosses bid, live: poll getOpenOrders), and
 * maintains inventory synced to both local state and liveState.state._mm.
 *
 * Key differences from v1:
 *   - Order map keyed by side ('up'/'down'), not array of resting orders
 *   - Per-order cancel (cancelOrder) instead of cancelAll() sledgehammer
 *   - recordFill() writes to state._mm directly (no strategy.onPassiveFill)
 *   - Live fill detection filters by tokenIds to avoid cross-window contamination
 *
 * @module modules/passive-mm/order-tracker
 */

/**
 * @param {Object} opts
 * @param {'PAPER'|'LIVE'} opts.mode
 * @param {Object} opts.polymarketClient
 * @param {Object} opts.tokenIds - { up, down }
 * @param {Object} opts.liveState - LiveMarketState adapter (for state._mm sync)
 * @param {Object} opts.log
 * @param {string} opts.crypto - e.g. 'btc'
 * @returns {Object}
 */
export function createOrderTracker({ mode, polymarketClient, tokenIds, liveState, log, crypto }) {
  // Order map: side -> { orderId, price, size, capital, placedAt }
  const orderMap = new Map();

  // Inventory (single source of truth, synced to state._mm after every mutation)
  let inventory = { upCost: 0, downCost: 0, upTokens: 0, downTokens: 0 };

  // Fill history
  const fills = [];

  let nextPaperId = 1;

  // ── Helpers ──

  function resolveTokenId(side) {
    return side === 'up' ? tokenIds.up : tokenIds.down;
  }

  function syncMmState() {
    if (!liveState.state._mm) {
      liveState.state._mm = {
        upCost: 0, downCost: 0, upTokens: 0, downTokens: 0,
        // Strategy reads mm.upInv.cost / mm.downInv.cost (initMm shape)
        upInv: { cost: 0, tokens: 0 },
        downInv: { cost: 0, tokens: 0 },
        fills: 0,
        exchHistory: [],
        clobUpHistory: [],
        clobDownHistory: [],
        lastQuoteMs: 0, lastBidUp: null, lastBidDown: null,
        quotedUp: false, quotedDown: false,
      };
    }
    const mm = liveState.state._mm;
    // Flat fields (dashboard compat)
    mm.upCost = inventory.upCost;
    mm.downCost = inventory.downCost;
    mm.upTokens = inventory.upTokens;
    mm.downTokens = inventory.downTokens;
    // Nested fields (strategy reads mm.upInv.cost for inventory limits)
    if (!mm.upInv) mm.upInv = { cost: 0, tokens: 0 };
    if (!mm.downInv) mm.downInv = { cost: 0, tokens: 0 };
    mm.upInv.cost = inventory.upCost;
    mm.upInv.tokens = inventory.upTokens;
    mm.downInv.cost = inventory.downCost;
    mm.downInv.tokens = inventory.downTokens;
    mm.fills = fills.length;
  }

  // ── Place Order ──

  async function placeOrder(side, price, size, capital) {
    if (mode === 'PAPER') {
      const orderId = `paper-${nextPaperId++}`;
      orderMap.set(side, { orderId, side, price, size, capital, placedAt: Date.now() });
      log.info('paper_limit_placed', { orderId, side, price: price.toFixed(4), size: size.toFixed(2) });
      return orderId;
    }

    // LIVE mode
    const tokenId = resolveTokenId(side);
    if (!tokenId) {
      log.warn('live_place_no_token_id', { side });
      return null;
    }
    try {
      const result = await polymarketClient.buy(tokenId, capital, price, 'GTC');
      const orderId = result?.orderID || result?.order_id || result?.id || null;
      if (orderId) {
        orderMap.set(side, { orderId, side, price, size, capital, placedAt: Date.now() });
        log.info('live_limit_placed', { orderId, side, price: price.toFixed(4) });
      }
      return orderId;
    } catch (err) {
      log.warn('live_place_failed', { side, price, error: err.message });
      return null;
    }
  }

  // ── Cancel Order ──

  async function cancelOrder(orderId, side) {
    if (mode === 'PAPER') {
      orderMap.delete(side);
      log.info('paper_order_cancelled', { orderId, side });
      return true;
    }

    // LIVE mode — per-order cancel
    try {
      await polymarketClient.cancelOrder(orderId);
      orderMap.delete(side);
      log.info('live_order_cancelled', { orderId, side });
      return true;
    } catch (err) {
      // Cancel failed — could be transient API error (order still resting)
      // or the order was already filled/matched. Do NOT delete from orderMap —
      // keep it tracked so the next reconcile cycle retries the cancel, or
      // checkLiveFills detects it as filled (missing from getOpenOrders).
      log.warn('live_cancel_failed', { orderId, side, error: err.message });
      return false;
    }
  }

  // ── Fill Detection ──

  /**
   * Check for fills. Async — PAPER checks ask-crosses-bid (sync),
   * LIVE polls getOpenOrders and diffs vs orderMap.
   *
   * @param {Object} state - Current MarketState
   */
  async function checkFills(state) {
    if (mode === 'PAPER') {
      checkPaperFills(state);
    } else if (mode === 'LIVE') {
      await checkLiveFills();
    }
  }

  function checkPaperFills(state) {
    // Snapshot entries before iterating — fills mutate the map
    const entries = [...orderMap.entries()];
    for (const [side, order] of entries) {
      const book = side === 'up' ? state.clobUp : state.clobDown;
      if (!book) continue;

      const bestAsk = book.bestAsk;
      if (bestAsk != null && bestAsk <= order.price) {
        orderMap.delete(side);
        recordFill(order.orderId, order);

        log.info('paper_passive_fill', {
          orderId: order.orderId, side, price: order.price.toFixed(4),
          size: order.size.toFixed(2), bestAsk: bestAsk.toFixed(4),
        });
      }
    }
  }

  /**
   * Live fill detection: poll getOpenOrders, diff vs orderMap.
   * Orders in our tokenIds that are missing from API response are fills.
   */
  async function checkLiveFills() {
    if (orderMap.size === 0) return;

    try {
      const openOrders = await polymarketClient.getOpenOrders();
      const openIds = new Set();

      // Filter to only our tokenIds
      for (const order of openOrders) {
        const tid = order.asset_id || order.token_id;
        if (tid === tokenIds.up || tid === tokenIds.down) {
          const oid = order.id || order.orderID || order.order_id;
          if (oid) openIds.add(oid);
        }
      }

      // Snapshot entries — fills mutate the map
      const entries = [...orderMap.entries()];
      for (const [side, order] of entries) {
        if (!openIds.has(order.orderId)) {
          orderMap.delete(side);
          recordFill(order.orderId, order);

          log.info('live_passive_fill', {
            orderId: order.orderId, side, price: order.price.toFixed(4),
            size: order.size.toFixed(2),
          });
        }
      }
    } catch (err) {
      log.debug('live_fill_poll_error', { error: err.message });
    }
  }

  // ── Record Fill ──

  function recordFill(orderId, order) {
    fills.push({
      orderId,
      token: `${crypto}-${order.side}`,
      side: order.side,
      price: order.price,
      size: order.size,
      capital: order.capital,
      filledAt: Date.now(),
    });

    // Use capital for cost tracking (not price * size) — accurate for both
    // passive fills (capital = price * size by construction) and aggressive
    // fills (capital is the actual dollar amount spent, regardless of slippage)
    if (order.side === 'up') {
      inventory.upCost += order.capital;
      inventory.upTokens += order.size;
    } else {
      inventory.downCost += order.capital;
      inventory.downTokens += order.size;
    }

    syncMmState();
  }

  // ── Aggressive Buy (FOK for hedge) ──

  async function aggressiveBuy(side, capital, state) {
    const book = side === 'up' ? state.clobUp : state.clobDown;
    const askPrice = book?.bestAsk || 0.50;

    if (mode === 'PAPER') {
      const fillSize = capital / askPrice;
      recordFill(`agg-${nextPaperId++}`, { side, price: askPrice, size: fillSize, capital });
      log.info('paper_aggressive_fill', { side, price: askPrice.toFixed(4), size: fillSize.toFixed(2) });
      return;
    }

    // LIVE
    const tokenId = resolveTokenId(side);
    if (!tokenId) return;
    try {
      const result = await polymarketClient.buy(tokenId, capital, 0.99, 'FOK');
      const oid = result?.orderID || result?.order_id;
      if (oid) {
        try {
          const orderDetail = await polymarketClient.getOrder(oid);
          const matched = parseFloat(orderDetail?.size_matched || 0);
          if (matched > 0) {
            const fillPrice = parseFloat(orderDetail.price || capital / matched);
            // Use actual capital spent (price * size), not the requested amount —
            // FOK may partially fill, and the actual cost matters for P&L
            const actualCapital = matched * fillPrice;
            recordFill(oid, { side, price: fillPrice, size: matched, capital: actualCapital });
          }
        } catch { /* best effort */ }
      }
      log.info('live_aggressive_sent', { side });
    } catch (err) {
      log.warn('live_aggressive_failed', { side, error: err.message });
    }
  }

  // ── Cancel All by Order ID (pre-close) ──

  async function cancelAllByOrderId() {
    // Snapshot entries — cancelOrder mutates the map
    const entries = [...orderMap.entries()];
    for (const [side, order] of entries) {
      await cancelOrder(order.orderId, side);
    }
  }

  // ── Getters ──

  function getOrderMap() {
    return orderMap;
  }

  function getInventory() {
    return { ...inventory };
  }

  function getFills() {
    return fills;
  }

  /**
   * Dashboard-compatible shape (matches v1 getWindowOrders).
   */
  function getWindowOrders() {
    const restingOrderDetails = [];
    for (const [, order] of orderMap) {
      restingOrderDetails.push({
        id: order.orderId,
        side: order.side,
        price: order.price,
        size: order.size,
        capital: order.capital,
        placedAt: order.placedAt,
      });
    }

    return {
      restingOrders: orderMap.size,
      fills: fills.length,
      upCost: inventory.upCost,
      downCost: inventory.downCost,
      upTokens: inventory.upTokens,
      downTokens: inventory.downTokens,
      paired: inventory.upTokens > 0 && inventory.downTokens > 0,
      pairEdge: inventory.upTokens > 0 && inventory.downTokens > 0
        ? 1.0 - (inventory.upCost / inventory.upTokens + inventory.downCost / inventory.downTokens)
        : null,
      fillDetails: fills,
      restingOrderDetails,
    };
  }

  // ── Shutdown ──

  async function shutdown() {
    await cancelAllByOrderId();
  }

  return {
    placeOrder,
    cancelOrder,
    cancelAllByOrderId,
    checkFills,
    checkLiveFills,
    aggressiveBuy,
    getOrderMap,
    getInventory,
    getFills,
    getWindowOrders,
    shutdown,
  };
}
