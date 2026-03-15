/**
 * Batch Runner (Story 3.6)
 *
 * Executes multiple strategy/config/symbol combinations from a JSON manifest.
 * Parallel execution with error isolation — individual run failures don't crash the batch.
 * All results persisted to PostgreSQL.
 *
 * Exports:
 *   - runBatch(manifest) — execute full manifest
 *   - runSingle(runSpec) — execute one strategy/symbol combo
 *
 * Covers: FR22 (batch runs), NFR3 (<60s for 100 combinations)
 */

import { runFactoryBacktest } from './cli/backtest-factory.js';
import { loadStrategy } from './index.js';
import {
  createRun,
  completeRun,
  failRun,
  persistBacktestResult,
  persistFailedResult,
  ensureSchema,
} from './result-persister.js';

// ─── Concurrency Limiter ───

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

// ─── Single Run ───

/**
 * Execute a single backtest run from a run specification.
 *
 * @param {Object} runSpec
 * @param {string} runSpec.strategy - Strategy name/file
 * @param {string} [runSpec.symbol='btc'] - Symbol
 * @param {number} [runSpec.sample=200] - Sample size
 * @param {number} [runSpec.seed=42] - PRNG seed
 * @param {Object} [runSpec.config] - Config overrides (capital, spread, fee)
 * @param {Object} [runSpec.configOverrides] - Strategy config overrides
 * @param {Object} [runSpec.sweepGrid] - Sweep grid override
 * @param {boolean} [runSpec.includeBaseline=false] - Include baseline
 * @returns {Promise<Object>} Backtest result
 */
export async function runSingle(runSpec) {
  const {
    strategy: strategyName,
    symbol = 'btc',
    sample = 200,
    seed = 42,
    config = {},
    configOverrides = {},
    sweepGrid = null,
    includeBaseline = false,
  } = runSpec;

  const strategy = typeof strategyName === 'string'
    ? await loadStrategy(strategyName)
    : strategyName; // Allow passing strategy objects directly

  return runFactoryBacktest({
    strategy,
    symbol,
    sampleOptions: { count: sample, seed },
    config: {
      initialCapital: config.capital || config.initialCapital || 100,
      spreadBuffer: config.spread || config.spreadBuffer || 0.005,
      tradingFee: config.fee || config.tradingFee || 0,
      feeMode: config.feeMode || config.fee_mode,
    },
    sweepGrid,
    includeBaseline,
    configOverrides,
  });
}

// ─── Batch Runner ───

/**
 * Execute a batch of strategy/config/symbol combinations.
 *
 * @param {Object} manifest
 * @param {string} [manifest.name] - Batch name
 * @param {Object} [manifest.defaults] - Default config for all runs
 * @param {Object[]} manifest.runs - Array of run specifications
 * @param {number} [manifest.concurrency=4] - Max parallel runs
 * @param {Object} [options]
 * @param {boolean} [options.persist=false] - Persist results to PostgreSQL
 * @param {Function} [options.onProgress] - Progress callback (completed, total, result)
 * @returns {Promise<Object>} Aggregated batch results
 */
export async function runBatch(manifest, options = {}) {
  const {
    name: batchName = 'unnamed-batch',
    defaults = {},
    runs = [],
    concurrency = 4,
  } = manifest;

  const { persist = false, onProgress } = options;

  if (!runs || runs.length === 0) {
    throw new Error('Batch manifest must contain at least one run');
  }

  const startTime = Date.now();
  let runId = null;

  // Create run record if persisting
  if (persist) {
    try {
      await ensureSchema();
      runId = await createRun({
        manifestName: batchName,
        manifestJson: manifest,
        totalRuns: runs.length,
      });
    } catch {
      // If DB not available, continue without persistence
    }
  }

  const limit = createLimiter(concurrency);
  let completed = 0;
  const results = [];

  const promises = runs.map((runSpec, idx) => {
    return limit(async () => {
      // Merge defaults with run-specific config
      const mergedSpec = {
        ...defaults,
        ...runSpec,
        config: { ...defaults.config, ...runSpec.config },
        configOverrides: { ...defaults.configOverrides, ...runSpec.configOverrides },
      };

      let result;
      try {
        result = await runSingle(mergedSpec);
        result._index = idx;
        result._status = 'completed';

        // Persist if enabled
        if (persist && runId) {
          try {
            await persistBacktestResult(runId, result);
          } catch {
            // Don't crash batch on persistence failure
          }
        }
      } catch (err) {
        result = {
          _index: idx,
          _status: 'failed',
          strategy: mergedSpec.strategy,
          symbol: mergedSpec.symbol || 'btc',
          error: err.message,
          variants: [],
          wallClockMs: 0,
        };

        // Persist failure
        if (persist && runId) {
          try {
            await persistFailedResult({
              runId,
              strategyName: typeof mergedSpec.strategy === 'string'
                ? mergedSpec.strategy
                : mergedSpec.strategy?.name || 'unknown',
              symbol: mergedSpec.symbol || 'btc',
              errorMessage: err.message,
            });
          } catch {
            // Don't crash batch on persistence failure
          }
        }
      }

      completed++;
      if (onProgress) {
        onProgress(completed, runs.length, result);
      }

      return result;
    });
  });

  const allResults = await Promise.all(promises);

  // Sort by original index to maintain order
  allResults.sort((a, b) => a._index - b._index);

  // Build ranking (by best variant Sharpe, successful runs only)
  const ranked = allResults
    .filter(r => r._status === 'completed' && r.variants?.length > 0)
    .map(r => ({
      strategy: r.strategy,
      symbol: r.symbol,
      bestSharpe: r.variants[0]?.metrics?.sharpe || 0,
      bestPF: r.variants[0]?.metrics?.profitFactor || 0,
      bestWinRate: r.variants[0]?.metrics?.winRate || 0,
      trades: r.variants[0]?.metrics?.trades || 0,
      totalPnl: r.variants[0]?.metrics?.totalPnl || 0,
      wallClockMs: r.wallClockMs || 0,
    }))
    .sort((a, b) => b.bestSharpe - a.bestSharpe);

  const wallClockMs = Date.now() - startTime;
  const successCount = allResults.filter(r => r._status === 'completed').length;
  const failCount = allResults.filter(r => r._status === 'failed').length;

  const batchResult = {
    batchName,
    totalRuns: runs.length,
    completed: successCount,
    failed: failCount,
    wallClockMs,
    ranking: ranked,
    results: allResults.map(r => {
      // Clean up internal fields
      const { _index, _status, ...rest } = r;
      return { ...rest, status: _status };
    }),
  };

  // Complete run record
  if (persist && runId) {
    try {
      await completeRun(runId, {
        summary: {
          totalRuns: runs.length,
          completed: successCount,
          failed: failCount,
          topStrategy: ranked[0] ? `${ranked[0].strategy} x ${ranked[0].symbol}` : null,
        },
        wallClockMs,
        completedRuns: successCount,
      });
    } catch {
      // Don't crash on persistence failure
    }
  }

  return batchResult;
}
