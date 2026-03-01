/**
 * Parallel Backtest Engine
 *
 * Evaluates independent windows in parallel using Promise.all with concurrency control.
 * Each window gets a fresh MarketState and Simulator — zero shared state.
 *
 * Architecture:
 *   1. Load window list + ground truth once
 *   2. Load all tick data for the full date range once
 *   3. Slice per-window data in memory
 *   4. Evaluate windows in parallel (configurable concurrency)
 *   5. Aggregate results
 *
 * Strategy interface (unchanged from engine.js):
 *   { name, evaluate(state, config) => Signal[], onWindowOpen?, onWindowClose? }
 */

import { createMarketState } from './market-state.js';
import { createSimulator } from './simulator.js';
import { loadWindowTickData } from './data-loader.js';
import { child } from '../modules/logger/index.js';

const log = child({ module: 'backtest:parallel-engine' });

// ─── Concurrency Limiter ───

/**
 * Simple concurrency limiter (p-limit pattern).
 * @param {number} concurrency - Max concurrent tasks
 * @returns {function} Limiter function: limit(fn) => Promise
 */
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ─── Ground Truth Resolution ───

/**
 * Get the best available resolved direction for a window.
 * Priority: gamma_resolved_direction > onchain_resolved_direction > resolved_direction > computed
 *
 * @param {Object} window - Window close event row
 * @returns {string|null} 'UP' or 'DOWN' or null
 */
function getGroundTruth(window) {
  if (window.gamma_resolved_direction) return window.gamma_resolved_direction.toUpperCase();
  if (window.onchain_resolved_direction) return window.onchain_resolved_direction.toUpperCase();
  if (window.resolved_direction) return window.resolved_direction.toUpperCase();
  // Fallback: compute from CL prices
  const clClose = Number(window.chainlink_price_at_close);
  const clOpen = Number(window.oracle_price_at_open);
  if (clClose && clOpen) {
    return clClose >= clOpen ? 'UP' : 'DOWN';
  }
  return null;
}

// ─── Per-Window Timeline Builder ───

/**
 * Build a merged timeline for a single window from pre-loaded data arrays.
 * Tags each event with a `source` field matching the existing convention.
 *
 * @param {Object} windowData - { rtdsTicks, clobSnapshots, exchangeTicks }
 * @returns {Object[]} Sorted timeline events
 */
function buildWindowTimeline(windowData) {
  const { rtdsTicks, clobSnapshots, exchangeTicks } = windowData;
  const timeline = [];

  for (let i = 0; i < rtdsTicks.length; i++) {
    const tick = rtdsTicks[i];
    const topic = tick.topic;
    let source;
    if (topic === 'crypto_prices_chainlink') {
      source = 'chainlink';
    } else if (topic === 'crypto_prices') {
      source = 'polyRef';
    } else {
      source = `rtds_${topic}`;
    }
    timeline.push({ ...tick, source });
  }

  for (let i = 0; i < clobSnapshots.length; i++) {
    const snap = clobSnapshots[i];
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    timeline.push({ ...snap, source });
  }

  for (let i = 0; i < exchangeTicks.length; i++) {
    const tick = exchangeTicks[i];
    timeline.push({ ...tick, source: `exchange_${tick.exchange}` });
  }

  // Sort by timestamp
  timeline.sort((a, b) => {
    const tA = new Date(a.timestamp).getTime();
    const tB = new Date(b.timestamp).getTime();
    return tA - tB;
  });

  return timeline;
}

// ─── Pure Window Evaluator ───

/**
 * Evaluate a single window in isolation.
 * Fresh state, fresh simulator, zero shared state.
 *
 * @param {Object} params
 * @param {Object} params.window - Window close event row (ground truth)
 * @param {Object[]} params.timeline - Sorted timeline events for this window
 * @param {Object} params.strategy - Strategy object { name, evaluate, onWindowOpen?, onWindowClose? }
 * @param {Object} params.strategyConfig - Strategy parameters
 * @param {number} params.initialCapital - Starting capital
 * @param {number} params.spreadBuffer - Spread buffer for execution
 * @param {number} params.tradingFee - Fee per trade
 * @param {number} params.windowDurationMs - Window duration in ms
 * @returns {Object} Window result
 */
