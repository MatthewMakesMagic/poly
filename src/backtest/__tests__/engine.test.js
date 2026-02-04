/**
 * Tests for backtest engine
 *
 * V3: persistence/database.js now uses PostgreSQL (async).
 * The data-loader and engine use getDb()/prepare()/all() which are SQLite-only.
 * We mock the data-loader to provide test data directly.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// --- Test tick data ---
const testTicks = [
  { id: 1, timestamp: '2026-01-25T10:00:00Z', topic: 'binance', symbol: 'BTC', price: 50000, raw_payload: null },
  { id: 2, timestamp: '2026-01-25T10:00:00Z', topic: 'chainlink', symbol: 'BTC', price: 49900, raw_payload: null },
  { id: 3, timestamp: '2026-01-25T10:00:05Z', topic: 'binance', symbol: 'BTC', price: 49950, raw_payload: null },
  { id: 4, timestamp: '2026-01-25T10:00:05Z', topic: 'chainlink', symbol: 'BTC', price: 49900, raw_payload: null },
  { id: 5, timestamp: '2026-01-25T10:00:10Z', topic: 'binance', symbol: 'BTC', price: 49950, raw_payload: null },
  { id: 6, timestamp: '2026-01-25T10:00:10Z', topic: 'chainlink', symbol: 'BTC', price: 49940, raw_payload: null },
  { id: 7, timestamp: '2026-01-25T10:00:15Z', topic: 'binance', symbol: 'BTC', price: 50000, raw_payload: null },
  { id: 8, timestamp: '2026-01-25T10:00:15Z', topic: 'chainlink', symbol: 'BTC', price: 49990, raw_payload: null },
];

// Mock logger
vi.mock('../../modules/logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  init: vi.fn(),
  shutdown: vi.fn(),
}));

// Mock the data-loader to provide test data without database
vi.mock('../data-loader.js', () => ({
  loadTicksBatched: function* (options) {
    const { startDate, endDate, symbols } = options;
    // Filter ticks by date range and optional symbols
    let filtered = testTicks.filter(t =>
      t.timestamp >= startDate && t.timestamp <= endDate
    );
    if (symbols && symbols.length > 0) {
      filtered = filtered.filter(t => symbols.includes(t.symbol));
    }
    if (filtered.length > 0) {
      yield filtered;
    }
  },
  getTickCount: (options) => {
    const { startDate, endDate, symbols } = options;
    let filtered = testTicks.filter(t =>
      t.timestamp >= startDate && t.timestamp <= endDate
    );
    if (symbols && symbols.length > 0) {
      filtered = filtered.filter(t => symbols.includes(t.symbol));
    }
    return filtered.length;
  },
}));

import { runBacktest, createThresholdStrategy } from '../engine.js';

describe('backtest engine', () => {
  describe('runBacktest', () => {
    it('requires startDate and endDate', async () => {
      await expect(runBacktest({ strategy: () => ({}) })).rejects.toThrow('startDate and endDate are required');
    });

    it('requires strategy function', async () => {
      await expect(runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      })).rejects.toThrow('strategy must be a function');
    });

    it('runs backtest with simple strategy', async () => {
      const result = await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy: () => ({ action: null }),
      });

      expect(result).toBeDefined();
      expect(result.config).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.summary.ticksProcessed).toBe(8);
      expect(result.trades).toEqual([]);
    });

    it('executes trades with threshold strategy', async () => {
      // Use very small threshold so trades happen
      const strategy = createThresholdStrategy({
        entryThreshold: 0.0001,
        exitThreshold: 0,
        stopLossPct: 0.1,
        takeProfitPct: 0.01,
      });

      const result = await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy,
      });

      expect(result.summary.totalTrades).toBeGreaterThanOrEqual(0);
      expect(result.equityCurve).toBeDefined();
      expect(result.equityCurve.length).toBeGreaterThan(0);
    });

    it('calls progress callback', async () => {
      let progressCalls = 0;
      let lastProcessed = 0;

      await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy: () => ({ action: null }),
        progressIntervalTicks: 1,
        onProgress: (processed, total) => {
          progressCalls++;
          lastProcessed = processed;
          expect(total).toBe(8);
        },
      });

      expect(progressCalls).toBeGreaterThan(0);
      expect(lastProcessed).toBe(8);
    });

    it('filters by symbols', async () => {
      const result = await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        symbols: ['ETH'], // No ETH data, so no ticks
        strategy: () => ({ action: null }),
      });

      expect(result.summary.ticksProcessed).toBe(0);
    });
  });

  describe('createThresholdStrategy', () => {
    it('creates a strategy function', () => {
      const strategy = createThresholdStrategy();
      expect(typeof strategy).toBe('function');
    });

    it('returns null action when spread is within threshold', () => {
      const strategy = createThresholdStrategy({ entryThreshold: 0.01 });

      const context = {
        market: { spreadPct: 0.001 },
        position: { isOpen: false },
      };

      const decision = strategy(context);
      expect(decision.action).toBeNull();
    });

    it('returns enter action when spread exceeds threshold', () => {
      const strategy = createThresholdStrategy({ entryThreshold: 0.001 });

      const context = {
        market: { spreadPct: 0.002 },
        position: { isOpen: false },
      };

      const decision = strategy(context);
      expect(decision.action).toBe('enter');
      expect(decision.direction).toBe('short');
    });

    it('returns exit action on stop loss', () => {
      const strategy = createThresholdStrategy({ stopLossPct: 0.05 });

      const context = {
        market: { spreadPct: 0.001 },
        position: {
          isOpen: true,
          direction: 'long',
          entryPrice: 100,
          size: 1,
          unrealizedPnl: -10, // -10% loss
        },
      };

      const decision = strategy(context);
      expect(decision.action).toBe('exit');
      expect(decision.reason).toBe('stop_loss');
    });
  });
});
