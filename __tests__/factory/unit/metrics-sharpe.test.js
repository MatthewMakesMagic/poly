/**
 * Unit tests for Sharpe ratio fix (raw vs annualized).
 *
 * Verifies:
 *   - calculateSharpeRatio defaults to raw (periodsPerYear=1), NOT sqrt(252)
 *   - Raw Sharpe = mean/stddev with no annualization scaling
 *   - Annualized Sharpe = raw * sqrt(periodsPerYear) when periodsPerYear > 1
 *   - calculateMetrics returns both sharpeRatio (raw) and sharpeAnnualized
 *   - Raw Sharpe is strictly lower than the old sqrt(252)-annualized value
 */

import { describe, it, expect } from 'vitest';
import {
  calculateSharpeRatio,
  calculateSortinoRatio,
  calculateMetrics,
} from '../../../src/backtest/metrics.js';

describe('calculateSharpeRatio', () => {
  // Known returns: mean = 0.01, stddev = 0.02
  const returns = [0.03, -0.01, 0.01, 0.02, -0.01, 0.03, 0.01, -0.01, 0.02, 0.01];

  it('defaults to raw (unannualized) Sharpe — no sqrt(252) scaling', () => {
    const raw = calculateSharpeRatio(returns);
    // With periodsPerYear=1 the formula is: mean / stddev * sqrt(1) = mean / stddev
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stddev = Math.sqrt(variance);
    const expected = mean / stddev;
    expect(raw).toBeCloseTo(expected, 10);
  });

  it('raw Sharpe is strictly lower than old sqrt(252)-annualized value', () => {
    const raw = calculateSharpeRatio(returns, 0, 1);
    const oldAnnualized = calculateSharpeRatio(returns, 0, 252);
    expect(raw).toBeLessThan(oldAnnualized);
    // The ratio should be sqrt(252)
    expect(oldAnnualized / raw).toBeCloseTo(Math.sqrt(252), 6);
  });

  it('annualized Sharpe = raw * sqrt(periodsPerYear)', () => {
    const raw = calculateSharpeRatio(returns, 0, 1);
    const annualized35040 = calculateSharpeRatio(returns, 0, 35040);
    expect(annualized35040).toBeCloseTo(raw * Math.sqrt(35040), 6);
  });

  it('returns 0 for fewer than 2 observations', () => {
    expect(calculateSharpeRatio([])).toBe(0);
    expect(calculateSharpeRatio([0.01])).toBe(0);
    expect(calculateSharpeRatio(null)).toBe(0);
  });

  it('returns 0 when all returns are identical (zero stddev)', () => {
    expect(calculateSharpeRatio([0.01, 0.01, 0.01])).toBe(0);
  });
});

describe('calculateSortinoRatio', () => {
  it('defaults to raw (unannualized) Sortino', () => {
    const returns = [0.02, -0.01, 0.03, -0.02, 0.01];
    const raw = calculateSortinoRatio(returns);
    const annualized252 = calculateSortinoRatio(returns, 0, 252);
    // Raw should be sqrt(252)x smaller
    expect(annualized252 / raw).toBeCloseTo(Math.sqrt(252), 6);
  });
});

describe('calculateMetrics', () => {
  function makeBacktest(equityCurve, startDate, endDate) {
    const trades = [];
    for (let i = 1; i < equityCurve.length; i++) {
      trades.push({ pnl: equityCurve[i] - equityCurve[i - 1] });
    }
    return {
      trades,
      equityCurve,
      summary: { returnPct: (equityCurve[equityCurve.length - 1] - equityCurve[0]) / equityCurve[0] },
      config: { startDate, endDate },
    };
  }

  it('returns both sharpeRatio (raw) and sharpeAnnualized fields', () => {
    // 100 data points over ~25 days (every 6 hours)
    const curve = [1000];
    for (let i = 1; i <= 100; i++) {
      curve.push(curve[i - 1] + (i % 3 === 0 ? -2 : 3));
    }
    const bt = makeBacktest(curve, '2026-01-01', '2026-01-26');
    const m = calculateMetrics(bt);

    expect(m).toHaveProperty('sharpeRatio');
    expect(m).toHaveProperty('sharpeAnnualized');
    expect(m).toHaveProperty('sharpeNote');
    expect(m).toHaveProperty('sortinoAnnualized');

    // Raw Sharpe should be unannualized (positive since net PnL is positive)
    expect(m.sharpeRatio).toBeGreaterThan(0);

    // Annualized should be raw * sqrt(tradesPerYear) — larger in magnitude
    expect(Math.abs(m.sharpeAnnualized)).toBeGreaterThan(Math.abs(m.sharpeRatio));

    // Verify the relationship: annualized = raw * sqrt(returns.length / yearsInPeriod)
    const yearsInPeriod = 25 / 365;
    const tradesPerYear = 100 / yearsInPeriod;
    expect(m.sharpeAnnualized).toBeCloseTo(m.sharpeRatio * Math.sqrt(tradesPerYear), 4);
  });

  it('returns zero metrics for empty trades', () => {
    const m = calculateMetrics({
      trades: [],
      equityCurve: [1000],
      summary: {},
      config: { startDate: '2026-01-01', endDate: '2026-01-02' },
    });
    expect(m.sharpeRatio).toBe(0);
    expect(m.sharpeAnnualized).toBeUndefined(); // empty path does not compute annualized
  });
});
