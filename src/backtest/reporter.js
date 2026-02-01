/**
 * Backtest Report Generator
 *
 * Outputs backtest results in JSON and CSV formats.
 */

import { calculateMetrics, calculateSubsetMetrics } from './metrics.js';

/**
 * @typedef {Object} ReportOptions
 * @property {string} [format='json'] - Output format: 'json' or 'csv'
 * @property {boolean} [includeTrades=false] - Include individual trades
 * @property {boolean} [includeEquityCurve=false] - Include equity curve
 * @property {boolean} [compact=false] - Compact JSON output
 */

/**
 * Generate a formatted report from backtest results
 *
 * @param {Object} result - Backtest result from engine.runBacktest()
 * @param {ReportOptions} [options] - Report options
 * @returns {string} Formatted report string
 */
export function generateReport(result, options = {}) {
  const {
    format = 'json',
    includeTrades = false,
    includeEquityCurve = false,
    compact = false,
  } = options;

  // Calculate full metrics
  const metrics = calculateMetrics(result);

  // Build report object
  const report = buildReportObject(result, metrics, { includeTrades, includeEquityCurve });

  if (format === 'csv') {
    return generateCsvReport(report, result.trades, includeTrades);
  }

  // JSON format
  return compact
    ? JSON.stringify(report)
    : JSON.stringify(report, null, 2);
}

/**
 * Build the report object structure
 *
 * @param {Object} result - Backtest result
 * @param {Object} metrics - Calculated metrics
 * @param {Object} options - Report options
 * @returns {Object} Report object
 */
function buildReportObject(result, metrics, options) {
  const { includeTrades, includeEquityCurve } = options;

  const report = {
    strategy: result.config.strategyName || 'unknown',
    period: {
      start: result.config.startDate,
      end: result.config.endDate,
    },
    summary: {
      total_trades: result.summary.totalTrades,
      win_rate: round(result.summary.winRate, 4),
      total_pnl: round(result.summary.totalPnl, 2),
      return_pct: round(result.summary.returnPct * 100, 2),
      sharpe_ratio: round(metrics.sharpeRatio, 2),
      sortino_ratio: round(metrics.sortinoRatio, 2),
      max_drawdown_pct: round(metrics.maxDrawdown * 100, 2),
      calmar_ratio: round(metrics.calmarRatio, 2),
      profit_factor: round(metrics.profitFactor, 2),
      expectancy: round(metrics.expectancy, 4),
      avg_win: round(metrics.avgWin, 4),
      avg_loss: round(metrics.avgLoss, 4),
      payoff_ratio: round(metrics.payoffRatio, 2),
      final_capital: round(result.summary.finalCapital, 2),
      ticks_processed: result.summary.ticksProcessed,
    },
    by_symbol: {},
  };

  // Add by-symbol breakdown
  for (const [symbol, stats] of Object.entries(result.bySymbol)) {
    report.by_symbol[symbol] = {
      trade_count: stats.tradeCount,
      win_count: stats.winCount,
      win_rate: round(stats.winRate, 4),
      total_pnl: round(stats.totalPnl, 2),
      signal_count: stats.signalCount || 0,
      entry_count: stats.entryCount || 0,
      exit_count: stats.exitCount || 0,
    };
  }

  // Optionally include trades
  if (includeTrades) {
    report.trades = result.trades.map(formatTrade);
  }

  // Optionally include equity curve
  if (includeEquityCurve) {
    report.equity_curve = result.equityCurve.map(v => round(v, 2));
  }

  return report;
}

/**
 * Format a trade for report output
 *
 * @param {Object} trade - Trade object
 * @returns {Object} Formatted trade
 */
function formatTrade(trade) {
  return {
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    entry_price: round(trade.entryPrice, 6),
    exit_price: round(trade.exitPrice, 6),
    size: trade.size,
    pnl: round(trade.pnl, 4),
    pnl_pct: round(trade.pnlPct * 100, 2),
    entry_time: trade.entryTimestamp,
    exit_time: trade.exitTimestamp,
    duration_ms: trade.durationMs,
    exit_reason: trade.exitReason,
  };
}

/**
 * Generate CSV format report
 *
 * @param {Object} report - Report object
 * @param {Object[]} trades - Trades array
 * @param {boolean} includeTrades - Whether to include trades
 * @returns {string} CSV formatted string
 */
