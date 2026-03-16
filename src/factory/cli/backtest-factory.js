/**
 * Factory Backtest Engine (Story 3.2)
 *
 * Core backtest logic for factory strategies. Importable as a module.
 * Loads strategy (YAML via factory compose, or JS directly),
 * samples windows from SQLite cache, evaluates using existing evaluateWindow,
 * computes comprehensive metrics with regime breakdown and bootstrap CI.
 *
 * Covers: FR16-FR19, FR24, FR28-FR29, NFR1, NFR2
 */

import { evaluateWindow } from '../../backtest/parallel-engine.js';
import { loadTimeline, loadWindowsForSymbol } from '../timeline-loader.js';
import { sampleWindows, splitWindows } from '../sampler.js';
import { analyzeStrategySources, trimTimeline } from '../timeline-trimmer.js';
import {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateProfitFactor,
  calculateExpectancy,
  calculateMaxDrawdown,
} from '../../backtest/metrics.js';
import { FeeMode, parseFeeMode, calculateTakerFeeRate } from '../fee-model.js';
import { aggregateFillMetrics } from '../fill-simulator.js';
import {
  loadWindowsWithGroundTruth,
  loadWindowTickData,
} from '../../backtest/data-loader.js';

import { createPrng } from '../utils/prng.js';

// ─── Param Grid Combinator ───

/**
 * Generate all combinations from a parameter grid.
 * If maxCombinations is provided, throws when the grid exceeds that limit.
 *
 * @param {Object} grid - { key: [values], ... }
 * @param {Object} [options]
 * @param {number} [options.maxCombinations] - Maximum allowed combinations (throws if exceeded)
 * @returns {Object[]} Array of param objects
 */
export function generateParamCombinations(grid, options = {}) {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];

  // Enforce combination limit if specified
  if (options.maxCombinations != null) {
    const totalCombinations = keys.reduce((acc, key) => acc * (grid[key]?.length || 1), 1);
    if (totalCombinations > options.maxCombinations) {
      throw new Error(
        `Sweep grid produces ${totalCombinations} combinations, exceeding the maximum of ${options.maxCombinations}. ` +
        `Reduce parameter ranges or increase config.factory.maxSweepCombinations.`
      );
    }
  }

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

// ─── Metric Computation ───

/**
 * Compute per-window PnL returns for Sharpe/Sortino.
 * Each window's PnL / initialCapital = one return observation.
 */
function windowReturns(windowResults, initialCapital) {
  return windowResults.map(r => r.pnl / initialCapital);
}

/**
 * Compute comprehensive metrics from window results.
 *
 * @param {Object[]} windowResults - Array from evaluateWindow
 * @param {number} initialCapital
 * @returns {Object} metrics
 */
export function computeMetrics(windowResults, initialCapital = 100) {
  const allTrades = [];
  let totalPnl = 0;
  let totalWins = 0;

  for (const wr of windowResults) {
    totalPnl += wr.pnl;
    for (const t of wr.trades) {
      allTrades.push(t);
      if (t.pnl > 0) totalWins++;
    }
  }

  const totalTrades = allTrades.length;
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;

  // Equity curve from window-level PnLs
  let running = initialCapital;
  const equityCurve = [initialCapital];
  for (const wr of windowResults) {
    running += wr.pnl;
    equityCurve.push(running);
  }

  const returns = windowReturns(windowResults, initialCapital);

  // Raw Sharpe (unannualized): mean/stddev, no sqrt(N) scaling.
  // This is the PRIMARY ranking metric per adversarial review.
  // Annualized Sharpe uses actual window frequency (e.g., 35,040 for 15-min windows in 24/7 crypto).
  const sharpeRaw = calculateSharpeRatio(returns, 0, 1);
  const sortinoRaw = calculateSortinoRatio(returns, 0, 1);

  // Compute actual annualization factor from window duration
  // periodsPerYear = (365.25 * 24 * 60) / windowDurationMinutes
  const windowDurationMinutes = 15;
  const periodsPerYear = (365.25 * 24 * 60) / windowDurationMinutes;
  const sharpeAnnualized = calculateSharpeRatio(returns, 0, periodsPerYear);
  const sortinoAnnualized = calculateSortinoRatio(returns, 0, periodsPerYear);

  const pf = calculateProfitFactor(allTrades);
  const { maxDrawdownPct } = calculateMaxDrawdown(equityCurve);
  const expectancy = calculateExpectancy(allTrades);

  // Edge per trade (binary-specific)
  const avgEntry = totalTrades > 0
    ? allTrades.reduce((s, t) => s + (t.entryPrice || 0), 0) / totalTrades
    : 0;
  const edgePerTrade = winRate - avgEntry;

  // Minimum trade count warning (adversarial review recommendation 4)
  const lowTradeCount = totalTrades < 30;

  return {
    sharpe: sharpeRaw,
    sharpeAnnualized,
    sharpeNote: 'Raw Sharpe (no annualization) is the primary ranking metric. Annualized assumes continuous 24/7 i.i.d. returns.',
    sortino: sortinoRaw,
    sortinoAnnualized,
    profitFactor: pf,
    maxDrawdown: maxDrawdownPct,
    winRate,
    trades: totalTrades,
    lowTradeCount,
    expectancy,
    edgePerTrade,
    totalPnl,
    finalCapital: running,
    equityCurve,
  };
}

