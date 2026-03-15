/**
 * Unit tests for CrossSymbolChart component.
 * Validates warning banner logic, low-sample visual differentiation,
 * and correct rendering with fixture data.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import CrossSymbolChart, { hasSampleSizeWarning } from '../../../components/factory/CrossSymbolChart.jsx';
import results from '../fixtures/factory-results.json';

// oracle-edge-adaptive-v2 has results across BTC (224 trades), ETH (210), SOL (35), XRP (28)
// This triggers: sample size warning (224 vs 28 = >2x) and low-sample flags for SOL/XRP
const oracleV2Results = results.filter(r => r.strategy_name === 'oracle-edge-adaptive-v2');

// deficit-asymmetry-v1 has BTC (142), ETH (138), SOL (38), XRP (25)
const deficitV1Results = results.filter(r => r.strategy_name === 'deficit-asymmetry-v1');

// Single-symbol results should show no cross-symbol content
const singleSymbolResults = results.filter(r => r.strategy_name === 'momentum-reversion-v2');

describe('hasSampleSizeWarning', () => {
  it('returns false for empty or single-symbol data', () => {
    expect(hasSampleSizeWarning([])).toBe(false);
    expect(hasSampleSizeWarning(null)).toBe(false);
    expect(hasSampleSizeWarning([{ symbol: 'BTC', trades: 100 }])).toBe(false);
  });

  it('returns true when max trades > 2x min trades', () => {
    const data = [
      { symbol: 'BTC', trades: 200 },
      { symbol: 'SOL', trades: 50 },
    ];
    expect(hasSampleSizeWarning(data)).toBe(true);
  });

  it('returns false when trades are within 2x range', () => {
    const data = [
      { symbol: 'BTC', trades: 150 },
      { symbol: 'ETH', trades: 130 },
    ];
    expect(hasSampleSizeWarning(data)).toBe(false);
  });

  it('returns true for oracle-v2 fixture data (224 vs 28 trades)', () => {
    // The component internally maps results to symbolData, so test the raw utility
    const mapped = oracleV2Results.map(r => ({
      symbol: r.symbol.toUpperCase(),
      trades: r.metrics.trades,
    }));
    expect(hasSampleSizeWarning(mapped)).toBe(true);
  });
});

describe('CrossSymbolChart', () => {
  it('renders "No cross-symbol data" when results are empty', () => {
    render(<CrossSymbolChart results={[]} />);
    expect(screen.getByText('No cross-symbol data available')).toBeTruthy();
  });

  it('renders the heading "Cross-Symbol Comparison"', () => {
    render(<CrossSymbolChart results={oracleV2Results} strategyName="oracle-edge-adaptive-v2" />);
    expect(screen.getByText('Cross-Symbol Comparison')).toBeTruthy();
  });

  it('displays strategy name when provided', () => {
    render(<CrossSymbolChart results={oracleV2Results} strategyName="oracle-edge-adaptive-v2" />);
    expect(screen.getByText('oracle-edge-adaptive-v2')).toBeTruthy();
  });

  it('shows sample size warning when trades differ by >2x', () => {
    render(<CrossSymbolChart results={oracleV2Results} />);
    expect(screen.getByText(/Sample sizes vary significantly/)).toBeTruthy();
  });

  it('shows "low sample" label for symbols with <50 trades', () => {
    render(<CrossSymbolChart results={oracleV2Results} />);
    // SOL has 35 trades and XRP has 28 — both should get low sample markers
    const lowSampleLabels = screen.getAllByText('low sample');
    expect(lowSampleLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('renders chart sections for Sharpe, Win Rate, and Profit Factor', () => {
    render(<CrossSymbolChart results={oracleV2Results} />);
    expect(screen.getByText('Sharpe Ratio')).toBeTruthy();
    expect(screen.getByText('Win Rate')).toBeTruthy();
    expect(screen.getByText('Profit Factor')).toBeTruthy();
  });

  it('renders Recharts containers for the charts', () => {
    const { container } = render(<CrossSymbolChart results={oracleV2Results} />);
    // ResponsiveContainer renders as .recharts-responsive-container in jsdom
    const wrappers = container.querySelectorAll('.recharts-responsive-container');
    // Should have 3 chart containers: Sharpe, Win Rate, Profit Factor
    expect(wrappers.length).toBe(3);
  });

  it('renders with single-symbol data without warning', () => {
    render(<CrossSymbolChart results={singleSymbolResults} />);
    expect(screen.getByText('Cross-Symbol Comparison')).toBeTruthy();
    expect(screen.queryByText(/Sample sizes vary/)).toBeNull();
  });
});
