/**
 * Backtest Module
 *
 * Public API for running backtests on historical data.
 *
 * Usage:
 *   import { runBacktest, runSweep } from './backtest/index.js';
 *   import * as edgeC from './backtest/strategies/edge-c-asymmetry.js';
 *
 *   const result = await runBacktest({
 *     startDate: '2026-02-01T00:00:00Z',
 *     endDate: '2026-02-02T00:00:00Z',
 *     strategy: edgeC,
 *     strategyConfig: { deficitThreshold: 80 },
 *   });
 *
 * @module backtest
 */

// Engine (sequential)
export { runBacktest, runSweep } from './engine.js';

// Engine (parallel)
export {
  evaluateWindow,
  runParallelBacktest,
  runParallelSweep,
} from './parallel-engine.js';

// Data loading
export {
  loadRtdsTicks,
  loadRtdsTicksBatched,
  loadClobSnapshots,
  loadExchangeTicks,
  loadWindowEvents,
  loadMergedTimeline,
  loadAllData,
  loadWindowTickData,
  loadWindowsWithGroundTruth,
  getTickCount,
  getTickDateRange,
  getAvailableSymbols,
  getAvailableTopics,
} from './data-loader.js';

// Market state
export { MarketState, createMarketState } from './market-state.js';

// Simulator
export { Simulator, createSimulator } from './simulator.js';

// Metrics
export {
  calculateMetrics,
  calculateSubsetMetrics,
  calculateBinaryMetrics,
  calculatePerWindowMetrics,
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateProfitFactor,
  calculateExpectancy,
} from './metrics.js';

// Reporter
export {
  generateReport,
  generateComparisonReport,
  printSummary,
} from './reporter.js';
