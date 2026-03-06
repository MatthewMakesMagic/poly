/**
 * Market State for Backtesting
 *
 * Flat state object with 3-tier feed naming:
 *   Oracle:    chainlink (settlement), strike (threshold)
 *   Reference: polyRef (Polymarket composite — NOT Binance)
 *   Exchange:  binance, coinbase, kraken, bybit, okx
 *   CLOB:      clobUp, clobDown (token prices)
 *
 * Updated incrementally by processEvent() during replay.
 */

/**
 * Create a fresh market state object.
 *
 * @returns {MarketState}
 */
export function createMarketState() {
  return new MarketState();
}

export class MarketState {
  constructor() {
    this.timestamp = null;

    // Oracle tier (settlement)
    this.chainlink = null;  // { price, ts }
    this.strike = null;     // number — from window_close_events.strike_price

    // Reference tier
    this.polyRef = null;    // { price, ts }
    this.coingecko = null;  // { price, ts } — CoinGecko 1700+ exchange VWAP

    // CLOB tier
    this.clobUp = null;     // { bestBid, bestAsk, mid, spread, bidSize, askSize, ts }
    this.clobDown = null;   // { bestBid, bestAsk, mid, spread, bidSize, askSize, ts }

    // Window context
    this.window = null;     // { id, symbol, openTime, closeTime, timeToCloseMs, resolvedDirection }

    // Internal
    this._exchanges = new Map();  // exchange name → { price, bid, ask, ts }
    this._positions = [];         // set by simulator
    this._tickCount = 0;
  }

  /**
   * Process a timeline event and update appropriate state field.
   *
   * @param {Object} event - Event with `source` tag from loadMergedTimeline
   */
  processEvent(event) {
    this.timestamp = event.timestamp;
    this._tickCount++;

    const { source } = event;

    if (source === 'chainlink') {
      if (!this.chainlink) this.chainlink = { price: 0, ts: null };
      this.chainlink.price = parseFloat(event.price);
      this.chainlink.ts = event.timestamp;
    } else if (source === 'polyRef') {
      if (!this.polyRef) this.polyRef = { price: 0, ts: null };
      this.polyRef.price = parseFloat(event.price);
      this.polyRef.ts = event.timestamp;
    } else if (source === 'coingecko') {
      if (!this.coingecko) this.coingecko = { price: 0, ts: null };
      this.coingecko.price = parseFloat(event.price);
      this.coingecko.ts = event.timestamp;
    } else if (source === 'clobUp') {
      if (!this.clobUp) this.clobUp = {};
      const bid = parseFloat(event.best_bid);
      const ask = parseFloat(event.best_ask);
      // Only accept CLOB bid/ask in tradeable range (0.01–0.99).
      // Stale snapshots from near-resolved books have extreme values.
      if (bid && bid >= 0.01 && bid <= 0.99) this.clobUp.bestBid = bid;
      if (ask && ask >= 0.01 && ask <= 0.99) this.clobUp.bestAsk = ask;
      if (bid && ask && bid >= 0.01 && ask <= 0.99) {
        this.clobUp.mid = (bid + ask) / 2;
      }
      this.clobUp.spread = parseFloat(event.spread);
      this.clobUp.bidSize = parseFloat(event.bid_size_top || 0);
      this.clobUp.askSize = parseFloat(event.ask_size_top || 0);
      this.clobUp.ts = event.timestamp;
    } else if (source === 'clobDown') {
      if (!this.clobDown) this.clobDown = {};
      const bid = parseFloat(event.best_bid);
      const ask = parseFloat(event.best_ask);
      if (bid && bid >= 0.01 && bid <= 0.99) this.clobDown.bestBid = bid;
      if (ask && ask >= 0.01 && ask <= 0.99) this.clobDown.bestAsk = ask;
      if (bid && ask && bid >= 0.01 && ask <= 0.99) {
        this.clobDown.mid = (bid + ask) / 2;
      }
      this.clobDown.spread = parseFloat(event.spread);
      this.clobDown.bidSize = parseFloat(event.bid_size_top || 0);
      this.clobDown.askSize = parseFloat(event.ask_size_top || 0);
      this.clobDown.ts = event.timestamp;
    } else if (source === 'l2Up') {
      if (!this.clobUp) this.clobUp = {};
      const bid = parseFloat(event.best_bid);
      const ask = parseFloat(event.best_ask);
      // Only accept L2 bid/ask in the tradeable range (0.01–0.99).
      // Values outside this are dust from nearly-resolved books.
      if (bid && bid >= 0.01 && bid <= 0.99) this.clobUp.bestBid = bid;
      if (ask && ask >= 0.01 && ask <= 0.99) this.clobUp.bestAsk = ask;
      if (bid && ask && bid >= 0.01 && ask <= 0.99) {
        this.clobUp.mid = (bid + ask) / 2;
      }
      this.clobUp.levels = event.top_levels;
      this.clobUp.bidDepth1pct = parseFloat(event.bid_depth_1pct) || 0;
      this.clobUp.askDepth1pct = parseFloat(event.ask_depth_1pct) || 0;
      this.clobUp.ts = event.timestamp;
    } else if (source === 'l2Down') {
      if (!this.clobDown) this.clobDown = {};
      const bid = parseFloat(event.best_bid);
      const ask = parseFloat(event.best_ask);
      if (bid && bid >= 0.01 && bid <= 0.99) this.clobDown.bestBid = bid;
      if (ask && ask >= 0.01 && ask <= 0.99) this.clobDown.bestAsk = ask;
      if (bid && ask && bid >= 0.01 && ask <= 0.99) {
        this.clobDown.mid = (bid + ask) / 2;
      }
      this.clobDown.levels = event.top_levels;
      this.clobDown.bidDepth1pct = parseFloat(event.bid_depth_1pct) || 0;
      this.clobDown.askDepth1pct = parseFloat(event.ask_depth_1pct) || 0;
      this.clobDown.ts = event.timestamp;
    } else if (source.startsWith('exchange_')) {
      const exchangeName = source.slice('exchange_'.length);
      let ex = this._exchanges.get(exchangeName);
      if (!ex) {
        ex = { price: 0, bid: null, ask: null, ts: null };
        this._exchanges.set(exchangeName, ex);
      }
      ex.price = parseFloat(event.price);
      ex.bid = event.bid != null ? parseFloat(event.bid) : null;
      ex.ask = event.ask != null ? parseFloat(event.ask) : null;
      ex.ts = event.timestamp;
    }
    // rtds_* topics we don't explicitly model get ignored
  }

