/**
 * Position and P&L Simulator
 *
 * Supports two modes:
 *   1. Continuous (legacy) — long/short positions on price movement
 *   2. Binary options — buy tokens at 0-1.00 price, resolve to 1.00 or 0.00
 *
 * Binary option mechanics:
 *   - Buy token at market price (e.g. 0.55) → costs price * size
 *   - Resolution: winning tokens pay 1.00 * size, losing pay 0.00
 *   - PnL = payout - cost
 */

/**
 * @typedef {Object} BinaryPosition
 * @property {string} id - Position ID
 * @property {string} token - Token identifier (e.g. 'btc_up', 'btc_down')
 * @property {number} entryPrice - Price paid per token (0-1.00)
 * @property {number} size - Number of tokens (dollar-denominated)
 * @property {number} cost - Total cost (entryPrice * size)
 * @property {string} timestamp - Entry timestamp
 * @property {string|null} reason - Entry reason
 * @property {boolean} resolved - Whether position has been resolved
 * @property {number|null} payout - Payout amount (after resolution)
 * @property {number|null} pnl - Realized PnL (after resolution)
 * @property {string|null} exitTimestamp - Resolution/exit timestamp
 * @property {string|null} exitReason - 'resolution' | 'early_exit'
 */

export class Simulator {
  /**
   * @param {Object} [options]
   * @param {number} [options.initialCapital=100] - Starting capital
   * @param {number} [options.spreadBuffer=0.005] - Default spread buffer for execution
   * @param {number} [options.tradingFee=0] - Fee per trade
   * @param {Function} [options.executionFn] - Custom execution function
   */
  constructor(options = {}) {
    const {
      initialCapital = 100,
      spreadBuffer = 0.005,
      tradingFee = 0,
      executionFn = null,
    } = options;

    this.initialCapital = initialCapital;
    this.capital = initialCapital;
    this.spreadBuffer = spreadBuffer;
    this.tradingFee = tradingFee;
    this.executionFn = executionFn;

    /** @type {BinaryPosition[]} */
    this.positions = [];

    /** @type {BinaryPosition[]} */
    this.resolvedPositions = [];

    this.totalPnl = 0;
    this.peakCapital = initialCapital;
    this.maxDrawdown = 0;
    this.equityCurve = [initialCapital];
    this.positionIdCounter = 0;
    this._windowPnl = 0;
  }

  // ─── Execution Model ───

  /**
   * Execute a signal against current market state.
   * Returns fill details or rejection.
   *
   * @param {Object} signal - Strategy signal
   * @param {string} signal.action - 'buy' or 'sell'
   * @param {string} signal.token - Token to trade
   * @param {number} signal.size - Dollar amount
   * @param {Object} state - Current MarketState
   * @param {Object} [config] - Execution config overrides
   * @returns {{ filled: boolean, fillPrice?: number, fillSize?: number, cost?: number, reason: string }}
   */
  execute(signal, state, config = {}) {
    // Allow pluggable execution
    if (this.executionFn) {
      return this.executionFn(signal, state, config);
    }

    const buffer = config.spreadBuffer ?? this.spreadBuffer;
    const isDown = signal.token.toLowerCase().includes('down');
    const clobData = isDown ? state.clobDown : state.clobUp;

    if (!clobData) {
      return { filled: false, reason: 'no_clob_data' };
    }

    if (signal.action === 'buy') {
      const fillPrice = clobData.bestAsk + buffer;
      if (fillPrice <= 0 || fillPrice >= 1) {
        return { filled: false, reason: `invalid_fill_price_${fillPrice}` };
      }
      const cost = fillPrice * signal.size;
      if (cost > this.capital) {
        return { filled: false, reason: 'insufficient_capital' };
      }
      return { filled: true, fillPrice, fillSize: signal.size, cost, reason: 'filled' };
    }

    if (signal.action === 'sell') {
      const fillPrice = clobData.bestBid - buffer;
      if (fillPrice <= 0) {
        return { filled: false, reason: `invalid_fill_price_${fillPrice}` };
      }
      return { filled: true, fillPrice, fillSize: signal.size, cost: 0, reason: 'filled' };
    }

    return { filled: false, reason: 'unknown_action' };
  }

  // ─── Binary Option Methods ───

  /**
   * Buy a binary option token.
   *
   * @param {Object} params
   * @param {string} params.token - Token identifier
   * @param {number} params.price - Fill price (0-1.00)
   * @param {number} params.size - Number of tokens
   * @param {string} params.timestamp - Entry timestamp
   * @param {string} [params.reason] - Entry reason
   * @returns {BinaryPosition}
   */
  buyToken({ token, price, size, timestamp, reason = '' }) {
    const cost = price * size;
    this.capital -= cost + this.tradingFee;

    const position = {
      id: `pos-${++this.positionIdCounter}`,
      token,
      entryPrice: price,
      size,
      cost,
      timestamp,
      reason,
      resolved: false,
      payout: null,
      pnl: null,
      exitTimestamp: null,
      exitReason: null,
    };

    this.positions.push(position);
    this._updateDrawdown();
    return position;
  }

