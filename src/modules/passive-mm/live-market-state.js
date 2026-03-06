/**
 * Live Market State Adapter
 *
 * Wraps the backtest MarketState class for live data feeds.
 * Converts CLOB WS book updates, RTDS ticks, and exchange prices
 * into the MarketState event format expected by strategies.
 *
 * @module modules/passive-mm/live-market-state
 */

import { MarketState } from '../../backtest/market-state.js';

/**
 * Calculate depth within a percentage of the best price.
 *
 * @param {Array<[number, number]>} levels - Array of [price, size] tuples
 * @param {number} bestPrice - Best bid or ask
 * @param {number} pctRange - Percentage range (e.g. 0.01 for 1%)
 * @returns {number} Total size within range
 */
function calcDepth(levels, bestPrice, pctRange) {
  if (!levels || !bestPrice || bestPrice <= 0) return 0;
  let depth = 0;
  for (const [price, size] of levels) {
    if (Math.abs(price - bestPrice) / bestPrice <= pctRange) {
      depth += size;
    }
  }
  return depth;
}

/**
 * Create a LiveMarketState adapter wrapping a backtest MarketState.
 *
 * @param {Object} opts
 * @param {Object} opts.log - Logger instance
 * @returns {Object} LiveMarketState adapter
 */
export function createLiveMarketState({ log }) {
  const state = new MarketState();

  return {
    /** Direct access to the underlying MarketState (passed to strategy.evaluate) */
    state,

    /**
     * Process an L2 book update from CLOB WS.
     *
     * @param {'up'|'down'} side - Which token side
     * @param {Object} book - CLOB WS book: { bids, asks, bestBid, bestAsk, mid, spread }
     */
    processL2Update(side, book) {
      if (!book) return;
      const source = side === 'up' ? 'l2Up' : 'l2Down';
      state.processEvent({
        source,
        timestamp: new Date().toISOString(),
        best_bid: book.bestBid,
        best_ask: book.bestAsk,
        spread: book.spread,
        top_levels: {
          bids: book.bids ? book.bids.slice(0, 10) : [],
          asks: book.asks ? book.asks.slice(0, 10) : [],
        },
        bid_depth_1pct: calcDepth(book.bids || [], book.bestBid, 0.01),
        ask_depth_1pct: calcDepth(book.asks || [], book.bestAsk, 0.01),
      });
    },

    /**
     * Feed a Chainlink oracle price update.
     *
     * @param {number} price - Chainlink price
     */
    updateChainlink(price) {
      state.processEvent({
        source: 'chainlink',
        timestamp: new Date().toISOString(),
        price,
      });
    },

    /**
     * Feed an exchange price update.
     *
     * @param {string} name - Exchange name (e.g. 'binance')
     * @param {number} price - Exchange price
     */
    updateExchange(name, price) {
      state.processEvent({
        source: `exchange_${name}`,
        timestamp: new Date().toISOString(),
        price,
      });
    },

    /**
     * Feed a Polymarket reference price update.
     *
     * @param {number} price - PolyRef composite price
     */
    updatePolyRef(price) {
      state.processEvent({
        source: 'polyRef',
        timestamp: new Date().toISOString(),
        price,
      });
    },

    /**
     * Set window context from window manager data.
     *
     * @param {Object} windowData - From getActiveWindows()
     */
    setWindowContext(windowData) {
      state.setWindow(
        {
          window_close_time: windowData.end_time,
          symbol: windowData.crypto,
          strike_price: windowData.reference_price || null,
          oracle_price_at_open: null,
          resolved_direction: null,
        },
        new Date(windowData.epoch * 1000).toISOString()
      );
    },

    /**
     * Update time to close from current wall-clock ms.
     *
     * @param {number} nowMs - Current time in ms (Date.now())
     */
    updateTimeToCloseMs(nowMs) {
      state.updateTimeToCloseMs(nowMs);
    },

    /**
     * Reset state for a new window.
     */
    reset() {
      state.reset();
    },

    // ── Proxy getters ──

    get clobUp() { return state.clobUp; },
    get clobDown() { return state.clobDown; },
    get chainlink() { return state.chainlink; },
    get polyRef() { return state.polyRef; },
    get window() { return state.window; },
    get timestamp() { return state.timestamp; },
  };
}
