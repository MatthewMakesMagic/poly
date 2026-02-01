/**
 * Position and P&L Simulator
 *
 * Tracks simulated positions, orders, and P&L during backtesting.
 * Provides realistic trade execution simulation with slippage modeling.
 */

/**
 * @typedef {Object} SimulatedOrder
 * @property {string} id - Order ID
 * @property {string} symbol - Symbol
 * @property {string} side - 'buy' or 'sell'
 * @property {number} size - Order size
 * @property {number} price - Execution price
 * @property {string} timestamp - Execution timestamp
 * @property {number} [slippage] - Simulated slippage
 */

/**
 * @typedef {Object} SimulatedPosition
 * @property {string} symbol - Symbol
 * @property {string} direction - 'long' or 'short'
 * @property {number} entryPrice - Average entry price
 * @property {number} size - Position size
 * @property {string} openedAt - ISO timestamp when opened
 * @property {number} unrealizedPnl - Current unrealized P&L
 */

/**
 * @typedef {Object} SimulatedTrade
 * @property {string} id - Trade ID
 * @property {string} symbol - Symbol
 * @property {string} direction - 'long' or 'short'
 * @property {number} entryPrice - Entry price
 * @property {number} exitPrice - Exit price
 * @property {number} size - Trade size
 * @property {number} pnl - Realized P&L
 * @property {number} pnlPct - P&L as percentage
 * @property {string} entryTimestamp - Entry time
 * @property {string} exitTimestamp - Exit time
 * @property {number} durationMs - Trade duration in ms
 * @property {string} exitReason - Reason for exit
 */

/**
 * Position and P&L simulator for backtesting
 */
export class Simulator {
  /**
   * @param {Object} [options] - Simulator options
   * @param {number} [options.initialCapital=1000] - Starting capital
   * @param {number} [options.defaultSlippagePct=0.001] - Default slippage (0.1%)
   * @param {number} [options.tradingFee=0] - Trading fee per trade
   */
  constructor(options = {}) {
    const {
      initialCapital = 1000,
      defaultSlippagePct = 0.001,
      tradingFee = 0,
    } = options;

    /** @type {number} */
    this.initialCapital = initialCapital;

    /** @type {number} */
    this.capital = initialCapital;

    /** @type {number} */
    this.defaultSlippagePct = defaultSlippagePct;

    /** @type {number} */
    this.tradingFee = tradingFee;

    /** @type {Map<string, SimulatedPosition>} */
    this.positions = new Map();

    /** @type {SimulatedTrade[]} */
    this.trades = [];

    /** @type {SimulatedOrder[]} */
    this.orders = [];

    /** @type {number} */
    this.totalPnl = 0;

    /** @type {number} */
    this.peakCapital = initialCapital;

    /** @type {number} */
    this.maxDrawdown = 0;

    /** @type {number[]} */
    this.equityCurve = [initialCapital];

    /** @type {number} */
    this.orderIdCounter = 0;

    /** @type {number} */
    this.tradeIdCounter = 0;
  }

  /**
   * Apply slippage to a price
   *
   * @param {number} price - Base price
   * @param {string} side - 'buy' or 'sell'
   * @param {number} [slippagePct] - Slippage percentage
   * @returns {number} Price with slippage applied
   */
  applySlippage(price, side, slippagePct) {
    const slippage = slippagePct ?? this.defaultSlippagePct;
    const direction = side === 'buy' ? 1 : -1;
    return price * (1 + direction * slippage);
  }

  /**
   * Open a new position
   *
   * @param {Object} params - Position parameters
   * @param {string} params.symbol - Symbol
   * @param {string} params.direction - 'long' or 'short'
   * @param {number} params.size - Position size
   * @param {number} params.price - Current market price
   * @param {string} params.timestamp - Current timestamp
   * @param {number} [params.slippagePct] - Override slippage
   * @returns {SimulatedPosition} Opened position
   */
  openPosition(params) {
    const { symbol, direction, size, price, timestamp, slippagePct } = params;

    if (this.positions.has(symbol)) {
      throw new Error(`Position already open for ${symbol}`);
    }

    // Apply slippage
    const side = direction === 'long' ? 'buy' : 'sell';
    const executionPrice = this.applySlippage(price, side, slippagePct);

    // Create order record
    const order = {
      id: `order-${++this.orderIdCounter}`,
      symbol,
      side,
      size,
      price: executionPrice,
      timestamp,
      slippage: Math.abs(executionPrice - price),
    };
    this.orders.push(order);

    // Create position
    const position = {
      symbol,
      direction,
      entryPrice: executionPrice,
      size,
      openedAt: timestamp,
      unrealizedPnl: 0,
    };
    this.positions.set(symbol, position);

    // Deduct trading fee
    this.capital -= this.tradingFee;

    return position;
  }