export function evaluateWindow({
  window: win,
  timeline,
  strategy,
  strategyConfig = {},
  initialCapital = 100,
  spreadBuffer = 0.005,
  tradingFee = 0,
  windowDurationMs = 5 * 60 * 1000,
}) {
  const state = createMarketState();
  const simulator = createSimulator({ initialCapital, spreadBuffer, tradingFee });

  const closeMs = new Date(win.window_close_time).getTime();
  const openMs = closeMs - windowDurationMs;
  const openTime = new Date(openMs).toISOString();

  // Set window context
  state.setWindow(win, openTime);

  if (strategy.onWindowOpen) {
    strategy.onWindowOpen(state, strategyConfig);
  }

  const groundTruth = getGroundTruth(win);
  let eventsProcessed = 0;

  // Replay timeline
  for (let i = 0; i < timeline.length; i++) {
    const event = timeline[i];
    const eventMs = new Date(event.timestamp).getTime();

    // Skip events outside window
    if (eventMs < openMs) continue;
    if (eventMs >= closeMs) break;

    // Update market state
    state.processEvent(event);
    state.updateTimeToClose(event.timestamp);
    eventsProcessed++;

    // Evaluate strategy
    try {
      const signals = strategy.evaluate(state, strategyConfig);
      if (!signals || signals.length === 0) continue;

      for (let s = 0; s < signals.length; s++) {
        const signal = signals[s];
        if (!signal.action || !signal.token) continue;

        const execResult = simulator.execute(signal, state, strategyConfig);

        if (execResult.filled) {
          if (signal.action === 'buy') {
            simulator.buyToken({
              token: signal.token,
              price: execResult.fillPrice,
              size: execResult.fillSize,
              timestamp: event.timestamp,
              reason: signal.reason || '',
            });
          } else if (signal.action === 'sell') {
            simulator.sellToken({
              token: signal.token,
              price: execResult.fillPrice,
              timestamp: event.timestamp,
              reason: signal.reason || 'strategy_sell',
            });
          }
        }
      }
    } catch (err) {
      // Swallow strategy errors per-event
    }
  }

  // Resolve window positions
  if (groundTruth) {
    simulator.resolveWindow({
      direction: groundTruth,
      timestamp: win.window_close_time,
    });
  }

  const stats = simulator.getStats();
  const trades = simulator.getTrades();

  if (strategy.onWindowClose) {
    const windowResult = {
      windowCloseTime: win.window_close_time,
      symbol: win.symbol,
      strike: win.strike_price,
      chainlinkClose: win.chainlink_price_at_close,
      resolvedDirection: groundTruth,
      pnl: stats.totalPnl,
      tradesInWindow: trades.length,
    };
    strategy.onWindowClose(state, windowResult, strategyConfig);
  }

  return {
    windowCloseTime: win.window_close_time,
    symbol: win.symbol,
    strike: win.strike_price != null ? Number(win.strike_price) : null,
    chainlinkClose: win.chainlink_price_at_close != null ? Number(win.chainlink_price_at_close) : null,
    resolvedDirection: groundTruth,
    pnl: stats.totalPnl,
    tradesInWindow: trades.length,
    trades,
    eventsProcessed,
    capitalAfter: stats.finalCapital,
    winRate: stats.winRate,
    equityCurve: simulator.getEquityCurve(),
  };
}

// ─── Data Slicing ───

/**
 * Binary search for the first index where timestamp >= target.
 * Array must be sorted by timestamp ascending.
 *
 * @param {Object[]} arr - Sorted array of objects with `.timestamp`
 * @param {number} targetMs - Target timestamp in ms
 * @returns {number} Index of first element >= target, or arr.length if none
 */