function generateCsvReport(report, trades, includeTrades) {
  const lines = [];

  // Summary section
  lines.push('# Backtest Summary');
  lines.push(`Strategy,${report.strategy}`);
  lines.push(`Period,${report.period.start} to ${report.period.end}`);
  lines.push('');

  // Summary metrics
  lines.push('# Summary Metrics');
  lines.push('Metric,Value');
  for (const [key, value] of Object.entries(report.summary)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`${label},${value}`);
  }
  lines.push('');

  // By-symbol breakdown
  if (Object.keys(report.by_symbol).length > 0) {
    lines.push('# Performance by Symbol');
    const symbolHeaders = ['Symbol', 'Trades', 'Wins', 'Win Rate', 'Total PnL', 'Signals', 'Entries', 'Exits'];
    lines.push(symbolHeaders.join(','));

    for (const [symbol, stats] of Object.entries(report.by_symbol)) {
      lines.push([
        symbol,
        stats.trade_count,
        stats.win_count,
        stats.win_rate,
        stats.total_pnl,
        stats.signal_count,
        stats.entry_count,
        stats.exit_count,
      ].join(','));
    }
    lines.push('');
  }

  // Individual trades
  if (includeTrades && trades && trades.length > 0) {
    lines.push('# Individual Trades');
    const tradeHeaders = [
      'ID', 'Symbol', 'Direction', 'Entry Price', 'Exit Price',
      'Size', 'PnL', 'PnL %', 'Entry Time', 'Exit Time', 'Duration (ms)', 'Exit Reason',
    ];
    lines.push(tradeHeaders.join(','));

    for (const trade of trades) {
      lines.push([
        trade.id,
        trade.symbol,
        trade.direction,
        round(trade.entryPrice, 6),
        round(trade.exitPrice, 6),
        trade.size,
        round(trade.pnl, 4),
        round(trade.pnlPct * 100, 2),
        trade.entryTimestamp,
        trade.exitTimestamp,
        trade.durationMs,
        trade.exitReason,
      ].join(','));
    }
  }

  return lines.join('\n');
}

/**
 * Round a number to specified decimal places
 *
 * @param {number} value - Value to round
 * @param {number} decimals - Decimal places
 * @returns {number} Rounded value
 */
function round(value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Generate a comparison report for multiple backtests
 *
 * @param {Object[]} results - Array of backtest results
 * @param {string[]} [labels] - Labels for each result
 * @returns {Object} Comparison report
 */
export function generateComparisonReport(results, labels) {
  const comparison = {
    strategies: [],
    best: {
      sharpe: null,
      return: null,
      winRate: null,
      drawdown: null,
    },
  };

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const metrics = calculateMetrics(result);
    const label = labels?.[i] || `Strategy ${i + 1}`;

    const strategyData = {
      name: label,
      total_trades: result.summary.totalTrades,
      win_rate: round(result.summary.winRate, 4),
      total_pnl: round(result.summary.totalPnl, 2),
      return_pct: round(result.summary.returnPct * 100, 2),
      sharpe_ratio: round(metrics.sharpeRatio, 2),
      max_drawdown_pct: round(metrics.maxDrawdown * 100, 2),
    };

    comparison.strategies.push(strategyData);

    // Track best performers
    if (!comparison.best.sharpe || metrics.sharpeRatio > comparison.best.sharpe.value) {
      comparison.best.sharpe = { name: label, value: metrics.sharpeRatio };
    }
    if (!comparison.best.return || result.summary.returnPct > comparison.best.return.value) {
      comparison.best.return = { name: label, value: result.summary.returnPct };
    }
    if (!comparison.best.winRate || result.summary.winRate > comparison.best.winRate.value) {
      comparison.best.winRate = { name: label, value: result.summary.winRate };
    }
    if (!comparison.best.drawdown || metrics.maxDrawdown < comparison.best.drawdown.value) {
      comparison.best.drawdown = { name: label, value: metrics.maxDrawdown };
    }
  }

  return comparison;
}

/**
 * Print a summary to console (for CLI)
 *
 * @param {Object} result - Backtest result
 */
export function printSummary(result) {
  const metrics = calculateMetrics(result);

  console.log('\n========================================');
  console.log('           BACKTEST RESULTS');
  console.log('========================================\n');

  console.log(`Period: ${result.config.startDate} to ${result.config.endDate}`);
  console.log(`Symbols: ${Array.isArray(result.config.symbols) ? result.config.symbols.join(', ') : 'all'}`);
  console.log('');

  console.log('--- Performance ---');
  console.log(`Total Trades:     ${result.summary.totalTrades}`);
  console.log(`Win Rate:         ${(result.summary.winRate * 100).toFixed(1)}%`);
  console.log(`Total P&L:        $${result.summary.totalPnl.toFixed(2)}`);
  console.log(`Return:           ${(result.summary.returnPct * 100).toFixed(2)}%`);
  console.log('');

  console.log('--- Risk Metrics ---');
  console.log(`Sharpe Ratio:     ${metrics.sharpeRatio.toFixed(2)}`);
  console.log(`Sortino Ratio:    ${metrics.sortinoRatio.toFixed(2)}`);
  console.log(`Max Drawdown:     ${(metrics.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Calmar Ratio:     ${metrics.calmarRatio.toFixed(2)}`);
  console.log('');

  console.log('--- Trade Analysis ---');
  console.log(`Profit Factor:    ${metrics.profitFactor.toFixed(2)}`);
  console.log(`Expectancy:       $${metrics.expectancy.toFixed(4)}`);
  console.log(`Avg Win:          $${metrics.avgWin.toFixed(4)}`);
  console.log(`Avg Loss:         $${metrics.avgLoss.toFixed(4)}`);
  console.log(`Payoff Ratio:     ${metrics.payoffRatio.toFixed(2)}`);
  console.log('');

  if (Object.keys(result.bySymbol).length > 0) {
    console.log('--- By Symbol ---');
    for (const [symbol, stats] of Object.entries(result.bySymbol)) {
      console.log(`  ${symbol}: ${stats.tradeCount} trades, ${(stats.winRate * 100).toFixed(1)}% win rate, $${stats.totalPnl.toFixed(2)} P&L`);
    }
  }

  console.log('\n========================================\n');
}
