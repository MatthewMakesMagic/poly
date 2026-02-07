/**
 * Backtest Report Generator
 *
 * Outputs backtest results in JSON and CSV formats.
 * Includes edge_summary, per_window, and optional decision_log sections.
 */

import { calculateMetrics, calculateBinaryMetrics, calculatePerWindowMetrics } from './metrics.js';

/**
 * @typedef {Object} ReportOptions
 * @property {string} [format='json'] - Output format: 'json' or 'csv'
 * @property {boolean} [includeTrades=false] - Include individual trades
 * @property {boolean} [includeEquityCurve=false] - Include equity curve
 * @property {boolean} [compact=false] - Compact JSON output
 */

/**
 * Generate a formatted report from backtest results.
 *
 * @param {Object} result - Backtest result from engine.runBacktest()
 * @param {ReportOptions} [options]
 * @returns {string} Formatted report string
 */
export function generateReport(result, options = {}) {
  const {
    format = 'json',
    includeTrades = false,
    includeEquityCurve = false,
    compact = false,
  } = options;

  const metrics = calculateMetrics(result);
  const report = buildReportObject(result, metrics, { includeTrades, includeEquityCurve });

  if (format === 'csv') {
    return generateCsvReport(report, result.trades, includeTrades);
  }

  return compact
    ? JSON.stringify(report)
    : JSON.stringify(report, null, 2);
}

/**
 * Build the report object.
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
      events_processed: result.summary.eventsProcessed || result.summary.ticksProcessed || 0,
      windows_processed: result.summary.windowsProcessed || 0,
    },
  };

  // Edge summary (binary option specific)
  const binaryMetrics = calculateBinaryMetrics(result.trades);
  report.edge_summary = {
    win_rate: round(binaryMetrics.winRate, 4),
    avg_entry_price: round(binaryMetrics.avgEntryPrice, 4),
    edge_per_trade: round(binaryMetrics.edgeCaptured, 4),
    ev_per_trade: round(binaryMetrics.evPerTrade, 4),
    total_ev: round(binaryMetrics.totalEV, 2),
    total_trades: binaryMetrics.totalTrades,
  };

  // Per-window results
  if (result.windowResults && result.windowResults.length > 0) {
    const perWindow = calculatePerWindowMetrics(result.trades, result.windowResults);
    report.per_window = {
      windows: perWindow.windows.map(w => ({
        close_time: w.windowCloseTime,
        symbol: w.symbol,
        strike: w.strike,
        chainlink_close: w.chainlinkClose,
        resolved: w.resolvedDirection,
        pnl: round(w.pnl, 4),
        trades: w.trades,
        accuracy: w.accuracy != null ? round(w.accuracy, 4) : null,
      })),
      by_time_of_day: perWindow.byTimeOfDay,
      by_deficit_bucket: perWindow.byDeficitBucket,
      contested_accuracy: round(perWindow.contestedWindowAccuracy, 4),
      decided_accuracy: round(perWindow.decidedWindowAccuracy, 4),
    };
  }

  // Decision log (verbose only)
  if (result.decisionLog && result.decisionLog.length > 0) {
    report.decision_log = result.decisionLog;
  }

  // Individual trades
  if (includeTrades) {
    report.trades = result.trades.map(formatTrade);
  }

  // Equity curve
  if (includeEquityCurve) {
    report.equity_curve = result.equityCurve.map(v => round(v, 2));
  }

  return report;
}

/**
 * Format a trade for report output.
 */
function formatTrade(trade) {
  return {
    id: trade.id,
    token: trade.token,
    entry_price: round(trade.entryPrice, 4),
    size: trade.size,
    cost: round(trade.cost, 4),
    payout: trade.payout != null ? round(trade.payout, 4) : null,
    pnl: round(trade.pnl, 4),
    entry_time: trade.timestamp,
    exit_time: trade.exitTimestamp,
    exit_reason: trade.exitReason,
    reason: trade.reason,
  };
}

/**
 * Generate CSV format report.
 */
