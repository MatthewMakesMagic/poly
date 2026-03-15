/**
 * Unit tests for Batch Runner (Story 3.6)
 *
 * Tests batch execution with mocked runFactoryBacktest.
 * Verifies: parallel execution, error isolation, ranking, progress callbacks.
 *
 * What this tests:
 *   - runBatch executes all runs from manifest
 *   - Errors in individual runs don't crash batch
 *   - Results are ranked by Sharpe
 *   - Progress callback fires
 *   - Empty manifest throws
 *   - runSingle with strategy object (not just name)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the backtest engine to avoid SQLite dependency
vi.mock('../../../src/factory/cli/backtest-factory.js', () => ({
  runFactoryBacktest: vi.fn(),
  generateParamCombinations: vi.fn().mockReturnValue([{}]),
}));

// Mock persistence
vi.mock('../../../src/factory/result-persister.js', () => ({
  ensureSchema: vi.fn().mockResolvedValue(undefined),
  createRun: vi.fn().mockResolvedValue(1),
  completeRun: vi.fn().mockResolvedValue(undefined),
  failRun: vi.fn().mockResolvedValue(undefined),
  persistBacktestResult: vi.fn().mockResolvedValue([1]),
  persistFailedResult: vi.fn().mockResolvedValue(1),
}));

import { runBatch, runSingle } from '../../../src/factory/batch-runner.js';
import { runFactoryBacktest } from '../../../src/factory/cli/backtest-factory.js';

function makeBacktestResult(strategy = 'test', symbol = 'btc', sharpe = 1.0) {
  return {
    strategy,
    symbol,
    sampleSize: 100,
    totalWindows: 500,
    seed: 42,
    wallClockMs: 100,
    variants: [{
      params: {},
      metrics: {
        sharpe,
        sortino: sharpe * 1.2,
        profitFactor: 1.5,
        maxDrawdown: 0.05,
        winRate: 0.6,
        trades: 50,
        expectancy: 0.02,
        edgePerTrade: 0.05,
        totalPnl: 10,
        finalCapital: 110,
        equityCurve: [100, 110],
      },
      regime: {},
      sharpeCi: { mean: sharpe, ci95Lower: sharpe - 0.5, ci95Upper: sharpe + 0.5 },
      windowCount: 100,
    }],
    baseline: null,
    paramImportance: null,
  };
}

describe('runBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws for empty manifest', async () => {
    await expect(runBatch({ runs: [] })).rejects.toThrow('at least one run');
  });

  it('executes all runs and returns aggregated results', async () => {
    runFactoryBacktest
      .mockResolvedValueOnce(makeBacktestResult('strat-a', 'btc', 1.5))
      .mockResolvedValueOnce(makeBacktestResult('strat-b', 'eth', 0.8));

    const result = await runBatch({
      name: 'test-batch',
      runs: [
        { strategy: { name: 'strat-a', evaluate: () => [] }, symbol: 'btc' },
        { strategy: { name: 'strat-b', evaluate: () => [] }, symbol: 'eth' },
      ],
    });

    expect(result.totalRuns).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(2);
  });

  it('ranks results by Sharpe descending', async () => {
    runFactoryBacktest
      .mockResolvedValueOnce(makeBacktestResult('strat-a', 'btc', 0.5))
      .mockResolvedValueOnce(makeBacktestResult('strat-b', 'eth', 2.0));

    const result = await runBatch({
      runs: [
        { strategy: { name: 'strat-a', evaluate: () => [] }, symbol: 'btc' },
        { strategy: { name: 'strat-b', evaluate: () => [] }, symbol: 'eth' },
      ],
    });

    expect(result.ranking[0].strategy).toBe('strat-b');
    expect(result.ranking[0].bestSharpe).toBe(2.0);
    expect(result.ranking[1].strategy).toBe('strat-a');
  });

  it('isolates errors — failed runs do not crash batch', async () => {
    runFactoryBacktest
      .mockResolvedValueOnce(makeBacktestResult('strat-ok', 'btc', 1.0))
      .mockRejectedValueOnce(new Error('Strategy exploded'));

    const result = await runBatch({
      runs: [
        { strategy: { name: 'strat-ok', evaluate: () => [] }, symbol: 'btc' },
        { strategy: { name: 'strat-bad', evaluate: () => [] }, symbol: 'eth' },
      ],
    });

    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[1].status).toBe('failed');
    expect(result.results[1].error).toBe('Strategy exploded');
    expect(result.ranking).toHaveLength(1);
  });

  it('calls progress callback', async () => {
    runFactoryBacktest
      .mockResolvedValueOnce(makeBacktestResult('a', 'btc', 1.0))
      .mockResolvedValueOnce(makeBacktestResult('b', 'btc', 1.0));

    const progress = vi.fn();
    await runBatch({
      runs: [
        { strategy: { name: 'a', evaluate: () => [] } },
        { strategy: { name: 'b', evaluate: () => [] } },
      ],
    }, { onProgress: progress });

    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(1, 2, expect.any(Object));
    expect(progress).toHaveBeenCalledWith(2, 2, expect.any(Object));
  });

  it('applies manifest defaults to runs', async () => {
    runFactoryBacktest.mockResolvedValue(makeBacktestResult('a', 'btc', 1.0));

    await runBatch({
      defaults: { sample: 50, seed: 99, config: { capital: 500 } },
      runs: [{ strategy: { name: 'a', evaluate: () => [] }, symbol: 'btc' }],
    });

    expect(runFactoryBacktest).toHaveBeenCalledTimes(1);
    const callArgs = runFactoryBacktest.mock.calls[0][0];
    expect(callArgs.sampleOptions.count).toBe(50);
    expect(callArgs.sampleOptions.seed).toBe(99);
    expect(callArgs.config.initialCapital).toBe(500);
  });

  it('reports wall clock time', async () => {
    runFactoryBacktest.mockResolvedValue(makeBacktestResult('a', 'btc', 1.0));

    const result = await runBatch({
      runs: [{ strategy: { name: 'a', evaluate: () => [] } }],
    });

    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runSingle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs with a strategy object', async () => {
    runFactoryBacktest.mockResolvedValue(makeBacktestResult('direct', 'btc', 1.0));

    const result = await runSingle({
      strategy: { name: 'direct', evaluate: () => [], defaults: {} },
      symbol: 'btc',
      sample: 50,
      seed: 42,
    });

    expect(result.strategy).toBe('direct');
    expect(runFactoryBacktest).toHaveBeenCalledTimes(1);
  });

  it('passes config overrides', async () => {
    runFactoryBacktest.mockResolvedValue(makeBacktestResult('a', 'btc', 1.0));

    await runSingle({
      strategy: { name: 'a', evaluate: () => [], defaults: {} },
      config: { capital: 200, spread: 0.01 },
    });

    const callArgs = runFactoryBacktest.mock.calls[0][0];
    expect(callArgs.config.initialCapital).toBe(200);
    expect(callArgs.config.spreadBuffer).toBe(0.01);
  });
});
