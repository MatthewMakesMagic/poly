/**
 * Market State Reconstruction
 *
 * Reconstructs market state at any timestamp from tick data.
 * Maintains the latest prices for each symbol/topic combination
 * and provides snapshot functionality for strategy evaluation.
 */

/**
 * @typedef {Object} PricePoint
 * @property {number} price - Price value
 * @property {string} timestamp - ISO timestamp
 * @property {string} topic - Source topic
 */

/**
 * @typedef {Object} SymbolState
 * @property {string} symbol - Symbol name
 * @property {Map<string, PricePoint>} pricesByTopic - Latest price for each topic
 * @property {number|null} spotPrice - Latest spot price (binance)
 * @property {number|null} oraclePrice - Latest oracle price (chainlink)
 * @property {string|null} lastUpdate - ISO timestamp of last update
 */

/**
 * @typedef {Object} MarketSnapshot
 * @property {string} timestamp - Snapshot timestamp
 * @property {Object.<string, SymbolState>} symbols - State by symbol
 */

/**
 * Market state manager for backtesting
 *
 * Incrementally builds market state from tick stream.
 */
export class MarketState {
  constructor() {
    /** @type {Map<string, SymbolState>} */
    this.symbols = new Map();

    /** @type {string|null} */
    this.currentTimestamp = null;

    /** @type {number} */
    this.tickCount = 0;
  }

  /**
   * Process a tick and update market state
   *
   * @param {Object} tick - Tick row from database
   * @param {string} tick.timestamp - ISO timestamp
   * @param {string} tick.symbol - Symbol
   * @param {string} tick.topic - Topic (binance, chainlink, etc.)
   * @param {number} tick.price - Price value
   */
  processTick(tick) {
    const { timestamp, symbol, topic, price } = tick;

    // Get or create symbol state
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, {
        symbol,
        pricesByTopic: new Map(),
        spotPrice: null,
        oraclePrice: null,
        lastUpdate: null,
      });
    }

    const symbolState = this.symbols.get(symbol);

    // Update topic price
    symbolState.pricesByTopic.set(topic, {
      price,
      timestamp,
      topic,
    });

    // Update convenience fields
    if (topic === 'binance' || topic === 'spot') {
      symbolState.spotPrice = price;
    } else if (topic === 'chainlink' || topic === 'oracle') {
      symbolState.oraclePrice = price;
    }

    symbolState.lastUpdate = timestamp;
    this.currentTimestamp = timestamp;
    this.tickCount++;
  }

  /**
   * Process multiple ticks
   *
   * @param {Object[]} ticks - Array of tick rows
   */
  processTicks(ticks) {
    for (const tick of ticks) {
      this.processTick(tick);
    }
  }

  /**
   * Get current market state snapshot
   *
   * @returns {MarketSnapshot} Current state snapshot
   */
  getSnapshot() {
    const symbolsObj = {};

    for (const [symbol, state] of this.symbols) {
      symbolsObj[symbol] = {
        symbol: state.symbol,
        spotPrice: state.spotPrice,
        oraclePrice: state.oraclePrice,
        lastUpdate: state.lastUpdate,
        pricesByTopic: Object.fromEntries(state.pricesByTopic),
      };
    }

    return {
      timestamp: this.currentTimestamp,
      symbols: symbolsObj,
    };
  }

  /**
   * Get state for a specific symbol
   *
   * @param {string} symbol - Symbol to get
   * @returns {SymbolState|null} Symbol state or null
   */
  getSymbolState(symbol) {
    return this.symbols.get(symbol) || null;
  }

  /**
   * Get spot price for a symbol
   *
   * @param {string} symbol - Symbol to get
   * @returns {number|null} Spot price or null
   */
  getSpotPrice(symbol) {
    const state = this.symbols.get(symbol);
    return state?.spotPrice ?? null;
  }

  /**
   * Get oracle price for a symbol
   *
   * @param {string} symbol - Symbol to get
   * @returns {number|null} Oracle price or null
   */
  getOraclePrice(symbol) {
    const state = this.symbols.get(symbol);
    return state?.oraclePrice ?? null;
  }

  /**
   * Get price spread between spot and oracle
   *
   * @param {string} symbol - Symbol to get
   * @returns {number|null} Spread (spot - oracle) or null
   */
  getSpread(symbol) {
    const state = this.symbols.get(symbol);
    if (!state || state.spotPrice === null || state.oraclePrice === null) {
      return null;
    }
    return state.spotPrice - state.oraclePrice;
  }

  /**
   * Get price spread as percentage
   *
   * @param {string} symbol - Symbol to get
   * @returns {number|null} Spread percentage or null
   */
  getSpreadPct(symbol) {
    const state = this.symbols.get(symbol);
    if (!state || state.spotPrice === null || state.oraclePrice === null) {
      return null;
    }
    if (state.oraclePrice === 0) return null;
    return (state.spotPrice - state.oraclePrice) / state.oraclePrice;
  }

  /**
   * Check if we have both spot and oracle prices for a symbol
   *
   * @param {string} symbol - Symbol to check
   * @returns {boolean} True if both prices available
   */
  hasBothPrices(symbol) {
    const state = this.symbols.get(symbol);
    return state?.spotPrice !== null && state?.oraclePrice !== null;
  }

  /**
   * Get all symbols with data
   *
   * @returns {string[]} Array of symbols
   */
  getSymbols() {
    return Array.from(this.symbols.keys());
  }

  /**
   * Reset market state
   */
  reset() {
    this.symbols.clear();
    this.currentTimestamp = null;
    this.tickCount = 0;
  }

  /**
   * Get tick count processed
   *
   * @returns {number} Number of ticks processed
   */
  getTickCount() {
    return this.tickCount;
  }
}

/**
 * Create a new market state manager
 *
 * @returns {MarketState} New market state instance
 */
export function createMarketState() {
  return new MarketState();
}