function generateCsvReport(report, trades, includeTrades) {
  const lines = [];

  lines.push('# Backtest Summary');
  lines.push(`Strategy,${report.strategy}`);
  lines.push(`Period,${report.period.start} to ${report.period.end}`);
  lines.push('');

  lines.push('# Summary Metrics');
  lines.push('Metric,Value');
  for (const [key, value] of Object.entries(report.summary)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`${label},${value}`);
  }
  lines.push('');

  lines.push('# Edge Summary');
  lines.push('Metric,Value');
  for (const [key, value] of Object.entries(report.edge_summary)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`${label},${value}`);
  }
  lines.push('');

  if (includeTrades && trades && trades.length > 0) {
    lines.push('# Individual Trades');
    const headers = ['ID', 'Token', 'Entry Price', 'Size', 'Cost', 'Payout', 'PnL', 'Entry Time', 'Exit Time', 'Exit Reason', 'Reason'];
    lines.push(headers.join(','));

    for (const trade of trades) {
      lines.push([
        trade.id,
        trade.token,
        round(trade.entryPrice, 4),
        trade.size,
        round(trade.cost, 4),
        trade.payout != null ? round(trade.payout, 4) : '',
        round(trade.pnl, 4),
        trade.timestamp,
        trade.exitTimestamp || '',
        trade.exitReason || '',
        trade.reason || '',
      ].join(','));
    }
  }

  return lines.join('\n');
}

/**
 * Round a number to specified decimal places.
 */
function round(value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Generate a comparison report for parameter sweep results.
 * Ranks by EV per trade.
 *
 * @param {Object[]} sweepResults - Array of { params, result }
 * @returns {Object} Comparison report
 */
export function generateComparisonReport(sweepResults) {
  if (!sweepResults || sweepResults.length === 0) {
    return { strategies: [], best: null };
  }

  const strategies = sweepResults.map(({ params, result }) => {
    const binaryMetrics = calculateBinaryMetrics(result.trades);
    const perfMetrics = calculateMetrics(result);

    return {
      params,
      total_trades: result.summary.totalTrades,
      win_rate: round(result.summary.winRate, 4),
      total_pnl: round(result.summary.totalPnl, 2),
      return_pct: round(result.summary.returnPct * 100, 2),
      ev_per_trade: round(binaryMetrics.evPerTrade, 4),
      total_ev: round(binaryMetrics.totalEV, 2),
      edge_captured: round(binaryMetrics.edgeCaptured, 4),
      sharpe_ratio: round(perfMetrics.sharpeRatio, 2),
      max_drawdown_pct: round(perfMetrics.maxDrawdown * 100, 2),
      windows_processed: result.summary.windowsProcessed || 0,
    };
  });

  // Sort by EV per trade descending
  strategies.sort((a, b) => b.ev_per_trade - a.ev_per_trade);

  return {
    strategies,
    best: strategies.length > 0 ? strategies[0] : null,
  };
}

/**
 * Print a summary to console.
 *
 * @param {Object} result - Backtest result
 */
export function printSummary(result) {
  const metrics = calculateMetrics(result);
  const binaryMetrics = calculateBinaryMetrics(result.trades);

  console.log('\n========================================');
  console.log('           BACKTEST RESULTS');
  console.log('========================================\n');

  console.log(`Strategy: ${result.config.strategyName || 'unknown'}`);
  console.log(`Period: ${result.config.startDate} to ${result.config.endDate}`);
  console.log('');

  console.log('--- Performance ---');
  console.log(`Total Trades:     ${result.summary.totalTrades}`);
  console.log(`Win Rate:         ${(result.summary.winRate * 100).toFixed(1)}%`);
  console.log(`Total P&L:        $${result.summary.totalPnl.toFixed(2)}`);
  console.log(`Return:           ${(result.summary.returnPct * 100).toFixed(2)}%`);
  console.log(`Windows:          ${result.summary.windowsProcessed || 0}`);
  console.log('');

  console.log('--- Edge Summary ---');
  console.log(`Avg Entry Price:  ${binaryMetrics.avgEntryPrice.toFixed(4)}`);
  console.log(`Edge Captured:    ${binaryMetrics.edgeCaptured.toFixed(4)}`);
  console.log(`EV Per Trade:     $${binaryMetrics.evPerTrade.toFixed(4)}`);
  console.log(`Total EV:         $${binaryMetrics.totalEV.toFixed(2)}`);
  console.log('');

  console.log('--- Risk Metrics ---');
  console.log(`Sharpe Ratio:     ${metrics.sharpeRatio.toFixed(2)}`);
  console.log(`Max Drawdown:     ${(metrics.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Profit Factor:    ${metrics.profitFactor.toFixed(2)}`);

  console.log('\n========================================\n');
}