// ─── Regime Breakdown ───

/**
 * Compute regime breakdown: first/second half, time-of-day, day-of-week.
 */
export function computeRegimeBreakdown(windowResults, initialCapital = 100) {
  if (windowResults.length === 0) {
    return { firstHalf: null, secondHalf: null, timeOfDay: {}, dayOfWeek: {} };
  }

  // First/second half
  const mid = Math.floor(windowResults.length / 2);
  const firstHalf = computeMetrics(windowResults.slice(0, mid), initialCapital);
  const secondHalf = computeMetrics(windowResults.slice(mid), initialCapital);

  // Time-of-day buckets (UTC hours)
  // overnight: 0-5, morning: 6-11, afternoon: 12-17, evening: 18-23
  const todBuckets = { overnight: [], morning: [], afternoon: [], evening: [] };
  for (const wr of windowResults) {
    const hour = new Date(wr.windowCloseTime).getUTCHours();
    if (hour < 6) todBuckets.overnight.push(wr);
    else if (hour < 12) todBuckets.morning.push(wr);
    else if (hour < 18) todBuckets.afternoon.push(wr);
    else todBuckets.evening.push(wr);
  }

  const timeOfDay = {};
  for (const [bucket, wrs] of Object.entries(todBuckets)) {
    if (wrs.length > 0) {
      timeOfDay[bucket] = computeMetrics(wrs, initialCapital);
      timeOfDay[bucket].windows = wrs.length;
    }
  }

  // Day-of-week
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowBuckets = {};
  for (const wr of windowResults) {
    const dow = dowNames[new Date(wr.windowCloseTime).getUTCDay()];
    if (!dowBuckets[dow]) dowBuckets[dow] = [];
    dowBuckets[dow].push(wr);
  }

  const dayOfWeek = {};
  for (const [dow, wrs] of Object.entries(dowBuckets)) {
    if (wrs.length > 0) {
      dayOfWeek[dow] = computeMetrics(wrs, initialCapital);
      dayOfWeek[dow].windows = wrs.length;
    }
  }

  return { firstHalf, secondHalf, timeOfDay, dayOfWeek };
}

// ─── Bootstrap Confidence Intervals ───

/**
 * Bootstrap confidence interval for Sharpe ratio.
 * @param {number[]} returns - Per-window returns
 * @param {number} resamples - Number of bootstrap resamples
 * @param {number} seed - PRNG seed
 * @returns {{ mean: number, ci95Lower: number, ci95Upper: number, pValue: number }}
 */
export function bootstrapSharpeCI(returns, resamples = 1000, seed = 42) {
  if (returns.length < 2) {
    return { mean: 0, ci95Lower: 0, ci95Upper: 0, pValue: 1 };
  }

  const rng = createPrng(seed);
  const bootstrapSharpes = [];
  const n = returns.length;

  for (let i = 0; i < resamples; i++) {
    const sample = new Array(n);
    for (let j = 0; j < n; j++) {
      sample[j] = returns[Math.floor(rng() * n)];
    }
    // Use raw (unannualized) Sharpe for bootstrap CI — consistent with primary metric
    bootstrapSharpes.push(calculateSharpeRatio(sample, 0, 1));
  }

  bootstrapSharpes.sort((a, b) => a - b);

  const lower = bootstrapSharpes[Math.floor(0.025 * resamples)];
  const upper = bootstrapSharpes[Math.floor(0.975 * resamples)];
  const mean = bootstrapSharpes.reduce((s, v) => s + v, 0) / resamples;

  // p-value: fraction of bootstrap Sharpes <= 0
  const belowZero = bootstrapSharpes.filter(s => s <= 0).length;
  const pValue = belowZero / resamples;

  return { mean, ci95Lower: lower, ci95Upper: upper, pValue };
}

// ─── Baseline Strategy ───

/**
 * Random-entry baseline: buys random token with 50/50 direction each window.
 */
function createBaselineStrategy(seed = 99) {
  const rng = createPrng(seed);
  return {
    name: 'baseline-random',
    evaluate(state, config) {
      if (!state.clobUp?.bestAsk || !state.clobDown?.bestAsk) return [];
      // Only enter once per window, early
      if (state.window?.timeToCloseMs == null || state.window.timeToCloseMs < 120000) return [];
      if (state._baselineEntered) return [];
      state._baselineEntered = true;

      const buyUp = rng() > 0.5;
      const sym = state.window?.symbol || 'btc';
      const token = buyUp ? `${sym}-up` : `${sym}-down`;
      return [{ action: 'buy', token, capitalPerTrade: config.capitalPerTrade || 2, reason: 'baseline-random' }];
    },
    onWindowOpen(state) {
      state._baselineEntered = false;
    },
    defaults: { capitalPerTrade: 2 },
    sweepGrid: {},
  };
}

// ─── Core Engine ───

