/**
 * Tests for metrics module
 */

import { describe, it, expect } from 'vitest';
import {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMaxDrawdown,
  calculateProfitFactor,
  calculateExpectancy,
  calculateMetrics,
  calculateSubsetMetrics,
} from '../metrics.js';

describe('metrics', () => {
  describe('calculateSharpeRatio', () => {
    it('returns 0 for empty returns', () => {
      expect(calculateSharpeRatio([])).toBe(0);
      expect(calculateSharpeRatio(null)).toBe(0);
    });

    it('returns 0 for single return', () => {
      expect(calculateSharpeRatio([0.01])).toBe(0);
    });

    it('calculates Sharpe for consistent positive returns', () => {
      const returns = Array(100).fill(0.001); // 0.1% daily return
      const sharpe = calculateSharpeRatio(returns);
      expect(sharpe).toBeGreaterThan(0);
    });

    it('calculates negative Sharpe for losses', () => {
      const returns = Array(100).fill(-0.001); // -0.1% daily return
      const sharpe = calculateSharpeRatio(returns);
      expect(sharpe).toBeLessThan(0);
    });

    it('returns 0 for zero variance', () => {
      const returns = [0, 0, 0, 0];
      expect(calculateSharpeRatio(returns)).toBe(0);
    });
  });

  describe('calculateSortinoRatio', () => {
    it('returns 0 for empty returns', () => {
      expect(calculateSortinoRatio([])).toBe(0);
    });

    it('handles all positive returns', () => {
      const returns = Array(100).fill(0.01);
      const sortino = calculateSortinoRatio(returns);
      expect(sortino).toBe(Infinity);
    });

    it('calculates Sortino with mixed returns', () => {
      const returns = [0.02, -0.01, 0.03, -0.02, 0.01];
      const sortino = calculateSortinoRatio(returns);
      expect(sortino).toBeGreaterThan(0);
    });
  });

  describe('calculateMaxDrawdown', () => {
    it('returns 0 for empty equity curve', () => {
      const result = calculateMaxDrawdown([]);
      expect(result.maxDrawdownPct).toBe(0);
    });

    it('returns 0 for monotonically increasing curve', () => {
      const curve = [100, 110, 120, 130, 140];
      const result = calculateMaxDrawdown(curve);
      expect(result.maxDrawdownPct).toBe(0);
    });

    it('calculates drawdown for simple decline', () => {
      const curve = [100, 110, 90, 95, 100];
      const result = calculateMaxDrawdown(curve);
      // Peak was 110, trough was 90, drawdown = 20/110 = 18.18%
      expect(result.maxDrawdownPct).toBeCloseTo(0.1818, 2);
    });

    it('calculates correct drawdown duration', () => {
      const curve = [100, 110, 100, 95, 90, 95, 100, 110];
      const result = calculateMaxDrawdown(curve);
      expect(result.drawdownDuration).toBeGreaterThan(0);
    });
  });

  describe('calculateProfitFactor', () => {
    it('returns 0 for empty trades', () => {
      expect(calculateProfitFactor([])).toBe(0);
    });

    it('returns Infinity for all wins', () => {
      const trades = [{ pnl: 10 }, { pnl: 20 }, { pnl: 5 }];
      expect(calculateProfitFactor(trades)).toBe(Infinity);
    });

    it('returns 0 for all losses', () => {
      const trades = [{ pnl: -10 }, { pnl: -20 }];
      expect(calculateProfitFactor(trades)).toBe(0);
    });

    it('calculates correct ratio', () => {
      const trades = [
        { pnl: 100 },
        { pnl: 50 },
        { pnl: -50 },
        { pnl: -25 },
      ];
      // Gross profit = 150, gross loss = 75
      expect(calculateProfitFactor(trades)).toBe(2);
    });
  });

  describe('calculateExpectancy', () => {
    it('returns 0 for empty trades', () => {
      expect(calculateExpectancy([])).toBe(0);
    });

    it('calculates positive expectancy', () => {
      // 2 wins at $100 each, 1 loss at $50
      // Win rate = 66.7%, Avg win = $100, Avg loss = $50
      // Expectancy = 0.667 * 100 - 0.333 * 50 = 66.7 - 16.65 = 50.05
      const trades = [
        { pnl: 100 },
        { pnl: 100 },
        { pnl: -50 },
      ];
      const expectancy = calculateExpectancy(trades);
      expect(expectancy).toBeGreaterThan(0);
    });

    it('calculates negative expectancy', () => {
      // 1 win at $10, 2 losses at $50 each
      const trades = [
        { pnl: 10 },
        { pnl: -50 },
        { pnl: -50 },
      ];
      const expectancy = calculateExpectancy(trades);
      expect(expectancy).toBeLessThan(0);
    });
  });

  describe('calculateMetrics', () => {
    it('handles empty trades', () => {
      const backtest = {
        trades: [],
        equityCurve: [1000],
        summary: { returnPct: 0 },
        config: { startDate: '2026-01-01', endDate: '2026-01-02' },
      };

      const metrics = calculateMetrics(backtest);
      expect(metrics.totalReturn).toBe(0);
      expect(metrics.winRate).toBe(0);
    });

    it('calculates all metrics for valid backtest', () => {
      const backtest = {
        trades: [
          { pnl: 10 },
          { pnl: -5 },
          { pnl: 15 },
          { pnl: -3 },
        ],
        equityCurve: [1000, 1010, 1005, 1020, 1017],
        summary: { returnPct: 0.017 },
        config: { startDate: '2026-01-01', endDate: '2026-01-08' },
      };

      const metrics = calculateMetrics(backtest);

      expect(metrics.totalReturn).toBe(0.017);
      expect(metrics.winRate).toBe(0.5);
      expect(metrics.profitFactor).toBeGreaterThan(0);
      expect(metrics.expectancy).toBeGreaterThan(0);
    });
  });

  describe('calculateSubsetMetrics', () => {
    it('handles empty subset', () => {
      const metrics = calculateSubsetMetrics([]);
      expect(metrics.tradeCount).toBe(0);
      expect(metrics.winRate).toBe(0);
    });

    it('calculates metrics for subset', () => {
      const trades = [
        { pnl: 100 },
        { pnl: -50 },
        { pnl: 75 },
      ];

      const metrics = calculateSubsetMetrics(trades, 1000);

      expect(metrics.tradeCount).toBe(3);
      expect(metrics.winRate).toBeCloseTo(0.667, 2);
      expect(metrics.totalPnl).toBe(125);
      expect(metrics.returnPct).toBe(0.125);
    });
  });
});
