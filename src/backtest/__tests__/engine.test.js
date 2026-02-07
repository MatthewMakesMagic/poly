/**
 * Tests for backtest engine (window-aware async replay)
 *
 * Mocks data-loader to provide test data directly.
 */

import { describe, it, expect, vi } from 'vitest';

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

// --- Test data ---
const testTimeline = [
  // polyRef event
  { timestamp: '2026-01-25T12:27:00Z', source: 'polyRef', topic: 'crypto_prices', symbol: 'BTC', price: 50100 },
  // chainlink event
  { timestamp: '2026-01-25T12:27:01Z', source: 'chainlink', topic: 'crypto_prices_chainlink', symbol: 'BTC', price: 50020 },
  // CLOB UP event
  { timestamp: '2026-01-25T12:28:00Z', source: 'clobUp', symbol: 'BTC', token_id: 'btc_up', best_bid: 0.48, best_ask: 0.50, mid_price: 0.49, spread: 0.02, bid_size_top: 100, ask_size_top: 100 },
  // CLOB DOWN event
  { timestamp: '2026-01-25T12:28:00Z', source: 'clobDown', symbol: 'BTC', token_id: 'btc_down', best_bid: 0.50, best_ask: 0.52, mid_price: 0.51, spread: 0.02, bid_size_top: 100, ask_size_top: 100 },
  // Exchange event
  { timestamp: '2026-01-25T12:29:00Z', source: 'exchange_binance', exchange: 'binance', symbol: 'BTC', price: 50110, bid: 50105, ask: 50115 },
  // Another polyRef near window close
  { timestamp: '2026-01-25T12:29:30Z', source: 'polyRef', topic: 'crypto_prices', symbol: 'BTC', price: 50090 },
];

const testWindows = [
  {
    window_close_time: '2026-01-25T12:30:00Z',
    symbol: 'BTC',
    strike_price: 50100,
    chainlink_price_at_close: 50020,
    resolved_direction: 'DOWN',
  },
];

// Mock data-loader
vi.mock('../data-loader.js', () => ({
  loadMergedTimeline: vi.fn(async () => testTimeline),
  loadWindowEvents: vi.fn(async () => testWindows),
}));

import { runBacktest, runSweep } from '../engine.js';

describe('backtest engine', () => {
  describe('runBacktest', () => {
    it('requires startDate and endDate', async () => {
      await expect(runBacktest({
        strategy: { name: 'test', evaluate: () => [] },
      })).rejects.toThrow('startDate and endDate are required');
    });

    it('requires strategy with evaluate function', async () => {
      await expect(runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      })).rejects.toThrow('strategy must have an evaluate function');
    });

    it('runs backtest with no-op strategy', async () => {
      const result = await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy: { name: 'noop', evaluate: () => [] },
      });

      expect(result).toBeDefined();
      expect(result.config.strategyName).toBe('noop');
      expect(result.summary.eventsProcessed).toBe(testTimeline.length);
      expect(result.summary.totalTrades).toBe(0);
      expect(result.windowResults).toHaveLength(1);
      expect(result.windowResults[0].resolvedDirection).toBe('DOWN');
    });

    it('executes buy signals and resolves at window close', async () => {
      let signalFired = false;

      const strategy = {
        name: 'always-buy-down',
        evaluate: (state) => {
          // Only fire once when we have CLOB data
          if (!signalFired && state.clobDown) {
            signalFired = true;
            return [{
              action: 'buy',
              token: 'btc_down',
              size: 1,
              reason: 'test_signal',
            }];
          }
          return [];
        },
      };

      const result = await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy,
        spreadBuffer: 0,
      });

      // Should have 1 trade resolved at window close
      expect(result.summary.totalTrades).toBe(1);
      const trade = result.trades[0];
      expect(trade.token).toBe('btc_down');
      expect(trade.exitReason).toBe('resolution');
      // DOWN wins because resolved_direction is DOWN
      expect(trade.pnl).toBeGreaterThan(0);
    });

    it('calls onWindowOpen and onWindowClose hooks', async () => {
      const openCalls = [];
      const closeCalls = [];

      const strategy = {
        name: 'hook-test',
        evaluate: () => [],
        onWindowOpen: (state, config) => {
          openCalls.push({ strike: state.strike, closeTime: state.window?.closeTime });
        },
        onWindowClose: (state, windowResult, config) => {
          closeCalls.push({ direction: windowResult.resolvedDirection });
        },
      };

      await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy,
      });

      expect(openCalls).toHaveLength(1);
      expect(openCalls[0].strike).toBe(50100);
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0].direction).toBe('DOWN');
    });

    it('includes decision log when verbose', async () => {
      let fired = false;
      const strategy = {
        name: 'verbose-test',
        evaluate: (state) => {
          if (!fired && state.clobDown) {
            fired = true;
            return [{ action: 'buy', token: 'btc_down', size: 1, reason: 'test' }];
          }
          return [];
        },
      };

      const result = await runBacktest({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        strategy,
        verbose: true,
        spreadBuffer: 0,
      });

      expect(result.decisionLog).toBeDefined();
      expect(result.decisionLog.length).toBeGreaterThan(0);
      expect(result.decisionLog[0].signal).toBeDefined();
      expect(result.decisionLog[0].execution).toBeDefined();
      expect(result.decisionLog[0].stateSnapshot).toBeDefined();
    });
  });

  describe('runSweep', () => {
    it('runs multiple param sets', async () => {
      const strategy = {
        name: 'sweep-test',
        evaluate: () => [],
      };

      const results = await runSweep(
        {
          startDate: '2026-01-25T00:00:00Z',
          endDate: '2026-01-26T00:00:00Z',
          strategy,
        },
        { threshold: [50, 80, 100] },
      );

      expect(results).toHaveLength(3);
      expect(results[0].params.threshold).toBe(50);
      expect(results[1].params.threshold).toBe(80);
      expect(results[2].params.threshold).toBe(100);
      // Each should have a result
      results.forEach(r => {
        expect(r.result.summary).toBeDefined();
      });
    });

    it('generates cartesian product of params', async () => {
      const strategy = {
        name: 'sweep-cartesian',
        evaluate: () => [],
      };

      const results = await runSweep(
        {
          startDate: '2026-01-25T00:00:00Z',
          endDate: '2026-01-26T00:00:00Z',
          strategy,
        },
        { a: [1, 2], b: [10, 20] },
      );

      expect(results).toHaveLength(4); // 2 * 2
    });
  });
});
