/**
 * Order Tracker — Order Lifecycle Management
 *
 * Manages resting orders, fill detection (paper + live), and position tracking
 * for the passive market-making module.
 *
 * PAPER mode: tracks virtual orders, simulates fills when ask crosses bid.
 * LIVE mode: routes to polymarketClient, polls for fills.
 *
 * @module modules/passive-mm/order-tracker
 */

/**
 * Create an order tracker instance for one window.
 *
 * @param {Object} opts
 * @param {'PAPER'|'LIVE'} opts.mode - Trading mode
 * @param {Object} opts.polymarketClient - Polymarket client module (for LIVE)
 * @param {Object} opts.strategy - Strategy module (onPassiveFill)
 * @param {Object} opts.tokenIds - { up: tokenId, down: tokenId }
 * @param {Object} opts.log - Logger instance
 * @returns {Object} Order tracker
 */
export function createOrderTracker({ mode, polymarketClient, strategy, tokenIds, log }) {
  // Per-window order state
  let restingOrders = [];    // { id, token, side, price, size, capital, placedAt, orderId? }
  let fills = [];            // { id, token, side, price, size, capital, filledAt }
  let upCost = 0;
  let downCost = 0;
  let upTokens = 0;
  let downTokens = 0;
  let nextOrderId = 1;
  let fillPollInterval = null;

  /**
   * Get the Polymarket token ID for a signal token like 'btc-up'.
   */
  function resolveTokenId(signalToken) {
    if (signalToken.endsWith('-up')) return tokenIds.up;
    if (signalToken.endsWith('-down')) return tokenIds.down;
    return null;
  }

  /**
   * Determine side from signal token.
   */
  function resolveSide(signalToken) {
    return signalToken.endsWith('-up') ? 'up' : 'down';
  }

  /**
   * Handle a strategy signal.
   *
   * @param {Object} signal - { action, token, price, size, capitalPerTrade, reason }
   * @param {Object} state - Current MarketState
   * @param {string} windowId - Window identifier
   */
  async function handleSignal(signal, state, windowId) {
    const { action } = signal;

    if (action === 'place_limit_buy') {
      await placeLimitBuy(signal, windowId);
    } else if (action === 'cancel_all') {
      await cancelAllOrders();
    } else if (action === 'buy') {
      await aggressiveBuy(signal, windowId);
    }
  }

  /**
   * Place a passive limit buy order.
   */
  async function placeLimitBuy(signal, windowId) {
    const { token, price, size, capitalPerTrade, reason } = signal;
    const side = resolveSide(token);
    const id = `paper-${nextOrderId++}`;

    if (mode === 'PAPER') {
      restingOrders.push({
        id,
        token,
        side,
        price,
        size,
        capital: capitalPerTrade,
        placedAt: Date.now(),
      });
      log.info('paper_limit_placed', {
        id, side, price: price.toFixed(4), size: size.toFixed(2), reason,
      });
    } else {
      // LIVE mode
      const tokenId = resolveTokenId(token);
      if (!tokenId) {
        log.warn('live_limit_no_token_id', { token });
        return;
      }
      try {
        const result = await polymarketClient.buy(tokenId, capitalPerTrade, price, 'GTC');
        const orderId = result?.orderID || result?.order_id || result?.id || null;
        restingOrders.push({
          id,
          token,
          side,
          price,
          size,
          capital: capitalPerTrade,
          placedAt: Date.now(),
          orderId,
        });
        log.info('live_limit_placed', {
          id, orderId, side, price: price.toFixed(4), reason,
        });
        ensureFillPolling();
      } catch (err) {
        log.warn('live_limit_failed', { side, price, error: err.message });
      }
    }
  }

  /**
   * Execute an aggressive (FOK) buy for hedging.
   */
  async function aggressiveBuy(signal, windowId) {
    const { token, capitalPerTrade, reason } = signal;
    const side = resolveSide(token);

    if (mode === 'PAPER') {
      // Simulate immediate fill at current ask
      const book = side === 'up'
        ? { bestAsk: signal.price || 0.50 }
        : { bestAsk: signal.price || 0.50 };
      // Strategy already computed price from state, use capital / bestAsk
      const askPrice = side === 'up'
        ? (signal.state?.clobUp?.bestAsk || 0.50)
        : (signal.state?.clobDown?.bestAsk || 0.50);
      const fillPrice = askPrice;
      const fillSize = capitalPerTrade / fillPrice;

      recordFill({ token, side, price: fillPrice, size: fillSize, capital: capitalPerTrade });
      log.info('paper_aggressive_fill', {
        side, price: fillPrice.toFixed(4), size: fillSize.toFixed(2), reason,
      });
    } else {
      const tokenId = resolveTokenId(token);
      if (!tokenId) return;
      try {
        const result = await polymarketClient.buy(tokenId, capitalPerTrade, 0.99, 'FOK');
        // FOK fills immediately or not at all
        if (result?.orderID || result?.order_id) {
          // Poll once to confirm fill
          const orderId = result.orderID || result.order_id;
          try {
            const order = await polymarketClient.getOrder(orderId);
            if (order && parseFloat(order.size_matched || 0) > 0) {
              const fillPrice = parseFloat(order.price || capitalPerTrade / parseFloat(order.size_matched));
              const fillSize = parseFloat(order.size_matched);
              recordFill({ token, side, price: fillPrice, size: fillSize, capital: capitalPerTrade });
            }
          } catch {
            // Best effort
          }
        }
        log.info('live_aggressive_sent', { side, reason });
      } catch (err) {
        log.warn('live_aggressive_failed', { side, error: err.message });
      }
    }
  }

  /**
   * Record a fill and notify the strategy.
   */
  function recordFill(fill) {
    fills.push({ ...fill, filledAt: Date.now() });
    if (fill.side === 'up') {
      upCost += fill.price * fill.size;
      upTokens += fill.size;
    } else {
      downCost += fill.price * fill.size;
      downTokens += fill.size;
    }
  }

  /**
   * Check for paper fills — called on each L2 tick in PAPER mode.
   * A resting bid is filled when the ask price drops to or below our bid.
   *
   * @param {Object} state - Current MarketState
   */
  function checkPaperFills(state) {
    if (restingOrders.length === 0) return;

    const toRemove = [];

    for (let i = 0; i < restingOrders.length; i++) {
      const order = restingOrders[i];
      const book = order.side === 'up' ? state.clobUp : state.clobDown;
      if (!book) continue;

      // Check if best ask has crossed down to our bid
      const bestAsk = book.bestAsk;
      if (bestAsk != null && bestAsk <= order.price) {
        recordFill({
          token: order.token,
          side: order.side,
          price: order.price,
          size: order.size,
          capital: order.capital,
        });

        // Notify strategy of passive fill
        if (strategy.onPassiveFill) {
          strategy.onPassiveFill(
            { token: order.token, price: order.price, size: order.size },
            state,
          );
        }

        log.info('paper_passive_fill', {
          id: order.id,
          side: order.side,
          price: order.price.toFixed(4),
          size: order.size.toFixed(2),
          bestAsk: bestAsk.toFixed(4),
        });

        toRemove.push(i);
      }
    }

    // Remove filled orders (reverse order to maintain indices)
    for (let i = toRemove.length - 1; i >= 0; i--) {
      restingOrders.splice(toRemove[i], 1);
    }
  }

  /**
   * Start polling for LIVE order fills.
   */
  function ensureFillPolling() {
    if (fillPollInterval || mode !== 'LIVE') return;

    fillPollInterval = setInterval(async () => {
      const liveOrders = restingOrders.filter(o => o.orderId);
      for (const order of liveOrders) {
        try {
          const status = await polymarketClient.getOrder(order.orderId);
          const matched = parseFloat(status?.size_matched || 0);
          if (matched > 0) {
            recordFill({
              token: order.token,
              side: order.side,
              price: order.price,
              size: matched,
              capital: order.capital,
            });

            if (strategy.onPassiveFill) {
              strategy.onPassiveFill(
                { token: order.token, price: order.price, size: matched },
                null, // no backtest state in live mode fill polling
              );
            }

            log.info('live_passive_fill', {
              orderId: order.orderId, side: order.side,
              price: order.price.toFixed(4), matched: matched.toFixed(2),
            });

            // Remove from resting
            const idx = restingOrders.indexOf(order);
            if (idx >= 0) restingOrders.splice(idx, 1);
          }
        } catch (err) {
          log.debug('fill_poll_error', { orderId: order.orderId, error: err.message });
        }
      }
    }, 5000);

    if (fillPollInterval.unref) fillPollInterval.unref();
  }

  /**
   * Cancel all resting orders.
   */
  async function cancelAllOrders() {
    if (mode === 'LIVE' && restingOrders.some(o => o.orderId)) {
      try {
        await polymarketClient.cancelAll();
        log.info('live_orders_cancelled', { count: restingOrders.length });
      } catch (err) {
        log.warn('live_cancel_failed', { error: err.message });
      }
    }

    const count = restingOrders.length;
    restingOrders = [];

    if (count > 0) {
      log.info('orders_cancelled', { count, mode });
    }
  }

  /**
   * Get current window order state.
   */
  function getWindowOrders() {
    return {
      restingOrders: restingOrders.length,
      fills: fills.length,
      upCost,
      downCost,
      upTokens,
      downTokens,
      paired: upTokens > 0 && downTokens > 0,
      pairEdge: upTokens > 0 && downTokens > 0
        ? 1.0 - (upCost / upTokens + downCost / downTokens)
        : null,
      fillDetails: fills,
      restingOrderDetails: restingOrders.map(o => ({
        id: o.id,
        side: o.side,
        price: o.price,
        size: o.size,
        capital: o.capital,
        placedAt: o.placedAt,
      })),
    };
  }

  /**
   * Reset for a new window.
   */
  function reset() {
    restingOrders = [];
    fills = [];
    upCost = 0;
    downCost = 0;
    upTokens = 0;
    downTokens = 0;
    nextOrderId = 1;
    if (fillPollInterval) {
      clearInterval(fillPollInterval);
      fillPollInterval = null;
    }
  }

  /**
   * Shutdown: cancel orders and stop polling.
   */
  async function shutdown() {
    await cancelAllOrders();
    if (fillPollInterval) {
      clearInterval(fillPollInterval);
      fillPollInterval = null;
    }
  }

  return {
    handleSignal,
    checkPaperFills,
    getWindowOrders,
    reset,
    cancelAllOrders,
    shutdown,
  };
}