function lowerBound(arr, targetMs) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (new Date(arr[mid].timestamp).getTime() < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Binary search for the first index where timestamp > target.
 * @param {Object[]} arr
 * @param {number} targetMs
 * @returns {number}
 */
function upperBound(arr, targetMs) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (new Date(arr[mid].timestamp).getTime() <= targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Slice a sorted array to [startMs, endMs) using binary search.
 *
 * @param {Object[]} sorted - Sorted by timestamp
 * @param {number} startMs - Start time inclusive
 * @param {number} endMs - End time exclusive
 * @returns {Object[]} Slice (shared underlying array references)
 */
function sliceByTime(sorted, startMs, endMs) {
  const lo = lowerBound(sorted, startMs);
  const hi = upperBound(sorted, endMs - 1); // endMs is exclusive
  return sorted.slice(lo, hi);
}

// ─── CLOB Snapshot Filtering ───

/**
 * Filter CLOB snapshots for a specific window.
 * Must match symbol prefix and window_epoch if available.
 *
 * @param {Object[]} allClob - All CLOB snapshots sorted by timestamp
 * @param {number} startMs - Window open time ms
 * @param {number} endMs - Window close time ms
 * @param {string} symbol - Window symbol (e.g. 'btc')
 * @param {number} windowEpoch - Window epoch (seconds) for filtering
 * @returns {Object[]} Filtered CLOB snapshots
 */
function sliceClobForWindow(allClob, startMs, endMs, symbol, windowEpoch) {
  const slice = sliceByTime(allClob, startMs, endMs);
  const prefix = symbol.toLowerCase();

  return slice.filter(snap => {
    const sym = snap.symbol?.toLowerCase() || '';
    if (!sym.startsWith(prefix)) return false;
    // If window_epoch is available on the snap, filter by it
    if (snap.window_epoch != null && windowEpoch != null) {
      return Number(snap.window_epoch) === windowEpoch;
    }
    return true;
  });
}

// ─── Parallel Backtest Runner ───

/**
 * @typedef {Object} ParallelBacktestConfig
 * @property {Object} strategy - Strategy object
 * @property {Object} [strategyConfig={}] - Strategy parameters
 * @property {number} [initialCapital=100]
 * @property {number} [spreadBuffer=0.005]
 * @property {number} [tradingFee=0]
 * @property {number} [windowDurationMs=300000]
 * @property {number} [concurrency=50] - Max parallel window evaluations
 * @property {Function} [onProgress] - Progress callback (completed, total)
 */

/**
 * Run a parallel backtest across all provided windows.
 *
 * Supports two data loading modes:
 *   1. Pre-loaded: Pass allData with { rtdsTicks, clobSnapshots, exchangeTicks } — slices in memory
 *   2. Per-window: Omit allData — loads each window's data from DB (better for remote databases)
 *
 * @param {Object} params
 * @param {Object[]} params.windows - Window close events with ground truth
 * @param {Object} [params.allData] - Pre-loaded data { rtdsTicks, clobSnapshots, exchangeTicks }
 * @param {ParallelBacktestConfig} params.config - Backtest configuration
 * @returns {Promise<Object>} Aggregated backtest result
 */
export async function runParallelBacktest({ windows, allData, config }) {
  const {
    strategy,
    strategyConfig = {},
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    windowDurationMs = 5 * 60 * 1000,
    concurrency = 50,
    onProgress,
  } = config;

  if (!strategy || typeof strategy.evaluate !== 'function') {
    throw new Error('strategy must have an evaluate function');
  }

  const usePreloaded = !!allData;
  // For per-window DB loading, limit DB concurrency to avoid overwhelming the pool
  const dbConcurrency = Math.min(concurrency, 10);
  const limit = createLimiter(usePreloaded ? concurrency : dbConcurrency);
  const total = windows.length;
  let completed = 0;

  log.info('parallel_backtest_start', {
    strategy: strategy.name,
    windows: total,
    concurrency: usePreloaded ? concurrency : dbConcurrency,
    mode: usePreloaded ? 'preloaded' : 'per-window',
  });

  const startTime = Date.now();

  // Evaluate all windows in parallel with concurrency control
  const windowResultPromises = windows.map(win => {
    return limit(async () => {
      let windowData;

      if (usePreloaded) {
        // Mode 1: Slice pre-loaded data
        const { rtdsTicks, clobSnapshots, exchangeTicks } = allData;
        const closeMs = new Date(win.window_close_time).getTime();
        const openMs = closeMs - windowDurationMs;
        // window_epoch in clob_price_snapshots is the window CLOSE time epoch
        const windowEpochSec = Math.floor(closeMs / 1000);

        const winRtds = sliceByTime(rtdsTicks, openMs, closeMs);
        const winClob = sliceClobForWindow(clobSnapshots, openMs, closeMs, win.symbol, windowEpochSec);
        const winExchange = sliceByTime(exchangeTicks, openMs, closeMs).filter(
          t => t.symbol?.toLowerCase() === win.symbol?.toLowerCase()
        );
        windowData = { rtdsTicks: winRtds, clobSnapshots: winClob, exchangeTicks: winExchange };
      } else {
        // Mode 2: Load per-window from DB
        windowData = await loadWindowTickData({ window: win, windowDurationMs });
      }

      const timeline = buildWindowTimeline(windowData);

      const result = evaluateWindow({
        window: win,
        timeline,
        strategy,
        strategyConfig,
        initialCapital,
        spreadBuffer,
        tradingFee,
        windowDurationMs,
      });

      completed++;
      if (onProgress) {
        onProgress(completed, total);
      }

      return result;
    });
  });

  const windowResults = await Promise.all(windowResultPromises);

  const elapsedMs = Date.now() - startTime;

  // Aggregate results
  const aggregated = aggregateResults(windowResults, {
    strategy,
    strategyConfig,
    initialCapital,
    elapsedMs,
    windowCount: total,
  });

  log.info('parallel_backtest_complete', {
    strategy: strategy.name,
    windows: total,
    elapsedMs,
    totalTrades: aggregated.summary.totalTrades,
    winRate: aggregated.summary.winRate,
    totalPnl: aggregated.summary.totalPnl,
  });

  return aggregated;
}

// ─── Results Aggregation ───

/**
 * Aggregate per-window results into a combined result matching the engine.js output format.
 *
 * @param {Object[]} windowResults - Array of evaluateWindow results
 * @param {Object} meta - { strategy, strategyConfig, initialCapital, elapsedMs, windowCount }
 * @returns {Object} Aggregated result compatible with reporter/metrics
 */
function aggregateResults(windowResults, meta) {
  const { strategy, strategyConfig, initialCapital, elapsedMs, windowCount } = meta;

  let totalPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let totalEventsProcessed = 0;
  const allTrades = [];
  const perWindowSummaries = [];

  // Build a combined equity curve (sequential ordering by window close time)
  // Sort window results by close time for consistent equity curve
  const sorted = [...windowResults].sort((a, b) =>
    new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
  );

  let runningCapital = initialCapital;
  const equityCurve = [initialCapital];
  let peakCapital = initialCapital;
  let maxDrawdown = 0;

  for (let i = 0; i < sorted.length; i++) {
    const wr = sorted[i];
    totalPnl += wr.pnl;
    totalTrades += wr.tradesInWindow;
    totalEventsProcessed += wr.eventsProcessed;

    // Count wins from trades
    for (let t = 0; t < wr.trades.length; t++) {
      allTrades.push(wr.trades[t]);
      if (wr.trades[t].pnl > 0) totalWins++;
    }

    perWindowSummaries.push({
      windowCloseTime: wr.windowCloseTime,
      symbol: wr.symbol,
      strike: wr.strike,
      chainlinkClose: wr.chainlinkClose,
      resolvedDirection: wr.resolvedDirection,
      pnl: wr.pnl,
      tradesInWindow: wr.tradesInWindow,
    });

    // Update running equity curve
    runningCapital += wr.pnl;
    equityCurve.push(runningCapital);

    if (runningCapital > peakCapital) {
      peakCapital = runningCapital;
    }
    if (peakCapital > 0) {
      const dd = (peakCapital - runningCapital) / peakCapital;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const returnPct = initialCapital > 0 ? totalPnl / initialCapital : 0;

  // Compute avg win / avg loss
  const winTrades = allTrades.filter(t => t.pnl > 0);
  const lossTrades = allTrades.filter(t => t.pnl <= 0);
  const avgWin = winTrades.length > 0
    ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length
    : 0;
  const avgLoss = lossTrades.length > 0
    ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length
    : 0;

  return {
    config: {
      strategyName: strategy.name,
      strategyConfig,
      initialCapital,
      startDate: sorted.length > 0 ? sorted[0].windowCloseTime : null,
      endDate: sorted.length > 0 ? sorted[sorted.length - 1].windowCloseTime : null,
    },
    summary: {
      totalTrades,
      winRate,
      totalPnl,
      returnPct,
      maxDrawdown,
      finalCapital: runningCapital,
      avgWin,
      avgLoss,
      eventsProcessed: totalEventsProcessed,
      windowsProcessed: windowCount,
      elapsedMs,
    },
    trades: allTrades,
    equityCurve,
    windowResults: perWindowSummaries,
  };
}

// ─── Parameter Sweep (Parallel) ───

/**
 * Run a parameter sweep: load data once, evaluate many configs in parallel.
 *
 * @param {Object} params
 * @param {Object[]} params.windows - Window close events
 * @param {Object} params.allData - Pre-loaded data
 * @param {Object} params.baseConfig - Base backtest config (strategy, capital, etc.)
 * @param {Object} params.paramGrid - { paramName: [values], ... }
 * @param {number} [params.concurrency=50] - Per-sweep concurrency
 * @param {Function} [params.onSweepProgress] - Callback (completedConfigs, totalConfigs)
 * @returns {Promise<Object[]>} Array of { params, result }
 */
export async function runParallelSweep({
  windows,
  allData = null,
  baseConfig,
  paramGrid,
  concurrency = 50,
  onSweepProgress,
}) {
  const paramSets = generateParamCombinations(paramGrid);

  log.info('parallel_sweep_start', {
    strategy: baseConfig.strategy?.name,
    paramSets: paramSets.length,
    windows: windows.length,
    params: Object.keys(paramGrid),
  });

  const results = [];
  let completedConfigs = 0;

  for (const params of paramSets) {
    const mergedConfig = {
      ...baseConfig,
      strategyConfig: { ...baseConfig.strategyConfig, ...params },
      concurrency,
    };

    const params_for_backtest = { windows, config: mergedConfig };
    if (allData) params_for_backtest.allData = allData;
    const result = await runParallelBacktest(params_for_backtest);

    results.push({ params, result });
    completedConfigs++;

    if (onSweepProgress) {
      onSweepProgress(completedConfigs, paramSets.length);
    }
  }

  log.info('parallel_sweep_complete', { paramSets: paramSets.length });

  return results;
}

/**
 * Generate all combinations from a parameter grid.
 *
 * @param {Object} grid - { key: [values], ... }
 * @returns {Object[]} Array of param objects
 */
function generateParamCombinations(grid) {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];

  let combos = [{}];

  for (const key of keys) {
    const values = grid[key];
    const newCombos = [];

    for (const existing of combos) {
      for (const value of values) {
        newCombos.push({ ...existing, [key]: value });
      }
    }

    combos = newCombos;
  }

  return combos;
}
