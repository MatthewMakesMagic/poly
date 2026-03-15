/**
 * Unit tests for chart-theme.js formatMetric utility.
 * Tests edge cases: null, undefined, NaN, 0, and all format types.
 */
import { describe, it, expect } from 'vitest';
import { formatMetric, CHART_THEME } from '../../../components/factory/chart-theme.js';

describe('formatMetric', () => {
  it('formats sharpe to 2 decimal places', () => {
    expect(formatMetric(1.82, 'sharpe')).toBe('1.82');
    expect(formatMetric(0, 'sharpe')).toBe('0.00');
    expect(formatMetric(-0.5, 'sharpe')).toBe('-0.50');
  });

  it('formats winRate as percentage (0-1 input)', () => {
    expect(formatMetric(0.62, 'winRate')).toBe('62.0%');
    expect(formatMetric(0, 'winRate')).toBe('0.0%');
    expect(formatMetric(1, 'winRate')).toBe('100.0%');
  });

  it('formats pnl with +/- and $ sign', () => {
    expect(formatMetric(45.2, 'pnl')).toBe('+$45.20');
    expect(formatMetric(-10.5, 'pnl')).toBe('-$10.50');
    expect(formatMetric(0, 'pnl')).toBe('+$0.00');
  });

  it('formats trades as integer', () => {
    expect(formatMetric(142, 'trades')).toBe('142');
    expect(formatMetric(142.7, 'trades')).toBe('143');
    expect(formatMetric(0, 'trades')).toBe('0');
  });

  it('formats drawdown as percentage', () => {
    expect(formatMetric(0.065, 'drawdown')).toBe('6.5%');
    expect(formatMetric(0, 'drawdown')).toBe('0.0%');
  });

  it('returns "--" for null', () => {
    expect(formatMetric(null, 'sharpe')).toBe('--');
  });

  it('returns "--" for undefined', () => {
    expect(formatMetric(undefined, 'sharpe')).toBe('--');
  });

  it('returns "--" for NaN', () => {
    expect(formatMetric(NaN, 'sharpe')).toBe('--');
  });

  it('returns "--" for non-numeric string', () => {
    expect(formatMetric('abc', 'sharpe')).toBe('--');
  });
});

describe('CHART_THEME', () => {
  it('exports required color keys', () => {
    expect(CHART_THEME.colors.primary).toBeDefined();
    expect(CHART_THEME.colors.positive).toBeDefined();
    expect(CHART_THEME.colors.negative).toBeDefined();
    expect(CHART_THEME.colors.neutral).toBeDefined();
    expect(CHART_THEME.colors.series).toHaveLength(5);
  });

  it('exports axis, grid, and tooltip config', () => {
    expect(CHART_THEME.axis.stroke).toBeDefined();
    expect(CHART_THEME.axis.tick.fill).toBeDefined();
    expect(CHART_THEME.grid.stroke).toBeDefined();
    expect(CHART_THEME.tooltip.bg).toBeDefined();
    expect(CHART_THEME.tooltip.border).toBeDefined();
  });
});
