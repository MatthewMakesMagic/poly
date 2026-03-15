/**
 * Unit tests for ParameterImportance component and computeParameterImportance utility.
 * Validates that parameter importance is correctly computed from sweep results,
 * and that the component renders the tornado chart with correct highlighting.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import ParameterImportance, { computeParameterImportance } from '../../../components/factory/ParameterImportance.jsx';
import results from '../fixtures/factory-results.json';

// Build a set of sweep results with varying parameters and Sharpe values
// Using deficit-asymmetry-v1 and v2 from fixture — they share config keys but differ in values
const sweepResults = results.filter(r =>
  r.strategy_name.startsWith('deficit-asymmetry') && r.symbol === 'btc'
);

describe('computeParameterImportance', () => {
  it('returns empty array for null/empty input', () => {
    expect(computeParameterImportance(null)).toEqual([]);
    expect(computeParameterImportance([])).toEqual([]);
    expect(computeParameterImportance([results[0]])).toEqual([]);
  });

  it('returns scores sorted by importance descending', () => {
    const scores = computeParameterImportance(sweepResults);
    expect(scores.length).toBeGreaterThan(0);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].importance).toBeGreaterThanOrEqual(scores[i].importance);
    }
  });

  it('identifies parameters with high Sharpe variance as important (stddev > 0.3)', () => {
    // Create synthetic data where one parameter clearly drives Sharpe variance
    const synthetic = [
      { config: { alpha: 0.1, beta: 1 }, metrics: { sharpe: 2.0 } },
      { config: { alpha: 0.1, beta: 2 }, metrics: { sharpe: 2.1 } },
      { config: { alpha: 0.9, beta: 1 }, metrics: { sharpe: 0.5 } },
      { config: { alpha: 0.9, beta: 2 }, metrics: { sharpe: 0.6 } },
    ];
    const scores = computeParameterImportance(synthetic);
    const alphaScore = scores.find(s => s.param === 'alpha');
    const betaScore = scores.find(s => s.param === 'beta');

    // alpha drives a ~0.75 stddev in Sharpe group means, should be important
    expect(alphaScore).toBeDefined();
    expect(alphaScore.isImportant).toBe(true);
    expect(alphaScore.importance).toBeGreaterThan(0.3);

    // beta has minimal variance (~0.05 stddev), should not be important
    expect(betaScore).toBeDefined();
    expect(betaScore.isImportant).toBe(false);
    expect(betaScore.importance).toBeLessThan(0.3);
  });

  it('each score has param, importance, and isImportant fields', () => {
    const scores = computeParameterImportance(sweepResults);
    for (const s of scores) {
      expect(s).toHaveProperty('param');
      expect(s).toHaveProperty('importance');
      expect(s).toHaveProperty('isImportant');
      expect(typeof s.param).toBe('string');
      expect(typeof s.importance).toBe('number');
      expect(typeof s.isImportant).toBe('boolean');
    }
  });

  it('skips parameters that only have one distinct value', () => {
    // All rows share the same config value for "alpha"
    const sameVal = [
      { config: { alpha: 0.5 }, metrics: { sharpe: 1.0 } },
      { config: { alpha: 0.5 }, metrics: { sharpe: 2.0 } },
    ];
    const scores = computeParameterImportance(sameVal);
    // alpha only has 1 group, so it should be excluded
    expect(scores.find(s => s.param === 'alpha')).toBeUndefined();
  });
});

describe('ParameterImportance component', () => {
  it('renders "Not enough parameter variation" when results are empty', () => {
    render(<ParameterImportance results={[]} />);
    expect(screen.getByText(/Not enough parameter variation/)).toBeTruthy();
  });

  it('renders the heading "Parameter Importance"', () => {
    render(<ParameterImportance results={sweepResults} />);
    expect(screen.getByText('Parameter Importance')).toBeTruthy();
  });

  it('renders parameter importance chart with fixture sweep results', () => {
    const { container } = render(<ParameterImportance results={sweepResults} />);
    // ResponsiveContainer renders as .recharts-responsive-container in jsdom (no ResizeObserver dims)
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy();
  });

  it('renders legend items for significance levels', () => {
    render(<ParameterImportance results={sweepResults} />);
    expect(screen.getByText(/Significant/)).toBeTruthy();
    expect(screen.getByText(/Low impact/)).toBeTruthy();
  });
});
