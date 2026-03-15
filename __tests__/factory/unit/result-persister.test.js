/**
 * Unit tests for Result Persister (Story 3.3)
 *
 * Tests the persistence layer with mocked DB calls.
 * Verifies correct SQL and parameter passing for all operations.
 *
 * What this tests:
 *   - Schema creation (ensureSchema)
 *   - createRun returns run ID
 *   - completeRun updates status
 *   - failRun persists error
 *   - persistResult stores metrics as JSONB
 *   - persistFailedResult captures errors without crashing
 *   - persistBacktestResult convenience function
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock persistence before importing result-persister
vi.mock('../../../src/persistence/index.js', () => {
  let idCounter = 0;
  return {
    default: {
      exec: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation(() => Promise.resolve({ id: ++idCounter, run_id: idCounter })),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
    },
  };
});

import persistence from '../../../src/persistence/index.js';
import {
  ensureSchema,
  resetSchemaState,
  createRun,
  completeRun,
  failRun,
  persistResult,
  persistFailedResult,
  persistBacktestResult,
} from '../../../src/factory/result-persister.js';

describe('Result Persister', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSchemaState();
  });

  describe('ensureSchema', () => {
    it('calls exec with CREATE TABLE SQL', async () => {
      await ensureSchema();
      expect(persistence.exec).toHaveBeenCalledTimes(1);
      const sql = persistence.exec.mock.calls[0][0];
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS factory_runs');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS factory_results');
      expect(sql).toContain('idx_factory_results_strategy');
      expect(sql).toContain('idx_factory_results_symbol');
      expect(sql).toContain('idx_factory_results_created');
    });

    it('is idempotent — only executes once', async () => {
      await ensureSchema();
      await ensureSchema();
      expect(persistence.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('createRun', () => {
    it('inserts a run and returns the ID', async () => {
      const id = await createRun({
        manifestName: 'test-run',
        totalRuns: 5,
      });
      expect(typeof id).toBe('number');
      expect(persistence.get).toHaveBeenCalledTimes(1);
      const [sql, params] = persistence.get.mock.calls[0];
      expect(sql).toContain('INSERT INTO factory_runs');
      expect(params[0]).toBe('test-run');
    });

    it('handles null manifest', async () => {
      const id = await createRun();
      expect(typeof id).toBe('number');
    });
  });

  describe('completeRun', () => {
    it('updates run status to completed', async () => {
      await completeRun(1, {
        summary: { totalTrades: 100 },
        wallClockMs: 500,
        completedRuns: 3,
      });
      expect(persistence.run).toHaveBeenCalledTimes(1);
      const [sql, params] = persistence.run.mock.calls[0];
      expect(sql).toContain('status = \'completed\'');
      expect(params[0]).toBe(500); // wallClockMs
      expect(params[3]).toBe(1); // runId
    });
  });

  describe('failRun', () => {
    it('updates run status to failed with error message', async () => {
      await failRun(1, 'Something went wrong');
      expect(persistence.run).toHaveBeenCalledTimes(1);
      const [sql, params] = persistence.run.mock.calls[0];
      expect(sql).toContain('status = \'failed\'');
      expect(params[0]).toBe('Something went wrong');
      expect(params[1]).toBe(1);
    });
  });

  describe('persistResult', () => {
    it('inserts a result with metrics as JSONB', async () => {
      const id = await persistResult({
        runId: 1,
        strategyName: 'test-strategy',
        symbol: 'btc',
        metrics: { sharpe: 1.5, winRate: 0.6 },
        sampleSize: 200,
        sampleSeed: 42,
        elapsedMs: 300,
      });
      expect(typeof id).toBe('number');
      const [sql, params] = persistence.get.mock.calls[persistence.get.mock.calls.length - 1];
      expect(sql).toContain('INSERT INTO factory_results');
      expect(params[1]).toBe('test-strategy');
      expect(params[4]).toBe('btc');
    });

    it('persists strategy_source', async () => {
      await persistResult({
        strategyName: 'yaml-strat',
        strategySource: 'yaml',
        symbol: 'eth',
        metrics: { sharpe: 0.5 },
      });
      const params = persistence.get.mock.calls[persistence.get.mock.calls.length - 1][1];
      expect(params[3]).toBe('yaml');
    });
  });

  describe('persistFailedResult', () => {
    it('persists error without metrics', async () => {
      const id = await persistFailedResult({
        runId: 1,
        strategyName: 'broken-strategy',
        symbol: 'sol',
        errorMessage: 'Strategy threw an error',
      });
      expect(typeof id).toBe('number');
    });
  });

  describe('persistBacktestResult', () => {
    it('persists all variants from a backtest result', async () => {
      const result = {
        strategy: 'test-strat',
        symbol: 'btc',
        sampleSize: 100,
        seed: 42,
        wallClockMs: 400,
        variants: [
          {
            params: { threshold: 50 },
            metrics: { sharpe: 1.2, trades: 50, winRate: 0.6, totalPnl: 10, equityCurve: [100, 110] },
            regime: { firstHalf: {}, secondHalf: {} },
            sharpeCi: { mean: 1.2, ci95Lower: 0.5, ci95Upper: 1.9 },
          },
          {
            params: { threshold: 75 },
            metrics: { sharpe: 0.8, trades: 40, winRate: 0.55, totalPnl: 5, equityCurve: [100, 105] },
            regime: { firstHalf: {}, secondHalf: {} },
            sharpeCi: { mean: 0.8, ci95Lower: 0.1, ci95Upper: 1.5 },
          },
        ],
      };

      const ids = await persistBacktestResult(1, result);
      expect(ids).toHaveLength(2);
      // One ensureSchema + two persistResult calls = 3 get calls
      // (ensureSchema uses exec, not get, so actually just 2 get calls for persistResult)
    });

    it('strips equityCurve from stored metrics', async () => {
      const result = {
        strategy: 'test',
        symbol: 'btc',
        sampleSize: 50,
        seed: 42,
        wallClockMs: 100,
        variants: [{
          params: {},
          metrics: { sharpe: 1.0, trades: 10, winRate: 0.5, totalPnl: 0, equityCurve: [100, 100] },
          regime: {},
          sharpeCi: { mean: 1.0 },
        }],
      };

      await persistBacktestResult(null, result);
      const lastCall = persistence.get.mock.calls[persistence.get.mock.calls.length - 1];
      const metricsJson = lastCall[1][8]; // metrics param position
      const parsed = JSON.parse(metricsJson);
      expect(parsed.equityCurve).toBeUndefined();
    });
  });
});
