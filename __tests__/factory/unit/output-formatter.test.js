/**
 * Unit tests for Output Formatter (Story 3.4)
 *
 * Tests CLI table rendering and comparison table.
 *
 * What this tests:
 *   - renderResultsTable outputs correct format
 *   - renderComparisonTable shows cross-symbol comparison
 *   - Unequal sample sizes flagged
 *   - Output completes quickly (NFR6)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderResultsTable, renderComparisonTable } from '../../../src/factory/cli/output-formatter.js';

function makeResult(overrides = {}) {
  return {
    strategy: 'test-strategy',
    symbol: 'btc',
    sampleSize: 100,
    totalWindows: 500,
    wallClockMs: 250,
    variants: [
      {
        params: { threshold: 50 },
        metrics: {
          sharpe: 1.5,
          sortino: 2.0,
          profitFactor: 1.8,
          maxDrawdown: 0.05,
          winRate: 0.65,
          trades: 80,
          expectancy: 0.02,
          edgePerTrade: 0.05,
          totalPnl: 15.5,
          finalCapital: 115.5,
        },
        sharpeCi: { mean: 1.5, ci95Lower: 0.8, ci95Upper: 2.2, pValue: 0.01 },
        windowCount: 100,
      },
    ],
    baseline: {
      sharpe: 0.1,
      sortino: 0.05,
      profitFactor: 0.9,
      maxDrawdown: 0.1,
      winRate: 0.48,
      trades: 50,
      expectancy: -0.01,
      edgePerTrade: -0.02,
      totalPnl: -2.5,
    },
    paramImportance: null,
    ...overrides,
  };
}

describe('renderResultsTable', () => {
  let output;

  beforeEach(() => {
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.join(' '));
    });
  });

  it('renders strategy name and symbol', () => {
    renderResultsTable(makeResult());
    const joined = output.join('\n');
    expect(joined).toContain('test-strategy');
    expect(joined).toContain('BTC');
  });

  it('renders variant metrics', () => {
    renderResultsTable(makeResult());
    const joined = output.join('\n');
    expect(joined).toContain('1.5');  // Sharpe
    expect(joined).toContain('1.8');  // PF
    expect(joined).toContain('65');   // WinRate
    expect(joined).toContain('80');   // Trades
  });

  it('renders baseline row', () => {
    renderResultsTable(makeResult());
    const joined = output.join('\n');
    expect(joined).toContain('baseline-random');
  });

  it('renders without baseline when null', () => {
    renderResultsTable(makeResult({ baseline: null }));
    const joined = output.join('\n');
    expect(joined).not.toContain('baseline-random');
  });

  it('renders parameter importance when available', () => {
    const result = makeResult({
      paramImportance: {
        threshold: { '50': { avgSharpe: 1.5, count: 2 }, '75': { avgSharpe: 1.0, count: 2 } },
      },
    });
    renderResultsTable(result);
    const joined = output.join('\n');
    expect(joined).toContain('Parameter Importance');
    expect(joined).toContain('threshold');
  });

  it('handles empty variants', () => {
    renderResultsTable(makeResult({ variants: [] }));
    const joined = output.join('\n');
    expect(joined).toContain('No results');
  });

  it('renders confidence intervals', () => {
    renderResultsTable(makeResult());
    const joined = output.join('\n');
    expect(joined).toContain('0.8');
    expect(joined).toContain('2.2');
  });

  it('completes in under 100ms (NFR6)', () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      renderResultsTable(makeResult());
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // 100 renders in <1s
  });
});

describe('renderComparisonTable', () => {
  let output;

  beforeEach(() => {
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.join(' '));
    });
  });

  it('renders cross-symbol comparison', () => {
    const results = [
      makeResult({ symbol: 'btc', sampleSize: 100 }),
      makeResult({ symbol: 'eth', sampleSize: 100 }),
    ];
    renderComparisonTable(results);
    const joined = output.join('\n');
    expect(joined).toContain('BTC');
    expect(joined).toContain('ETH');
    expect(joined).toContain('CROSS-SYMBOL');
  });

  it('flags unequal sample sizes', () => {
    const results = [
      makeResult({ symbol: 'btc', sampleSize: 200 }),
      makeResult({ symbol: 'eth', sampleSize: 150 }),
    ];
    renderComparisonTable(results);
    const joined = output.join('\n');
    expect(joined).toContain('WARNING');
    expect(joined).toContain('Unequal sample sizes');
  });

  it('does not warn when sample sizes are equal', () => {
    const results = [
      makeResult({ symbol: 'btc', sampleSize: 200 }),
      makeResult({ symbol: 'eth', sampleSize: 200 }),
    ];
    renderComparisonTable(results);
    const joined = output.join('\n');
    expect(joined).not.toContain('WARNING');
  });
});