/**
 * Run a factory backtest for a single strategy + symbol.
 *
 * @param {Object} params
 * @param {Object} params.strategy - Strategy object { name, evaluate, onWindowOpen?, onWindowClose?, defaults?, sweepGrid? }
 * @param {string} params.symbol - Symbol (e.g., 'btc')
 * @param {Object} [params.sampleOptions] - { count, seed, stratify }
 * @param {Object} [params.config] - { initialCapital, spreadBuffer, tradingFee, feeMode }
 * @param {Object} [params.sweepGrid] - Override sweep grid (if not from strategy)
 * @param {boolean} [params.includeBaseline=true] - Include baseline comparison
 * @param {Object} [params.configOverrides] - Config overrides applied to strategyConfig
 * @returns {Object} Full backtest results with metrics, regime, CI, baseline
 */
export async function runFactoryBacktest({
  strategy,
  symbol,
  sampleOptions = {},
  config = {},
  sweepGrid = null,
  includeBaseline = true,
  configOverrides = {},
  holdout = false,
  holdoutRatio = 0.3,
}) {
  const startTime = Date.now();
  const {
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    windowDurationMs = 5 * 60 * 1000,
    maxSweepCombinations = 500,
    feeMode: feeModeInput,
  } = config;

  // Fee mode: default to TAKER_ONLY (fees ON by default).
  // Must explicitly pass feeMode='zero' to disable fees.
  const feeMode = parseFeeMode(feeModeInput || FeeMode.TAKER_ONLY);

  // Load windows from SQLite cache
  const allWindows = loadWindowsForSymbol(symbol, sampleOptions);
  if (allWindows.length === 0) {
    throw new Error(
      `No windows found for symbol '${symbol}' in SQLite cache. ` +
      `Run 'node scripts/build-timelines.mjs --symbol=${symbol}' first.`
    );
  }

  // Sample windows
  const sampledWindows = sampleWindows(allWindows, {
    count: sampleOptions.count || 200,
    seed: sampleOptions.seed || 42,
    stratify: sampleOptions.stratify || 'weekly',
  });

  // Determine sweep grid (enforce combination limit)
  const grid = sweepGrid || strategy.sweepGrid || {};
  const defaults = strategy.defaults || {};
  let paramSets;

  if (Object.keys(grid).length > 0) {
    // Generate all sweep combinations, then merge each with defaults + overrides.
    // This ensures non-swept params (from YAML defaults) are always present in config.
    const sweepCombos = generateParamCombinations(grid, { maxCombinations: maxSweepCombinations });
    paramSets = sweepCombos.map(combo => ({ ...defaults, ...configOverrides, ...combo }));
  } else {
    paramSets = [{ ...defaults, ...configOverrides }];
  }

  // Analyze which data sources the strategy needs (for timeline trimming)
  const sources = analyzeStrategySources(strategy);

  // Evaluate all param combinations
  const variants = [];
  let trimStats = { totalEvents: 0, keptEvents: 0 };

  for (const params of paramSets) {
    const windowResults = [];

    for (const win of sampledWindows) {
      const loaded = loadTimeline(win.window_id);
      if (!loaded) continue;

      const { window: winMeta, timeline: rawTimeline } = loaded;

      // Trim timeline to only include events the strategy needs
      const timeline = trimTimeline(rawTimeline, sources);
      trimStats.totalEvents += rawTimeline.length;
      trimStats.keptEvents += timeline.length;

      // Map window metadata to the format evaluateWindow expects
      const windowEvent = {
        window_close_time: winMeta.window_close_time,
        symbol: winMeta.symbol,
        strike_price: winMeta.strike_price,
        oracle_price_at_open: winMeta.oracle_price_at_open,
        chainlink_price_at_close: winMeta.chainlink_price_at_close,
        resolved_direction: winMeta.ground_truth,
        gamma_resolved_direction: winMeta.ground_truth,
      };

      const result = evaluateWindow({
        window: windowEvent,
        timeline,
        strategy,
        strategyConfig: params,
        initialCapital,
        spreadBuffer,
        tradingFee,
        windowDurationMs,
        feeMode,
      });

      windowResults.push(result);
    }

    // Sort by close time for regime analysis
    windowResults.sort((a, b) =>
      new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
    );

    const metrics = computeMetrics(windowResults, initialCapital);
    const regime = computeRegimeBreakdown(windowResults, initialCapital);
    const returns = windowReturns(windowResults, initialCapital);
    const ci = bootstrapSharpeCI(returns, 1000, sampleOptions.seed || 42);

    // Aggregate fill quality metrics across all windows
    const allFills = windowResults.flatMap(wr => wr.fillResults || []);
    const fillQuality = aggregateFillMetrics(allFills);

    variants.push({
      params,
      metrics,
      regime,
      sharpeCi: ci,
      windowCount: windowResults.length,
      windowResults,
      fillQuality,
    });
  }

  // Rank variants by Sharpe
  variants.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);

  // Log timeline trimming stats
  if (trimStats.totalEvents > 0) {
    const removed = trimStats.totalEvents - trimStats.keptEvents;
    const pct = ((removed / trimStats.totalEvents) * 100).toFixed(1);
    console.log(
      `[trimmer] Removed ${removed}/${trimStats.totalEvents} events (${pct}% reduction) for strategy ${strategy.name}`
    );
  }

  // Baseline comparison
  let baseline = null;
  if (includeBaseline) {
    const baselineStrategy = createBaselineStrategy(sampleOptions.seed || 42);
    const baselineResults = [];

    for (const win of sampledWindows) {
      const loaded = loadTimeline(win.window_id);
      if (!loaded) continue;

      const { window: winMeta, timeline } = loaded;
      const windowEvent = {
        window_close_time: winMeta.window_close_time,
        symbol: winMeta.symbol,
        strike_price: winMeta.strike_price,
        oracle_price_at_open: winMeta.oracle_price_at_open,
        chainlink_price_at_close: winMeta.chainlink_price_at_close,
        resolved_direction: winMeta.ground_truth,
        gamma_resolved_direction: winMeta.ground_truth,
      };

      const result = evaluateWindow({
        window: windowEvent,
        timeline,
        strategy: baselineStrategy,
        strategyConfig: baselineStrategy.defaults,
        initialCapital,
        spreadBuffer,
        tradingFee,
        windowDurationMs,
        feeMode,
      });

      baselineResults.push(result);
    }

    baselineResults.sort((a, b) =>
      new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
    );
    baseline = computeMetrics(baselineResults, initialCapital);
  }

  // Parameter importance (for sweeps with >1 variant)
  let paramImportance = null;
  if (variants.length > 1 && Object.keys(grid).length > 0) {
    paramImportance = computeParamImportance(variants, grid);
  }

  // Out-of-sample holdout evaluation (adversarial review Story 12.3)
  let holdoutResult = null;
  if (holdout && variants.length > 0) {
    const { train, test } = splitWindows(sampledWindows, { trainRatio: 1 - holdoutRatio });
    const bestParams = variants[0].params;

    const evalWindowSet = (windowSet) => {
      const results = [];
      for (const win of windowSet) {
        const loaded = loadTimeline(win.window_id);
        if (!loaded) continue;
        const { window: winMeta, timeline } = loaded;
        const windowEvent = {
          window_close_time: winMeta.window_close_time,
          symbol: winMeta.symbol,
          strike_price: winMeta.strike_price,
          oracle_price_at_open: winMeta.oracle_price_at_open,
          chainlink_price_at_close: winMeta.chainlink_price_at_close,
          resolved_direction: winMeta.ground_truth,
          gamma_resolved_direction: winMeta.ground_truth,
        };
        results.push(evaluateWindow({
          window: windowEvent, timeline, strategy,
          strategyConfig: bestParams, initialCapital, spreadBuffer,
          tradingFee, windowDurationMs, feeMode,
        }));
      }
      results.sort((a, b) =>
        new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
      );
      return results;
    };

    const trainResults = evalWindowSet(train);
    const testResults = evalWindowSet(test);
    const trainMetrics = computeMetrics(trainResults, initialCapital);
    const testMetrics = computeMetrics(testResults, initialCapital);
    const testReturns = windowReturns(testResults, initialCapital);
    const testCi = bootstrapSharpeCI(testReturns, 1000, sampleOptions.seed || 42);

    holdoutResult = {
      bestParams,
      trainRatio: 1 - holdoutRatio,
      trainWindows: train.length,
      testWindows: test.length,
      inSample: trainMetrics,
      outOfSample: testMetrics,
      outOfSampleCi: testCi,
      overfitWarning: testMetrics.sharpe < trainMetrics.sharpe * 0.5,
    };
  }

  const wallClockMs = Date.now() - startTime;

  return {
    strategy: strategy.name,
    symbol,
    sampleSize: sampledWindows.length,
    totalWindows: allWindows.length,
    seed: sampleOptions.seed || 42,
    feeMode,
    variants: variants.map(v => ({
      params: v.params,
      metrics: v.metrics,
      regime: v.regime,
      sharpeCi: v.sharpeCi,
      windowCount: v.windowCount,
      fillQuality: v.fillQuality,
    })),
    baseline,
    paramImportance,
    holdout: holdoutResult,
    wallClockMs,
  };
}

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

