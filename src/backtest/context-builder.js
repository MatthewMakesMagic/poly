/**
 * Context Builder for Strategy Evaluation
 *
 * Builds strategy evaluation context from market state,
 * compatible with the existing strategy execution pipeline.
 */

/**
 * @typedef {Object} StrategyContext
 * @property {string} symbol - Symbol being evaluated
 * @property {string} timestamp - Current timestamp
 * @property {Object} market - Market data
 * @property {number} market.spotPrice - Current spot price
 * @property {number} market.oraclePrice - Current oracle price
 * @property {number} market.spread - Price spread
 * @property {number} market.spreadPct - Spread as percentage
 * @property {Object} position - Position state (simulated)
 * @property {boolean} position.isOpen - Whether position is open
 * @property {string|null} position.direction - 'long' or 'short' if open
 * @property {number|null} position.entryPrice - Entry price if open
 * @property {number|null} position.size - Position size if open
 * @property {number|null} position.unrealizedPnl - Unrealized P&L if open
 * @property {Object} window - Trading window info
 * @property {string|null} window.id - Window identifier
 * @property {number|null} window.timeRemainingMs - Time remaining in window
 * @property {Object} history - Recent history
 * @property {number[]} history.recentSpotPrices - Recent spot prices
 * @property {number[]} history.recentOraclePrices - Recent oracle prices
 */

/**
 * Context builder for backtesting
 *
 * Maintains rolling history and builds context objects
 * for strategy evaluation.
 */
export class ContextBuilder {
  /**
   * @param {Object} [options] - Builder options
   * @param {number} [options.historySize=100] - Number of prices to keep in history
   */
  constructor(options = {}) {
    const { historySize = 100 } = options;

    /** @type {number} */
    this.historySize = historySize;

    /** @type {Map<string, number[]>} */
    this.spotHistory = new Map();

    /** @type {Map<string, number[]>} */
    this.oracleHistory = new Map();

    /** @type {Map<string, Object>} */
    this.simulatedPositions = new Map();

    /** @type {string|null} */
    this.currentWindowId = null;

    /** @type {number|null} */
    this.windowStartTime = null;

    /** @type {number} */
    this.windowDurationMs = 15 * 60 * 1000; // 15 minutes default
  }

  /**
   * Update history with new prices from market state
   *
   * @param {string} symbol - Symbol
   * @param {number|null} spotPrice - Current spot price
   * @param {number|null} oraclePrice - Current oracle price
   */
  updateHistory(symbol, spotPrice, oraclePrice) {
    // Update spot history
    if (spotPrice !== null) {
      if (!this.spotHistory.has(symbol)) {
        this.spotHistory.set(symbol, []);
      }
      const history = this.spotHistory.get(symbol);
      history.push(spotPrice);
      if (history.length > this.historySize) {
        history.shift();
      }
    }

    // Update oracle history
    if (oraclePrice !== null) {
      if (!this.oracleHistory.has(symbol)) {
        this.oracleHistory.set(symbol, []);
      }
      const history = this.oracleHistory.get(symbol);
      history.push(oraclePrice);
      if (history.length > this.historySize) {
        history.shift();
      }
    }
  }

  /**
   * Set current trading window
   *
   * @param {string} windowId - Window identifier
   * @param {number} startTimeMs - Window start time in ms
   * @param {number} [durationMs] - Window duration in ms
   */
  setWindow(windowId, startTimeMs, durationMs) {
    this.currentWindowId = windowId;
    this.windowStartTime = startTimeMs;
    if (durationMs) {
      this.windowDurationMs = durationMs;
    }
  }

  /**
   * Update simulated position for a symbol
   *
   * @param {string} symbol - Symbol
   * @param {Object|null} position - Position state or null to clear
   */
  setPosition(symbol, position) {
    if (position === null) {
      this.simulatedPositions.delete(symbol);
    } else {
      this.simulatedPositions.set(symbol, position);
    }
  }

  /**
   * Get simulated position for a symbol
   *
   * @param {string} symbol - Symbol
   * @returns {Object|null} Position or null
   */
  getPosition(symbol) {
    return this.simulatedPositions.get(symbol) || null;
  }

  /**
   * Build strategy context for a symbol
   *
   * @param {string} symbol - Symbol to build context for
   * @param {import('./market-state.js').MarketState} marketState - Current market state
   * @param {string} timestamp - Current timestamp
   * @returns {StrategyContext} Strategy evaluation context
   */
  buildContext(symbol, marketState, timestamp) {
    const spotPrice = marketState.getSpotPrice(symbol);
    const oraclePrice = marketState.getOraclePrice(symbol);

    // Update history
    this.updateHistory(symbol, spotPrice, oraclePrice);

    // Calculate spread
    const spread = spotPrice !== null && oraclePrice !== null
      ? spotPrice - oraclePrice
      : null;
    const spreadPct = spread !== null && oraclePrice !== 0
      ? spread / oraclePrice
      : null;

    // Get position state
    const position = this.simulatedPositions.get(symbol);
    let unrealizedPnl = null;

    if (position && position.isOpen && spotPrice !== null) {
      const priceDiff = spotPrice - position.entryPrice;
      const direction = position.direction === 'long' ? 1 : -1;
      unrealizedPnl = priceDiff * direction * position.size;
    }

    // Calculate window time remaining
    let timeRemainingMs = null;
    if (this.windowStartTime !== null) {
      const currentTimeMs = new Date(timestamp).getTime();
      const windowEndMs = this.windowStartTime + this.windowDurationMs;
      timeRemainingMs = Math.max(0, windowEndMs - currentTimeMs);
    }

    return {
      symbol,
      timestamp,
      market: {
        spotPrice,
        oraclePrice,
        spread,
        spreadPct,
      },
      position: {
        isOpen: position?.isOpen ?? false,
        direction: position?.direction ?? null,
        entryPrice: position?.entryPrice ?? null,
        size: position?.size ?? null,
        unrealizedPnl,
      },
      window: {
        id: this.currentWindowId,
        timeRemainingMs,
      },
      history: {
        recentSpotPrices: [...(this.spotHistory.get(symbol) || [])],
        recentOraclePrices: [...(this.oracleHistory.get(symbol) || [])],
      },
    };
  }

  /**
   * Build contexts for all symbols with data
   *
   * @param {import('./market-state.js').MarketState} marketState - Current market state
   * @param {string} timestamp - Current timestamp
   * @returns {Map<string, StrategyContext>} Contexts by symbol
   */
  buildAllContexts(marketState, timestamp) {
    const contexts = new Map();

    for (const symbol of marketState.getSymbols()) {
      if (marketState.hasBothPrices(symbol)) {
        contexts.set(symbol, this.buildContext(symbol, marketState, timestamp));
      }
    }

    return contexts;
  }

  /**
   * Reset builder state
   */
  reset() {
    this.spotHistory.clear();
    this.oracleHistory.clear();
    this.simulatedPositions.clear();
    this.currentWindowId = null;
    this.windowStartTime = null;
  }
}

/**
 * Create a new context builder
 *
 * @param {Object} [options] - Builder options
 * @returns {ContextBuilder} New context builder
 */
export function createContextBuilder(options) {
  return new ContextBuilder(options);
}
