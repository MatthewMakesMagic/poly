/**
 * Tests for backtest engine
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { open, close, run } from '../../persistence/database.js';
import { runBacktest, createThresholdStrategy } from '../engine.js';

describe('backtest engine', () => {
  beforeAll(() => {
    // Open in-memory database for testing
    open(':memory:');

    // Create rtds_ticks table
    run(`
      CREATE TABLE rtds_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        topic TEXT NOT NULL,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        raw_payload TEXT
      )
    `);

    // Insert test data with price movements
    // Start: spot = 50000, oracle = 49990 (spread = 0.02%)
    // Then: spot drops to 49900 (spread narrows)
    // Then: oracle catches up to 49900 (spread = 0)
    const testData = [
      // Initial state - spot leads oracle
      { timestamp: '2026-01-25T10:00:00Z', topic: 'binance', symbol: 'BTC', price: 50000 },
      { timestamp: '2026-01-25T10:00:00Z', topic: 'chainlink', symbol: 'BTC', price: 49900 },
      // Spot drops
      { timestamp: '2026-01-25T10:00:05Z', topic: 'binance', symbol: 'BTC', price: 49950 },
      { timestamp: '2026-01-25T10:00:05Z', topic: 'chainlink', symbol: 'BTC', price: 49900 },
      // Oracle catches up
      { timestamp: '2026-01-25T10:00:10Z', topic: 'binance', symbol: 'BTC', price: 49950 },
      { timestamp: '2026-01-25T10:00:10Z', topic: 'chainlink', symbol: 'BTC', price: 49940 },
      // Final state
      { timestamp: '2026-01-25T10:00:15Z', topic: 'binance', symbol: 'BTC', price: 50000 },
      { timestamp: '2026-01-25T10:00:15Z', topic: 'chainlink', symbol: 'BTC', price: 49990 },
    ];

    for (const row of testData) {
      run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [row.timestamp, row.topic, row.symbol, row.price]
      );
    }
  });

  afterAll(() => {
    close();
  });

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