  /**
   * Close an existing position
   *
   * @param {Object} params - Close parameters
   * @param {string} params.symbol - Symbol
   * @param {number} params.price - Current market price
   * @param {string} params.timestamp - Current timestamp
   * @param {string} params.reason - Reason for closing
   * @param {number} [params.slippagePct] - Override slippage
   * @returns {SimulatedTrade} Completed trade
   */
  closePosition(params) {
    const { symbol, price, timestamp, reason, slippagePct } = params;

    const position = this.positions.get(symbol);
    if (!position) {
      throw new Error(`No open position for ${symbol}`);
    }

    // Apply slippage (opposite side of entry)
    const side = position.direction === 'long' ? 'sell' : 'buy';
    const executionPrice = this.applySlippage(price, side, slippagePct);

    // Create order record
    const order = {
      id: `order-${++this.orderIdCounter}`,
      symbol,
      side,
      size: position.size,
      price: executionPrice,
      timestamp,
      slippage: Math.abs(executionPrice - price),
    };
    this.orders.push(order);

    // Calculate P&L
    const priceDiff = executionPrice - position.entryPrice;
    const direction = position.direction === 'long' ? 1 : -1;
    const pnl = priceDiff * direction * position.size;
    const pnlPct = priceDiff * direction / position.entryPrice;

    // Create trade record
    const trade = {
      id: `trade-${++this.tradeIdCounter}`,
      symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: executionPrice,
      size: position.size,
      pnl,
      pnlPct,
      entryTimestamp: position.openedAt,
      exitTimestamp: timestamp,
      durationMs: new Date(timestamp).getTime() - new Date(position.openedAt).getTime(),
      exitReason: reason,
    };
    this.trades.push(trade);

    // Update capital and stats
    this.capital += pnl - this.tradingFee;
    this.totalPnl += pnl;

    // Track peak and drawdown
    if (this.capital > this.peakCapital) {
      this.peakCapital = this.capital;
    }
    const currentDrawdown = (this.peakCapital - this.capital) / this.peakCapital;
    if (currentDrawdown > this.maxDrawdown) {
      this.maxDrawdown = currentDrawdown;
    }

    // Update equity curve
    this.equityCurve.push(this.capital);

    // Remove position
    this.positions.delete(symbol);

    return trade;
  }

  /**
   * Update unrealized P&L for all positions
   *
   * @param {Map<string, number>} currentPrices - Current prices by symbol
   */
  updateUnrealizedPnl(currentPrices) {
    for (const [symbol, position] of this.positions) {
      const currentPrice = currentPrices.get(symbol);
      if (currentPrice !== undefined) {
        const priceDiff = currentPrice - position.entryPrice;
        const direction = position.direction === 'long' ? 1 : -1;
        position.unrealizedPnl = priceDiff * direction * position.size;
      }
    }
  }

  /**
   * Check if a position is open for a symbol
   *
   * @param {string} symbol - Symbol to check
   * @returns {boolean} True if position is open
   */
  hasPosition(symbol) {
    return this.positions.has(symbol);
  }

  /**
   * Get position for a symbol
   *
   * @param {string} symbol - Symbol
   * @returns {SimulatedPosition|null} Position or null
   */
  getPosition(symbol) {
    return this.positions.get(symbol) || null;
  }

  /**
   * Get all open positions
   *
   * @returns {SimulatedPosition[]} Array of open positions
   */
  getOpenPositions() {
    return Array.from(this.positions.values());
  }

  /**
   * Get all completed trades
   *
   * @returns {SimulatedTrade[]} Array of trades
   */
  getTrades() {
    return [...this.trades];
  }

  /**
   * Get current capital
   *
   * @returns {number} Current capital
   */
  getCapital() {
    return this.capital;
  }

  /**
   * Get total P&L
   *
   * @returns {number} Total realized P&L
   */
  getTotalPnl() {
    return this.totalPnl;
  }

  /**
   * Get return percentage
   *
   * @returns {number} Return as percentage
   */
  getReturnPct() {
    return (this.capital - this.initialCapital) / this.initialCapital;
  }

  /**
   * Get max drawdown
   *
   * @returns {number} Max drawdown as percentage
   */
  getMaxDrawdown() {
    return this.maxDrawdown;
  }

  /**
   * Get equity curve
   *
   * @returns {number[]} Equity values over time
   */
  getEquityCurve() {
    return [...this.equityCurve];
  }

  /**
   * Get simulator statistics
   *
   * @returns {Object} Statistics summary
   */
  getStats() {
    const wins = this.trades.filter(t => t.pnl > 0);
    const losses = this.trades.filter(t => t.pnl <= 0);

    return {
      initialCapital: this.initialCapital,
      finalCapital: this.capital,
      totalPnl: this.totalPnl,
      returnPct: this.getReturnPct(),
      maxDrawdown: this.maxDrawdown,
      tradeCount: this.trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: this.trades.length > 0 ? wins.length / this.trades.length : 0,
      avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
      openPositions: this.positions.size,
    };
  }

  /**
   * Reset simulator to initial state
   */
  reset() {
    this.capital = this.initialCapital;
    this.positions.clear();
    this.trades = [];
    this.orders = [];
    this.totalPnl = 0;
    this.peakCapital = this.initialCapital;
    this.maxDrawdown = 0;
    this.equityCurve = [this.initialCapital];
    this.orderIdCounter = 0;
    this.tradeIdCounter = 0;
  }
}

/**
 * Create a new simulator
 *
 * @param {Object} [options] - Simulator options
 * @returns {Simulator} New simulator instance
 */
export function createSimulator(options) {
  return new Simulator(options);
}
