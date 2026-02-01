/**
 * Backtest Module
 *
 * Public API for running backtests on historical data.
 *
 * Usage:
 *   import { runBacktest, createThresholdStrategy } from './backtest/index.js';
 *
 *   const result = await runBacktest({
 *     startDate: '2026-01-25T00:00:00Z',
 *     endDate: '2026-02-01T00:00:00Z',
 *     symbols: ['BTC', 'ETH'],
 *     strategy: createThresholdStrategy({ entryThreshold: 0.002 }),
 *   });
 *
 * @module backtest
 */

// Re-export main API
export { runBacktest, createThresholdStrategy, createComposedStrategy } from './engine.js';

// Re-export data loading utilities
export {
  loadTicks,
  loadTicksBatched,
  getTickCount,
  loadOracleUpdates,
  loadTradeEvents,
  loadLagSignals,
  getTickDateRange,
  getAvailableSymbols,
  getAvailableTopics,
} from './data-loader.js';

// Re-export market state utilities
export { MarketState, createMarketState } from './market-state.js';

// Re-export context builder
export { ContextBuilder, createContextBuilder } from './context-builder.js';

// Re-export simulator
export { Simulator, createSimulator } from './simulator.js';

// Re-export metrics
export {
  calculateMetrics,
  calculateSubsetMetrics,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateProfitFactor,
  calculateExpectancy,
} from './metrics.js';

// Re-export reporter
export {
  generateReport,
  generateComparisonReport,
  printSummary,
} from './reporter.js';
