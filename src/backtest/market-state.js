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
      this.chainlink = {
        price: parseFloat(event.price),
        ts: event.timestamp,
      };
    } else if (source === 'polyRef') {
      this.polyRef = {
        price: parseFloat(event.price),
        ts: event.timestamp,
      };
    } else if (source === 'clobUp') {
      this.clobUp = {
        bestBid: parseFloat(event.best_bid),
        bestAsk: parseFloat(event.best_ask),
        mid: parseFloat(event.mid_price),
        spread: parseFloat(event.spread),
        bidSize: parseFloat(event.bid_size_top || 0),
        askSize: parseFloat(event.ask_size_top || 0),
        ts: event.timestamp,
      };
    } else if (source === 'clobDown') {
      this.clobDown = {
        bestBid: parseFloat(event.best_bid),
        bestAsk: parseFloat(event.best_ask),
        mid: parseFloat(event.mid_price),
        spread: parseFloat(event.spread),
        bidSize: parseFloat(event.bid_size_top || 0),
        askSize: parseFloat(event.ask_size_top || 0),
        ts: event.timestamp,
      };
    } else if (source.startsWith('exchange_')) {
      const exchangeName = source.slice('exchange_'.length);
      this._exchanges.set(exchangeName, {
        price: parseFloat(event.price),
        bid: event.bid != null ? parseFloat(event.bid) : null,
        ask: event.ask != null ? parseFloat(event.ask) : null,
        ts: event.timestamp,
      });
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
    this.window = {
      id: closeTime, // use close time as window ID
      symbol: windowEvent.symbol,
      openTime: openTime || null,
      closeTime,
      timeToCloseMs: null,
      resolvedDirection: windowEvent.resolved_direction || null,
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
    const closeMs = new Date(this.window.closeTime).getTime();
    this.window.timeToCloseMs = Math.max(0, closeMs - currentMs);
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
    this.clobUp = null;
    this.clobDown = null;
    this.window = null;
    this._exchanges.clear();
    this._positions = [];
    this._tickCount = 0;
  }
}