// ─── PG-Backed Engine ───

/**
 * Run a factory backtest loading data directly from PostgreSQL.
 * Same interface as runFactoryBacktest but bypasses SQLite cache.
 * Uses concurrency-limited parallel execution for PG queries (default: 10 concurrent).
 * Ideal for Railway where the backtester is next to the database (<1ms latency).
 *
 * @param {Object} params - Same as runFactoryBacktest
 * @param {number} [params.pgConcurrency=10] - Max concurrent PG queries
 * @returns {Object} Full backtest results (identical format)
 */
export async function runFactoryBacktestPg({
  strategy,
  symbol,
  sampleOptions = {},
  config = {},
  sweepGrid = null,
  includeBaseline = true,
  configOverrides = {},
  holdout = false,
  holdoutRatio = 0.3,
  pgConcurrency = 10,
}) {
  const startTime = Date.now();
  const {
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    windowDurationMs = 5 * 60 * 1000,
    maxSweepCombinations = 500,
    feeMode: feeModeInput,
  } = config;

  const feeMode = parseFeeMode(feeModeInput || FeeMode.TAKER_ONLY);
  const limit = createLimiter(pgConcurrency);

  // Load windows from PostgreSQL (window_close_events table)
  // Use a wide date range to get all available windows
  const allWindows = await loadWindowsWithGroundTruth({
    startDate: sampleOptions.startDate || '2020-01-01',
    endDate: sampleOptions.endDate || '2030-01-01',
    symbols: [symbol.toLowerCase()],
  });

  if (allWindows.length === 0) {
    throw new Error(
      `No windows found for symbol '${symbol}' in PostgreSQL window_close_events table.`
    );
  }

  // Map PG rows to the format sampleWindows expects (needs window_close_time string)
  const windowsMapped = allWindows.map(w => ({
    ...w,
    window_close_time: w.window_close_time instanceof Date
      ? w.window_close_time.toISOString()
      : w.window_close_time,
  }));

  // Sample windows (same sampler as cache path)
  const sampledWindows = sampleWindows(windowsMapped, {
    count: sampleOptions.count || 200,
    seed: sampleOptions.seed || 42,
    stratify: sampleOptions.stratify || 'weekly',
  });

  // Determine sweep grid (enforce combination limit)
  const grid = sweepGrid || strategy.sweepGrid || {};
  const defaults = strategy.defaults || {};
  let paramSets;

  if (Object.keys(grid).length > 0) {
    const sweepCombos = generateParamCombinations(grid, { maxCombinations: maxSweepCombinations });
    paramSets = sweepCombos.map(combo => ({ ...defaults, ...configOverrides, ...combo }));
  } else {
    paramSets = [{ ...defaults, ...configOverrides }];
  }

  // Evaluate all param combinations with concurrency-limited parallel PG queries
  const variants = [];
  for (const params of paramSets) {
    const windowResultPromises = sampledWindows.map(win =>
      limit(async () => {
        const windowData = await loadWindowTickData({
          window: win,
          windowDurationMs,
        });

        const timeline = buildWindowTimelinePg(windowData);

        return evaluateWindow({
          window: win,
          timeline,
          strategy,
          strategyConfig: params,
          initialCapital,
          spreadBuffer,
          tradingFee,
          windowDurationMs,
          feeMode,
        });
      })
    );

    const windowResults = await Promise.all(windowResultPromises);

    windowResults.sort((a, b) =>
      new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
    );

    const metrics = computeMetrics(windowResults, initialCapital);
    const regime = computeRegimeBreakdown(windowResults, initialCapital);
    const returns = windowReturns(windowResults, initialCapital);
    const ci = bootstrapSharpeCI(returns, 1000, sampleOptions.seed || 42);

    const allFills = windowResults.flatMap(wr => wr.fillResults || []);
    const fillQuality = aggregateFillMetrics(allFills);

    variants.push({
      params,
      metrics,
      regime,
      sharpeCi: ci,
      windowCount: windowResults.length,
      windowResults,
      fillQuality,
    });
  }

  variants.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);

  // Baseline comparison (concurrent)
  let baseline = null;
  if (includeBaseline) {
    const baselineStrategy = createBaselineStrategy(sampleOptions.seed || 42);
    const baselinePromises = sampledWindows.map(win =>
      limit(async () => {
        const windowData = await loadWindowTickData({ window: win, windowDurationMs });
        const timeline = buildWindowTimelinePg(windowData);
        return evaluateWindow({
          window: win, timeline, strategy: baselineStrategy,
          strategyConfig: baselineStrategy.defaults,
          initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode,
        });
      })
    );
    const baselineResults = await Promise.all(baselinePromises);
    baselineResults.sort((a, b) =>
      new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
    );
    baseline = computeMetrics(baselineResults, initialCapital);
  }

  let paramImportance = null;
  if (variants.length > 1 && Object.keys(grid).length > 0) {
    paramImportance = computeParamImportance(variants, grid);
  }

  // Out-of-sample holdout evaluation (adversarial review Story 12.3)
  // Concurrency-limited parallel PG queries
  let holdoutResult = null;
  if (holdout && variants.length > 0) {
    const { train, test } = splitWindows(sampledWindows, { trainRatio: 1 - holdoutRatio });
    const bestParams = variants[0].params;

    const testResultPromises = test.map(win =>
      limit(async () => {
        const windowData = await loadWindowTickData({ window: win, windowDurationMs });
        const timeline = buildWindowTimelinePg(windowData);
        return evaluateWindow({
          window: win, timeline, strategy, strategyConfig: bestParams,
          initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode,
        });
      })
    );
    const testResults = await Promise.all(testResultPromises);
    testResults.sort((a, b) => new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime());

    const trainResultPromises = train.map(win =>
      limit(async () => {
        const windowData = await loadWindowTickData({ window: win, windowDurationMs });
        const timeline = buildWindowTimelinePg(windowData);
        return evaluateWindow({
          window: win, timeline, strategy, strategyConfig: bestParams,
          initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode,
        });
      })
    );
    const trainResults = await Promise.all(trainResultPromises);

    const trainMetrics = computeMetrics(trainResults, initialCapital);
    const testMetrics = computeMetrics(testResults, initialCapital);
    const testReturns = windowReturns(testResults, initialCapital);
    const testCi = bootstrapSharpeCI(testReturns, 1000, sampleOptions.seed || 42);
    holdoutResult = {
      bestParams, trainRatio: 1 - holdoutRatio,
      trainWindows: train.length, testWindows: test.length,
      inSample: trainMetrics, outOfSample: testMetrics,
      outOfSampleCi: testCi,
      overfitWarning: testMetrics.sharpe < trainMetrics.sharpe * 0.5,
    };
  }

  const wallClockMs = Date.now() - startTime;

  return {
    strategy: strategy.name,
    symbol,
    source: 'pg',
    sampleSize: sampledWindows.length,
    totalWindows: allWindows.length,
    seed: sampleOptions.seed || 42,
    feeMode,
    variants: variants.map(v => ({
      params: v.params,
      metrics: v.metrics,
      regime: v.regime,
      sharpeCi: v.sharpeCi,
      windowCount: v.windowCount,
      fillQuality: v.fillQuality,
    })),
    baseline,
    paramImportance,
    holdout: holdoutResult,
    wallClockMs,
  };
}