  /**
   * Sell a token early on CLOB (before window resolution).
   *
   * @param {Object} params
   * @param {string} params.token - Token to sell
   * @param {number} params.price - Sell price from CLOB
   * @param {string} params.timestamp
   * @param {string} [params.reason]
   * @returns {BinaryPosition|null} The closed position, or null if no matching position
   */
  sellToken({ token, price, timestamp, reason = 'early_exit' }) {
    const idx = this.positions.findIndex(p => p.token === token && !p.resolved);
    if (idx === -1) return null;

    const position = this.positions[idx];
    const revenue = price * position.size;
    const pnl = revenue - position.cost;

    position.resolved = true;
    position.payout = revenue;
    position.pnl = pnl;
    position.exitTimestamp = timestamp;
    position.exitReason = reason;

    this.capital += revenue - this.tradingFee;
    this.totalPnl += pnl;
    this._windowPnl += pnl;

    // Move to resolved
    this.positions.splice(idx, 1);
    this.resolvedPositions.push(position);
    this._updateDrawdown();
    this.equityCurve.push(this.capital);

    return position;
  }

  /**
   * Resolve all open positions for the current window.
   * UP tokens pay 1.00 if direction=UP, else 0.00.
   * DOWN tokens pay 1.00 if direction=DOWN, else 0.00.
   *
   * @param {Object} params
   * @param {string} params.direction - 'UP' or 'DOWN'
   * @param {string} params.timestamp
   */
  resolveWindow({ direction, timestamp }) {
    const dirUpper = direction.toUpperCase();
    const toResolve = [...this.positions]; // copy — we'll mutate positions
    this.positions = [];

    for (const position of toResolve) {
      const tokenIsUp = !position.token.toLowerCase().includes('down');
      const wins = (tokenIsUp && dirUpper === 'UP') || (!tokenIsUp && dirUpper === 'DOWN');

      const payout = wins ? 1.00 * position.size : 0.00;
      const pnl = payout - position.cost;

      position.resolved = true;
      position.payout = payout;
      position.pnl = pnl;
      position.exitTimestamp = timestamp;
      position.exitReason = 'resolution';

      this.capital += payout;
      this.totalPnl += pnl;
      this._windowPnl += pnl;

      this.resolvedPositions.push(position);
    }

    this._updateDrawdown();
    this.equityCurve.push(this.capital);
  }

  /**
   * Get PnL for the current window, then reset window PnL tracker.
   *
   * @returns {number}
   */
  getWindowPnL() {
    return this._windowPnl;
  }

  /**
   * Reset the per-window PnL accumulator.
   */
  resetWindowPnL() {
    this._windowPnl = 0;
  }

  // ─── Queries ───

  /**
   * Get all open (unresolved) positions.
   *
   * @returns {BinaryPosition[]}
   */
  getOpenPositions() {
    return [...this.positions];
  }

  /**
   * Get all resolved positions (trades).
   *
   * @returns {BinaryPosition[]}
   */
  getTrades() {
    return [...this.resolvedPositions];
  }

  /**
   * Check if any position is open for a given token.
   *
   * @param {string} token
   * @returns {boolean}
   */
  hasPosition(token) {
    return this.positions.some(p => p.token === token);
  }

  getCapital() {
    return this.capital;
  }

  getTotalPnl() {
    return this.totalPnl;
  }

  getReturnPct() {
    return (this.capital - this.initialCapital) / this.initialCapital;
  }

  getMaxDrawdown() {
    return this.maxDrawdown;
  }

  getEquityCurve() {
    return [...this.equityCurve];
  }

  getStats() {
    const trades = this.resolvedPositions;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    return {
      initialCapital: this.initialCapital,
      finalCapital: this.capital,
      totalPnl: this.totalPnl,
      returnPct: this.getReturnPct(),
      maxDrawdown: this.maxDrawdown,
      tradeCount: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
      avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
      openPositions: this.positions.length,
    };
  }

  // ─── Internal ───

  _updateDrawdown() {
    if (this.capital > this.peakCapital) {
      this.peakCapital = this.capital;
    }
    if (this.peakCapital > 0) {
      const dd = (this.peakCapital - this.capital) / this.peakCapital;
      if (dd > this.maxDrawdown) {
        this.maxDrawdown = dd;
      }
    }
  }

  reset() {
    this.capital = this.initialCapital;
    this.positions = [];
    this.resolvedPositions = [];
    this.totalPnl = 0;
    this.peakCapital = this.initialCapital;
    this.maxDrawdown = 0;
    this.equityCurve = [this.initialCapital];
    this.positionIdCounter = 0;
    this._windowPnl = 0;
  }
}

export function createSimulator(options) {
  return new Simulator(options);
}
