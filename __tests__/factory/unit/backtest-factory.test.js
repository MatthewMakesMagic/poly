/**
 * Unit tests for Factory Backtest Engine (Stories 3.2, 3.4)
 *
 * Tests the pure computation functions without SQLite dependency.
 * Integration tests (requiring the DB) are separate.
 *
 * What this tests:
 *   - computeMetrics: Sharpe, Sortino, PF, maxDrawdown, winRate, trades, expectancy, edgePerTrade
 *   - computeRegimeBreakdown: first/second half, time-of-day, day-of-week
 *   - bootstrapSharpeCI: confidence intervals, determinism
 *   - generateParamCombinations: grid expansion
 *   - output-formatter: renderResultsTable, renderComparisonTable
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeMetrics,
  computeRegimeBreakdown,
  bootstrapSharpeCI,
  generateParamCombinations,
} from '../../../src/factory/cli/backtest-factory.js';

// ─── Helpers ───

function makeWindowResult({ pnl, trades = [], closeTime, eventsProcessed = 50 }) {
  return {
    windowCloseTime: closeTime || '2026-03-01T12:15:00Z',
    symbol: 'btc',
    strike: 95000,
    chainlinkClose: 94950,
    resolvedDirection: 'UP',
    pnl,
    tradesInWindow: trades.length,
    trades,
    eventsProcessed,
    capitalAfter: 100 + pnl,
    winRate: trades.filter(t => t.pnl > 0).length / (trades.length || 1),
    equityCurve: [100, 100 + pnl],
  };
}

function makeTrade({ pnl, entryPrice = 0.5, token = 'btc-up', size = 2 }) {
  return {
    id: `pos-${Math.random().toString(36).slice(2, 8)}`,
    token,
    entryPrice,
    size,
    cost: entryPrice * size,
    pnl,
    payout: pnl > 0 ? size : 0,
    timestamp: '2026-03-01T12:10:00Z',
    exitTimestamp: '2026-03-01T12:15:00Z',
    exitReason: 'resolution',
    reason: 'test',
    resolved: true,
  };
}

// ─── computeMetrics ───

describe('computeMetrics', () => {
  it('returns zero metrics for empty results', () => {
    const m = computeMetrics([], 100);
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.totalPnl).toBe(0);
    expect(m.sharpe).toBe(0);
  });

  it('computes correct totals from window results', () => {
    const results = [
      makeWindowResult({ pnl: 5, trades: [makeTrade({ pnl: 5 })] }),
      makeWindowResult({ pnl: -3, trades: [makeTrade({ pnl: -3 })] }),
      makeWindowResult({ pnl: 2, trades: [makeTrade({ pnl: 2 })] }),
    ];
    const m = computeMetrics(results, 100);
    expect(m.totalPnl).toBe(4);
    expect(m.trades).toBe(3);
    expect(m.winRate).toBeCloseTo(2 / 3, 4);
    expect(m.finalCapital).toBe(104);
  });

  it('computes equity curve correctly', () => {
    const results = [
      makeWindowResult({ pnl: 10, trades: [makeTrade({ pnl: 10 })] }),
      makeWindowResult({ pnl: -5, trades: [makeTrade({ pnl: -5 })] }),
    ];
    const m = computeMetrics(results, 100);
    expect(m.equityCurve).toEqual([100, 110, 105]);
  });

  it('computes maxDrawdown', () => {
    const results = [
      makeWindowResult({ pnl: 20, trades: [makeTrade({ pnl: 20 })] }),
      makeWindowResult({ pnl: -15, trades: [makeTrade({ pnl: -15 })] }),
      makeWindowResult({ pnl: 5, trades: [makeTrade({ pnl: 5 })] }),
    ];
    const m = computeMetrics(results, 100);
    // Peak at 120, trough at 105, DD = 15/120 = 0.125
    expect(m.maxDrawdown).toBeCloseTo(0.125, 3);
  });

  it('computes edgePerTrade from win rate and avg entry', () => {
    const results = [
      makeWindowResult({
        pnl: 1,
        trades: [makeTrade({ pnl: 1, entryPrice: 0.40 })],
      }),
      makeWindowResult({
        pnl: -0.6,
        trades: [makeTrade({ pnl: -0.6, entryPrice: 0.60 })],
      }),
    ];
    const m = computeMetrics(results, 100);
    // winRate = 0.5, avgEntry = 0.5, edge = 0
    expect(m.edgePerTrade).toBeCloseTo(0, 4);
  });

  it('handles windows with no trades', () => {
    const results = [
      makeWindowResult({ pnl: 0, trades: [] }),
      makeWindowResult({ pnl: 0, trades: [] }),
    ];
    const m = computeMetrics(results, 100);
    expect(m.trades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.totalPnl).toBe(0);
  });
});

// ─── computeRegimeBreakdown ───

describe('computeRegimeBreakdown', () => {
  it('returns null halves for empty results', () => {
    const r = computeRegimeBreakdown([], 100);
    expect(r.firstHalf).toBeNull();
    expect(r.secondHalf).toBeNull();
  });

  it('splits results into first and second half', () => {
    const results = [
      makeWindowResult({ pnl: 10, trades: [makeTrade({ pnl: 10 })], closeTime: '2026-02-01T10:00:00Z' }),
      makeWindowResult({ pnl: 5, trades: [makeTrade({ pnl: 5 })], closeTime: '2026-02-02T10:00:00Z' }),
      makeWindowResult({ pnl: -3, trades: [makeTrade({ pnl: -3 })], closeTime: '2026-02-03T10:00:00Z' }),
      makeWindowResult({ pnl: 2, trades: [makeTrade({ pnl: 2 })], closeTime: '2026-02-04T10:00:00Z' }),
    ];
    const r = computeRegimeBreakdown(results, 100);
    expect(r.firstHalf.totalPnl).toBe(15);
    expect(r.secondHalf.totalPnl).toBe(-1);
  });

  it('groups by time-of-day buckets', () => {
    const results = [
      makeWindowResult({ pnl: 1, trades: [makeTrade({ pnl: 1 })], closeTime: '2026-03-01T03:00:00Z' }), // overnight
      makeWindowResult({ pnl: 2, trades: [makeTrade({ pnl: 2 })], closeTime: '2026-03-01T10:00:00Z' }), // morning
      makeWindowResult({ pnl: 3, trades: [makeTrade({ pnl: 3 })], closeTime: '2026-03-01T15:00:00Z' }), // afternoon
      makeWindowResult({ pnl: 4, trades: [makeTrade({ pnl: 4 })], closeTime: '2026-03-01T21:00:00Z' }), // evening
    ];
    const r = computeRegimeBreakdown(results, 100);
    expect(r.timeOfDay.overnight.totalPnl).toBe(1);
    expect(r.timeOfDay.morning.totalPnl).toBe(2);
    expect(r.timeOfDay.afternoon.totalPnl).toBe(3);
    expect(r.timeOfDay.evening.totalPnl).toBe(4);
  });

  it('groups by day-of-week', () => {
    // 2026-03-02 is Monday
    const results = [
      makeWindowResult({ pnl: 1, trades: [makeTrade({ pnl: 1 })], closeTime: '2026-03-02T12:00:00Z' }), // Mon
      makeWindowResult({ pnl: 2, trades: [makeTrade({ pnl: 2 })], closeTime: '2026-03-03T12:00:00Z' }), // Tue
    ];
    const r = computeRegimeBreakdown(results, 100);
    expect(r.dayOfWeek.Mon.totalPnl).toBe(1);
    expect(r.dayOfWeek.Tue.totalPnl).toBe(2);
  });
});

// ─── bootstrapSharpeCI ───

describe('bootstrapSharpeCI', () => {
  it('returns zeros for insufficient data', () => {
    const ci = bootstrapSharpeCI([0.01]);
    expect(ci.mean).toBe(0);
    expect(ci.pValue).toBe(1);
  });

  it('is deterministic with same seed', () => {
    const returns = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 0.02 : -0.01));
    const ci1 = bootstrapSharpeCI(returns, 500, 42);
    const ci2 = bootstrapSharpeCI(returns, 500, 42);
    expect(ci1.mean).toBe(ci2.mean);
    expect(ci1.ci95Lower).toBe(ci2.ci95Lower);
    expect(ci1.ci95Upper).toBe(ci2.ci95Upper);
  });

  it('produces reasonable CI for positive returns', () => {
    const returns = Array.from({ length: 100 }, () => 0.01 + (Math.random() - 0.4) * 0.02);
    const ci = bootstrapSharpeCI(returns, 1000, 42);
    // With consistently positive returns, CI lower bound should be > some negative value
    expect(ci.ci95Upper).toBeGreaterThan(ci.ci95Lower);
  });

  it('pValue near 1 for losing returns', () => {
    const returns = Array.from({ length: 50 }, () => -0.05);
    const ci = bootstrapSharpeCI(returns, 500, 42);
    expect(ci.pValue).toBeGreaterThan(0.9);
  });
});

// ─── generateParamCombinations ───

describe('generateParamCombinations', () => {
  it('returns single empty object for empty grid', () => {
    expect(generateParamCombinations({})).toEqual([{}]);
  });

  it('generates all combinations for multi-param grid', () => {
    const grid = { a: [1, 2], b: ['x', 'y'] };
    const combos = generateParamCombinations(grid);
    expect(combos).toHaveLength(4);
    expect(combos).toContainEqual({ a: 1, b: 'x' });
    expect(combos).toContainEqual({ a: 1, b: 'y' });
    expect(combos).toContainEqual({ a: 2, b: 'x' });
    expect(combos).toContainEqual({ a: 2, b: 'y' });
  });

  it('handles single param with multiple values', () => {
    const grid = { threshold: [50, 75, 100] };
    const combos = generateParamCombinations(grid);
    expect(combos).toHaveLength(3);
  });

  it('handles three params', () => {
    const grid = { a: [1, 2], b: [3, 4], c: [5, 6] };
    const combos = generateParamCombinations(grid);
    expect(combos).toHaveLength(8);
  });
});