// ─── PG-Cache Engine ───

/**
 * Run a factory backtest from pre-computed pg_timelines BYTEA blobs.
 * FASTEST path: one row fetch per window, deserialize msgpack, pure CPU evaluation.
 * No tick-level PG queries — timeline is pre-built and cached as a binary blob.
 *
 * @param {Object} params - Same as runFactoryBacktest
 * @returns {Object} Full backtest results (identical format)
 */
export async function runFactoryBacktestPgCache({
  strategy,
  symbol,
  sampleOptions = {},
  config = {},
  sweepGrid = null,
  includeBaseline = true,
  configOverrides = {},
  parallel = true,
  poolSize,
}) {
  const { loadTimelinePg, loadWindowsForSymbolPg } = await import('../timeline-loader.js');

  const startTime = Date.now();
  const {
    initialCapital = 100,
    spreadBuffer = 0.005,
    tradingFee = 0,
    windowDurationMs = 5 * 60 * 1000,
    maxSweepCombinations = 500,
    feeMode: feeModeInput,
  } = config;

  const feeMode = parseFeeMode(feeModeInput || FeeMode.TAKER_ONLY);

  // List all cached windows for this symbol (metadata only, no blob)
  const allCachedWindows = await loadWindowsForSymbolPg(symbol.toLowerCase(), {
    startDate: sampleOptions.startDate,
    endDate: sampleOptions.endDate,
  });

  if (allCachedWindows.length === 0) {
    throw new Error(
      `No cached timelines found for symbol '${symbol}' in pg_timelines table. ` +
      `Build timelines first or use --source=pg.`
    );
  }

  // Map to the format sampleWindows expects
  const windowsMapped = allCachedWindows.map(w => ({
    ...w,
    window_close_time: w.window_close_time instanceof Date
      ? w.window_close_time.toISOString()
      : w.window_close_time,
  }));

  // Sample windows
  const sampledWindows = sampleWindows(windowsMapped, {
    count: sampleOptions.count || 200,
    seed: sampleOptions.seed || 42,
    stratify: sampleOptions.stratify || 'weekly',
  });

  // Determine sweep grid
  const grid = sweepGrid || strategy.sweepGrid || {};
  const defaults = strategy.defaults || {};
  let paramSets;

  if (Object.keys(grid).length > 0) {
    const sweepCombos = generateParamCombinations(grid, { maxCombinations: maxSweepCombinations });
    paramSets = sweepCombos.map(combo => ({ ...defaults, ...configOverrides, ...combo }));
  } else {
    paramSets = [{ ...defaults, ...configOverrides }];
  }

  // ─── Parallel Path (worker threads) ───
  // Workers load timelines from PG themselves — no timeline pre-loading on main thread.
  // Each worker loads the strategy once, then evaluates multiple windows.
  if (parallel && sampledWindows.length >= 4) {
    const { createParallelEvaluator } = await import('../parallel-evaluator.js');

    const workerConfig = {
      initialCapital,
      spreadBuffer,
      tradingFee,
      windowDurationMs,
      feeMode: feeModeInput || 'taker',
    };

    const evaluator = await createParallelEvaluator({
      strategyName: strategy.name,
      config: workerConfig,
      poolSize,
    });

    try {
      const variants = [];

      for (const params of paramSets) {
        const rawResults = await evaluator.evaluateWindows(sampledWindows, {
          strategyParams: params,
        });

        // Filter out skipped windows
        const windowResults = rawResults.filter(r => !r.skipped);

        windowResults.sort((a, b) =>
          new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
        );

        const metrics = computeMetrics(windowResults, initialCapital);
        const regime = computeRegimeBreakdown(windowResults, initialCapital);
        const returns = windowReturns(windowResults, initialCapital);
        const ci = bootstrapSharpeCI(returns, 1000, sampleOptions.seed || 42);

        const allFills = windowResults.flatMap(wr => wr.fillResults || []);
        const fillQuality = aggregateFillMetrics(allFills);

        variants.push({
          params,
          metrics,
          regime,
          sharpeCi: ci,
          windowCount: windowResults.length,
          windowResults,
          fillQuality,
        });
      }

      variants.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);

      // Baseline uses sequential path — it's a single strategy, fast enough
      let baseline = null;
      if (includeBaseline) {
        baseline = await _evaluateBaselineSequential(
          sampledWindows, loadTimelinePg, sampleOptions,
          { initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode },
        );
      }

      let paramImportance = null;
      if (variants.length > 1 && Object.keys(grid).length > 0) {
        paramImportance = computeParamImportance(variants, grid);
      }

      const wallClockMs = Date.now() - startTime;

      return {
        strategy: strategy.name,
        symbol,
        source: 'pg-cache-parallel',
        sampleSize: sampledWindows.length,
        totalWindows: allCachedWindows.length,
        seed: sampleOptions.seed || 42,
        feeMode,
        poolSize: evaluator.poolSize,
        variants: variants.map(v => ({
          params: v.params,
          metrics: v.metrics,
          regime: v.regime,
          sharpeCi: v.sharpeCi,
          windowCount: v.windowCount,
          fillQuality: v.fillQuality,
        })),
        baseline,
        paramImportance,
        wallClockMs,
      };
    } finally {
      await evaluator.destroy();
    }
  }

  // ─── Sequential Fallback Path ───
  // Used when parallel=false or when window count is too small to benefit.

  // Analyze which data sources the strategy needs (for timeline trimming)
  const sources = analyzeStrategySources(strategy);

  // Load all timelines from PG cache, applying trimming
  const cachedTimelines = new Map();
  for (const win of sampledWindows) {
    const loaded = await loadTimelinePg(win.window_id);
    if (loaded) {
      const trimmed = trimTimeline(loaded.timeline, sources);
      cachedTimelines.set(win.window_id, { timeline: trimmed, meta: loaded.window });
    }
  }

  // Evaluate all param combinations — pure CPU, no DB queries
  const variants = [];
  for (const params of paramSets) {
    const windowResults = [];

    for (const win of sampledWindows) {
      const cached = cachedTimelines.get(win.window_id);
      if (!cached) continue;

      const { timeline, meta } = cached;

      const windowEvent = {
        window_close_time: meta.window_close_time,
        symbol: meta.symbol,
        strike_price: meta.strike_price,
        oracle_price_at_open: meta.oracle_price_at_open,
        chainlink_price_at_close: meta.chainlink_price_at_close,
        resolved_direction: meta.ground_truth,
        gamma_resolved_direction: meta.ground_truth,
      };

      const result = evaluateWindow({
        window: windowEvent,
        timeline,
        strategy,
        strategyConfig: params,
        initialCapital,
        spreadBuffer,
        tradingFee,
        windowDurationMs,
        feeMode,
      });

      windowResults.push(result);
    }

    windowResults.sort((a, b) =>
      new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
    );

    const metrics = computeMetrics(windowResults, initialCapital);
    const regime = computeRegimeBreakdown(windowResults, initialCapital);
    const returns = windowReturns(windowResults, initialCapital);
    const ci = bootstrapSharpeCI(returns, 1000, sampleOptions.seed || 42);

    const allFills = windowResults.flatMap(wr => wr.fillResults || []);
    const fillQuality = aggregateFillMetrics(allFills);

    variants.push({
      params,
      metrics,
      regime,
      sharpeCi: ci,
      windowCount: windowResults.length,
      windowResults,
      fillQuality,
    });
  }

  variants.sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);

  // Baseline comparison (pure CPU — timelines already loaded)
  let baseline = null;
  if (includeBaseline) {
    baseline = await _evaluateBaselineSequential(
      sampledWindows, loadTimelinePg, sampleOptions,
      { initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode },
      cachedTimelines,
    );
  }

  let paramImportance = null;
  if (variants.length > 1 && Object.keys(grid).length > 0) {
    paramImportance = computeParamImportance(variants, grid);
  }

  const wallClockMs = Date.now() - startTime;

  return {
    strategy: strategy.name,
    symbol,
    source: 'pg-cache',
    sampleSize: sampledWindows.length,
    totalWindows: allCachedWindows.length,
    seed: sampleOptions.seed || 42,
    feeMode,
    variants: variants.map(v => ({
      params: v.params,
      metrics: v.metrics,
      regime: v.regime,
      sharpeCi: v.sharpeCi,
      windowCount: v.windowCount,
      fillQuality: v.fillQuality,
    })),
    baseline,
    paramImportance,
    wallClockMs,
  };
}