  /**
   * Set window context from a window_close_event row.
   * Called by the engine when a new window opens.
   *
   * @param {Object} windowEvent - Row from window_close_events
   * @param {string} [openTime] - Computed open time (closeTime - 5min typically)
   */
  setWindow(windowEvent, openTime) {
    const closeTime = windowEvent.window_close_time;
    this.strike = windowEvent.strike_price != null ? parseFloat(windowEvent.strike_price) : null;
    this.oraclePriceAtOpen = windowEvent.oracle_price_at_open != null ? parseFloat(windowEvent.oracle_price_at_open) : null;
    this._closeMsCached = null; // invalidate cached close time
    this.window = {
      id: closeTime, // use close time as window ID
      symbol: windowEvent.symbol,
      openTime: openTime || null,
      closeTime,
      timeToCloseMs: null,
      resolvedDirection: windowEvent.resolved_direction || null,
      oraclePriceAtOpen: this.oraclePriceAtOpen,
    };
  }

  /**
   * Recalculate timeToCloseMs based on current timestamp.
   *
   * @param {string} timestamp - Current replay timestamp
   */
  updateTimeToClose(timestamp) {
    if (!this.window?.closeTime) return;
    const currentMs = new Date(timestamp).getTime();
    this.updateTimeToCloseMs(currentMs);
  }

  /**
   * Fast path: recalculate timeToCloseMs from pre-parsed ms value.
   *
   * @param {number} currentMs - Current time in ms
   */
  updateTimeToCloseMs(currentMs) {
    if (!this.window) return;
    if (this._closeMsCached == null) {
      this._closeMsCached = new Date(this.window.closeTime).getTime();
    }
    this.window.timeToCloseMs = Math.max(0, this._closeMsCached - currentMs);
  }

  // ─── Exchange Accessors ───

  /**
   * Get data for a specific exchange.
   *
   * @param {string} name - Exchange name (e.g. 'binance', 'coinbase')
   * @returns {{ price: number, bid: number|null, ask: number|null, ts: string }|null}
   */
  getExchange(name) {
    return this._exchanges.get(name) || null;
  }

  /**
   * Get all exchange data.
   *
   * @returns {{ exchange: string, price: number, bid: number|null, ask: number|null, ts: string }[]}
   */
  getAllExchanges() {
    const result = [];
    for (const [exchange, data] of this._exchanges) {
      result.push({ exchange, ...data });
    }
    return result;
  }

  /**
   * Get median price across all available exchanges.
   *
   * @returns {number|null}
   */
  getExchangeMedian() {
    const prices = [];
    for (const data of this._exchanges.values()) {
      if (data.price != null) prices.push(data.price);
    }
    if (prices.length === 0) return null;
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    return prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
  }

  /**
   * Get spread across all exchange prices.
   *
   * @returns {{ min: number, max: number, range: number, rangePct: number }|null}
   */
  getExchangeSpread() {
    const prices = [];
    for (const data of this._exchanges.values()) {
      if (data.price != null) prices.push(data.price);
    }
    if (prices.length < 2) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    const rangePct = min > 0 ? range / min : 0;
    return { min, max, range, rangePct };
  }

  // ─── Derived Metrics ───

  /**
   * Chainlink deficit: how far CL is below strike.
   * Positive = CL below strike = DOWN bias.
   *
   * @returns {number|null}
   */
  getChainlinkDeficit() {
    if (this.strike == null || !this.chainlink?.price) return null;
    return this.strike - this.chainlink.price;
  }

  /**
   * Reference-to-strike gap.
   *
   * @returns {number|null}
   */
  getRefToStrikeGap() {
    if (this.strike == null || !this.polyRef?.price) return null;
    return this.strike - this.polyRef.price;
  }

  /**
   * Get tick count processed.
   *
   * @returns {number}
   */
  getTickCount() {
    return this._tickCount;
  }

  /**
   * Reset all state.
   */
  reset() {
    this.timestamp = null;
    this.chainlink = null;
    this.strike = null;
    this.polyRef = null;
    this.coingecko = null;
    this.clobUp = null;
    this.clobDown = null;
    this.window = null;
    this._exchanges.clear();
    this._positions = [];
    this._tickCount = 0;
    this._closeMsCached = null;
  }
}
