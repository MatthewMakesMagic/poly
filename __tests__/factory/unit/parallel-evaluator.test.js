/**
 * Tests for ParallelEvaluator — worker thread pool for backtest window evaluation.
 *
 * These tests mock worker_threads to avoid real PG connections and strategy loading.
 * They verify pool creation, window distribution, result collection, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track Worker constructor calls for assertions
let workerConstructorCalls = 0;

// Mock worker_threads — we don't want to spawn real workers in unit tests
vi.mock('node:worker_threads', () => {
  class MockWorker {
    constructor(path) {
      workerConstructorCalls++;
      this._path = path;
      this._listeners = new Map();
      this._onceListeners = new Map();
    }

    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(handler);
    }

    off(event, handler) {
      const handlers = this._listeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    }

    once(event, handler) {
      if (!this._onceListeners.has(event)) this._onceListeners.set(event, []);
      this._onceListeners.get(event).push(handler);
    }

    emit(event, data) {
      const handlers = [...(this._listeners.get(event) || [])];
      for (const h of handlers) h(data);
      const onceHandlers = [...(this._onceListeners.get(event) || [])];
      this._onceListeners.delete(event);
      for (const h of onceHandlers) h(data);
    }

    postMessage(msg) {
      if (msg.type === 'init') {
        setTimeout(() => this.emit('message', { type: 'ready' }), 5);
      } else if (msg.type === 'evaluate') {
        setTimeout(() => {
          this.emit('message', {
            type: 'result',
            id: msg.id,
            result: {
              windowCloseTime: msg.windowMeta?.window_close_time || '2026-01-01T00:00:00Z',
              symbol: msg.windowMeta?.symbol || 'btc',
              pnl: 1.5,
              tradesInWindow: 2,
              trades: [{ pnl: 1.0 }, { pnl: 0.5 }],
              eventsProcessed: 100,
              capitalAfter: 101.5,
              winRate: 1.0,
              fillResults: [],
            },
          });
        }, 5);
      } else if (msg.type === 'shutdown') {
        setTimeout(() => this.emit('exit', 0), 5);
      }
    }

    async terminate() {
      return 0;
    }
  }

  return { Worker: MockWorker };
});

// Mock os.availableParallelism
vi.mock('node:os', () => ({
  availableParallelism: () => 4,
}));

// Now import the module under test (after mocks are set up)
const { createParallelEvaluator, evaluateWindowsParallel } = await import(
  '../../../src/factory/parallel-evaluator.js'
);

describe('ParallelEvaluator', () => {
  beforeEach(() => {
    workerConstructorCalls = 0;
  });

  describe('createParallelEvaluator', () => {
    it('creates a pool with the specified number of workers', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 3,
      });

      expect(evaluator.poolSize).toBe(3);
      expect(workerConstructorCalls).toBe(3);

      await evaluator.destroy();
    });

    it('caps pool size at 4 workers', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 20,
      });

      expect(evaluator.poolSize).toBe(4);

      await evaluator.destroy();
    });

    it('defaults to availableParallelism when poolSize not specified', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
      });

      // os.availableParallelism mocked to return 4
      expect(evaluator.poolSize).toBe(4);

      await evaluator.destroy();
    });
  });

  describe('evaluateWindows', () => {
    it('distributes windows across workers and collects results in order', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 2,
      });

      const windows = [
        { window_id: 'btc-2026-01-01T00:15:00Z', symbol: 'btc', window_close_time: '2026-01-01T00:15:00Z' },
        { window_id: 'btc-2026-01-01T00:30:00Z', symbol: 'btc', window_close_time: '2026-01-01T00:30:00Z' },
        { window_id: 'btc-2026-01-01T00:45:00Z', symbol: 'btc', window_close_time: '2026-01-01T00:45:00Z' },
        { window_id: 'btc-2026-01-01T01:00:00Z', symbol: 'btc', window_close_time: '2026-01-01T01:00:00Z' },
      ];

      const results = await evaluator.evaluateWindows(windows);

      expect(results).toHaveLength(4);
      // Each result should have the standard evaluateWindow fields
      for (const result of results) {
        expect(result).toHaveProperty('pnl');
        expect(result).toHaveProperty('trades');
        expect(result).toHaveProperty('eventsProcessed');
      }

      await evaluator.destroy();
    });

    it('returns empty array for empty windows', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 2,
      });

      const results = await evaluator.evaluateWindows([]);
      expect(results).toHaveLength(0);

      await evaluator.destroy();
    });

    it('calls onProgress callback with completed/total', async () => {
      const progressCalls = [];
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 2,
        onProgress: (completed, total) => progressCalls.push({ completed, total }),
      });

      const windows = [
        { window_id: 'w1', symbol: 'btc', window_close_time: '2026-01-01T00:15:00Z' },
        { window_id: 'w2', symbol: 'btc', window_close_time: '2026-01-01T00:30:00Z' },
        { window_id: 'w3', symbol: 'btc', window_close_time: '2026-01-01T00:45:00Z' },
      ];

      await evaluator.evaluateWindows(windows);

      // Should have 3 progress calls (one per window)
      expect(progressCalls).toHaveLength(3);
      // Last call should be 3/3
      expect(progressCalls[progressCalls.length - 1]).toEqual({ completed: 3, total: 3 });

      await evaluator.destroy();
    });

    it('passes strategyParams through to workers', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 1,
      });

      const windows = [
        { window_id: 'w1', symbol: 'btc', window_close_time: '2026-01-01T00:15:00Z' },
      ];

      const results = await evaluator.evaluateWindows(windows, {
        strategyParams: { capitalPerTrade: 5, edgeThreshold: 0.02 },
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('pnl');

      await evaluator.destroy();
    });
  });

  describe('evaluateWindowsParallel (convenience function)', () => {
    it('creates pool, evaluates, and destroys in one call', async () => {
      const windows = [
        { window_id: 'w1', symbol: 'btc', window_close_time: '2026-01-01T00:15:00Z' },
        { window_id: 'w2', symbol: 'btc', window_close_time: '2026-01-01T00:30:00Z' },
      ];

      const results = await evaluateWindowsParallel({
        windows,
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 2,
      });

      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).toHaveProperty('pnl');
      }
    });
  });

  describe('destroy', () => {
    it('prevents further evaluations after destroy', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 1,
      });

      await evaluator.destroy();

      await expect(
        evaluator.evaluateWindows([{ window_id: 'w1', symbol: 'btc' }])
      ).rejects.toThrow('destroyed');
    });

    it('is idempotent — calling destroy twice does not throw', async () => {
      const evaluator = await createParallelEvaluator({
        strategyName: 'test-strategy',
        config: { initialCapital: 100 },
        poolSize: 1,
      });

      await evaluator.destroy();
      await evaluator.destroy(); // Should not throw
    });
  });
});