/**
 * Evaluate the baseline-random strategy sequentially.
 * Extracted to avoid duplicating baseline logic between parallel and sequential paths.
 *
 * @param {Object[]} sampledWindows - Sampled windows
 * @param {Function} loadTimelinePg - PG timeline loader
 * @param {Object} sampleOptions - Sample options (for seed)
 * @param {Object} evalConfig - { initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode }
 * @param {Map} [cachedTimelines] - Pre-loaded timelines (optional, for sequential path)
 * @returns {Promise<Object>} Baseline metrics
 */
async function _evaluateBaselineSequential(
  sampledWindows, loadTimelinePg, sampleOptions, evalConfig, cachedTimelines,
) {
  const { initialCapital, spreadBuffer, tradingFee, windowDurationMs, feeMode } = evalConfig;
  const baselineStrategy = createBaselineStrategy(sampleOptions.seed || 42);
  const baselineResults = [];

  for (const win of sampledWindows) {
    let timeline, meta;

    if (cachedTimelines) {
      const cached = cachedTimelines.get(win.window_id);
      if (!cached) continue;
      timeline = cached.timeline;
      meta = cached.meta;
    } else {
      const loaded = await loadTimelinePg(win.window_id);
      if (!loaded) continue;
      timeline = loaded.timeline;
      meta = loaded.window;
    }

    const windowEvent = {
      window_close_time: meta.window_close_time,
      symbol: meta.symbol,
      strike_price: meta.strike_price,
      oracle_price_at_open: meta.oracle_price_at_open,
      chainlink_price_at_close: meta.chainlink_price_at_close,
      resolved_direction: meta.ground_truth,
      gamma_resolved_direction: meta.ground_truth,
    };

    const result = evaluateWindow({
      window: windowEvent,
      timeline,
      strategy: baselineStrategy,
      strategyConfig: baselineStrategy.defaults,
      initialCapital,
      spreadBuffer,
      tradingFee,
      windowDurationMs,
      feeMode,
    });

    baselineResults.push(result);
  }

  baselineResults.sort((a, b) =>
    new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
  );
  return computeMetrics(baselineResults, initialCapital);
}

