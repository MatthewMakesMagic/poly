/**
 * Backtest Metrics Calculator
 *
 * Calculates performance metrics including Sharpe ratio,
 * max drawdown, win rate, and other risk-adjusted statistics.
 */

/**
 * @typedef {Object} PerformanceMetrics
 * @property {number} totalReturn - Total return percentage
 * @property {number} annualizedReturn - Annualized return percentage
 * @property {number} sharpeRatio - Sharpe ratio (annualized)
 * @property {number} sortinoRatio - Sortino ratio (downside risk)
 * @property {number} maxDrawdown - Maximum drawdown percentage
 * @property {number} calmarRatio - Calmar ratio (return/max drawdown)
 * @property {number} winRate - Win rate percentage
 * @property {number} profitFactor - Gross profit / gross loss
 * @property {number} avgWin - Average winning trade
 * @property {number} avgLoss - Average losing trade
 * @property {number} expectancy - Expected value per trade
 * @property {number} payoffRatio - Average win / average loss
 */

/**
 * Calculate annualized Sharpe ratio
 *
 * @param {number[]} returns - Array of periodic returns
 * @param {number} [riskFreeRate=0] - Risk-free rate (annualized)
 * @param {number} [periodsPerYear=252] - Trading periods per year
 * @returns {number} Sharpe ratio
 */
export function calculateSharpeRatio(returns, riskFreeRate = 0, periodsPerYear = 252) {
  if (!returns || returns.length < 2) {
    return 0;
  }

  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return 0;
  }

  const excessReturn = avgReturn - (riskFreeRate / periodsPerYear);
  return (excessReturn / stdDev) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate Sortino ratio (uses only downside deviation)
 *
 * @param {number[]} returns - Array of periodic returns
 * @param {number} [targetReturn=0] - Target return (MAR)
 * @param {number} [periodsPerYear=252] - Trading periods per year
 * @returns {number} Sortino ratio
 */