/**
 * Build a merged timeline from PG-loaded window data.
 * Matches the format expected by evaluateWindow / MarketState.processEvent.
 * Pre-computes _ms on each event to avoid repeated Date parsing in hot paths.
 */
function buildWindowTimelinePg(windowData) {
  const { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks } = windowData;
  const timeline = [];

  for (const tick of rtdsTicks) {
    const topic = tick.topic;
    let source;
    if (topic === 'crypto_prices_chainlink') source = 'chainlink';
    else if (topic === 'crypto_prices') source = 'polyRef';
    else source = `rtds_${topic}`;
    const _ms = new Date(tick.timestamp).getTime();
    timeline.push({ ...tick, source, _ms });
  }

  for (const snap of clobSnapshots) {
    const isDown = snap.symbol?.toLowerCase().includes('down');
    const source = isDown ? 'clobDown' : 'clobUp';
    const _ms = new Date(snap.timestamp).getTime();
    timeline.push({ ...snap, source, _ms });
  }

  for (const tick of exchangeTicks) {
    const _ms = new Date(tick.timestamp).getTime();
    timeline.push({ ...tick, source: `exchange_${tick.exchange}`, _ms });
  }

  // L2 book ticks -> l2Up or l2Down (matching timeline-builder.js pattern)
  if (l2BookTicks && l2BookTicks.length > 0) {
    // Build token_id -> direction map from CLOB snapshots
    const tokenDirMap = new Map();
    for (const snap of clobSnapshots) {
      if (snap.token_id && !tokenDirMap.has(snap.token_id)) {
        tokenDirMap.set(snap.token_id, snap.symbol?.toLowerCase().includes('down') ? 'down' : 'up');
      }
    }
    for (const tick of l2BookTicks) {
      const direction = tokenDirMap.get(tick.token_id) ||
        (tick.symbol?.toLowerCase().includes('down') ? 'down' : 'up');
      const source = direction === 'down' ? 'l2Down' : 'l2Up';
      const _ms = new Date(tick.timestamp).getTime();
      timeline.push({
        source, timestamp: tick.timestamp,
        best_bid: parseFloat(tick.best_bid), best_ask: parseFloat(tick.best_ask),
        mid_price: parseFloat(tick.mid_price), spread: parseFloat(tick.spread || 0),
        bid_depth_1pct: parseFloat(tick.bid_depth_1pct || 0),
        ask_depth_1pct: parseFloat(tick.ask_depth_1pct || 0),
        top_levels: tick.top_levels || null, _ms,
      });
    }
  }

  // Sort by pre-computed _ms (avoids Date parsing in comparator)
  timeline.sort((a, b) => a._ms - b._ms);

  return timeline;
}

/**
 * Compute parameter importance: average Sharpe per parameter value.
 */
function computeParamImportance(variants, grid) {
  const importance = {};
  for (const [param, values] of Object.entries(grid)) {
    importance[param] = {};
    for (const val of values) {
      const matching = variants.filter(v => v.params[param] === val);
      if (matching.length > 0) {
        const avgSharpe = matching.reduce((s, v) => s + v.metrics.sharpe, 0) / matching.length;
        importance[param][String(val)] = { avgSharpe, count: matching.length };
      }
    }
  }
  return importance;
}