export function calculateSortinoRatio(returns, targetReturn = 0, periodsPerYear = 252) {
  if (!returns || returns.length < 2) {
    return 0;
  }

  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Calculate downside deviation (only negative deviations from target)
  const downsideReturns = returns.filter(r => r < targetReturn);
  if (downsideReturns.length === 0) {
    return avgReturn > targetReturn ? Infinity : 0;
  }

  const downsideVariance = downsideReturns.reduce(
    (s, r) => s + Math.pow(r - targetReturn, 2),
    0
  ) / returns.length; // Use total count for proper scaling

  const downsideDeviation = Math.sqrt(downsideVariance);

  if (downsideDeviation === 0) {
    return 0;
  }

  return ((avgReturn - targetReturn) / downsideDeviation) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate maximum drawdown from equity curve
 *
 * @param {number[]} equityCurve - Array of equity values
 * @returns {{ maxDrawdown: number, maxDrawdownPct: number, drawdownDuration: number }}
 */
export function calculateMaxDrawdown(equityCurve) {
  if (!equityCurve || equityCurve.length < 2) {
    return { maxDrawdown: 0, maxDrawdownPct: 0, drawdownDuration: 0 };
  }

  let peak = equityCurve[0];
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let drawdownStart = 0;
  let maxDrawdownDuration = 0;
  let currentDrawdownStart = 0;
  let inDrawdown = false;

  for (let i = 0; i < equityCurve.length; i++) {
    const value = equityCurve[i];

    if (value > peak) {
      // New peak - reset drawdown tracking
      if (inDrawdown) {
        const duration = i - currentDrawdownStart;
        if (duration > maxDrawdownDuration) {
          maxDrawdownDuration = duration;
        }
      }
      peak = value;
      inDrawdown = false;
    } else {
      // In drawdown
      if (!inDrawdown) {
        currentDrawdownStart = i;
        inDrawdown = true;
      }

      const drawdown = peak - value;
      const drawdownPct = drawdown / peak;

      if (drawdownPct > maxDrawdownPct) {
        maxDrawdown = drawdown;
        maxDrawdownPct = drawdownPct;
        drawdownStart = currentDrawdownStart;
      }
    }
  }

  // Check if still in drawdown at end
  if (inDrawdown) {
    const duration = equityCurve.length - currentDrawdownStart;
    if (duration > maxDrawdownDuration) {
      maxDrawdownDuration = duration;
    }
  }

  return {
    maxDrawdown,
    maxDrawdownPct,
    drawdownDuration: maxDrawdownDuration,
  };
}

/**
 * Calculate profit factor
 *
 * @param {Object[]} trades - Array of trade objects with pnl property
 * @returns {number} Profit factor (gross profit / gross loss)
 */
export function calculateProfitFactor(trades) {
  if (!trades || trades.length === 0) {
    return 0;
  }

  const grossProfit = trades
    .filter(t => t.pnl > 0)
    .reduce((s, t) => s + t.pnl, 0);

  const grossLoss = Math.abs(
    trades
      .filter(t => t.pnl < 0)
      .reduce((s, t) => s + t.pnl, 0)
  );

  if (grossLoss === 0) {
    return grossProfit > 0 ? Infinity : 0;
  }

  return grossProfit / grossLoss;
}

/**
 * Calculate expectancy (expected value per trade)
 *
 * @param {Object[]} trades - Array of trade objects with pnl property
 * @returns {number} Expected value per trade
 */
export function calculateExpectancy(trades) {
  if (!trades || trades.length === 0) {
    return 0;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;

  return (winRate * avgWin) - ((1 - winRate) * avgLoss);
}

/**
 * Calculate all performance metrics
 *
 * @param {Object} backtest - Backtest result object
 * @param {Object[]} backtest.trades - Array of trades
 * @param {number[]} backtest.equityCurve - Equity curve
 * @param {Object} backtest.summary - Summary with initialCapital, finalCapital
 * @param {Object} backtest.config - Config with startDate, endDate
 * @returns {PerformanceMetrics} Complete metrics object
 */
export function calculateMetrics(backtest) {
  const { trades, equityCurve, summary, config } = backtest;

  if (!trades || trades.length === 0) {
    return {
      totalReturn: 0,
      annualizedReturn: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdown: 0,
      calmarRatio: 0,
      winRate: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      expectancy: 0,
      payoffRatio: 0,
    };
  }

  // Calculate returns from equity curve
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const ret = (equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1];
    returns.push(ret);
  }

  // Calculate time period in years
  const startDate = new Date(config.startDate);
  const endDate = new Date(config.endDate);
  const daysInPeriod = (endDate - startDate) / (1000 * 60 * 60 * 24);
  const yearsInPeriod = Math.max(daysInPeriod / 365, 0.01); // Avoid division by zero

  // Total return
  const totalReturn = summary.returnPct || 0;

  // Annualized return
  const annualizedReturn = Math.pow(1 + totalReturn, 1 / yearsInPeriod) - 1;

  // Calculate drawdown
  const drawdownResult = calculateMaxDrawdown(equityCurve);

  // Sharpe and Sortino (using trade-level returns)
  const sharpeRatio = calculateSharpeRatio(returns);
  const sortinoRatio = calculateSortinoRatio(returns);

  // Calmar ratio
  const calmarRatio = drawdownResult.maxDrawdownPct > 0
    ? annualizedReturn / drawdownResult.maxDrawdownPct
    : 0;

  // Trade statistics
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  const profitFactor = calculateProfitFactor(trades);
  const expectancy = calculateExpectancy(trades);
  const payoffRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  return {
    totalReturn,
    annualizedReturn,
    sharpeRatio,
    sortinoRatio,
    maxDrawdown: drawdownResult.maxDrawdownPct,
    calmarRatio,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    expectancy,
    payoffRatio,
  };
}

/**
 * Calculate metrics for a subset of trades (e.g., by symbol or time period)
 *
 * @param {Object[]} trades - Subset of trades
 * @param {number} initialCapital - Initial capital for the subset
 * @returns {Object} Subset metrics
 */
export function calculateSubsetMetrics(trades, initialCapital = 1000) {
  if (!trades || trades.length === 0) {
    return {
      tradeCount: 0,
      winRate: 0,
      totalPnl: 0,
      returnPct: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      expectancy: 0,
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  return {
    tradeCount: trades.length,
    winRate: wins.length / trades.length,
    totalPnl,
    returnPct: totalPnl / initialCapital,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
    profitFactor: calculateProfitFactor(trades),
    expectancy: calculateExpectancy(trades),
  };
}
