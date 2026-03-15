/**
 * Shared chart theme for Factory dashboard visualizations.
 * Matches the existing glass-morphism dark aesthetic.
 *
 * @module components/factory/chart-theme
 */

export const CHART_THEME = {
  colors: {
    primary: '#8b5cf6',    // violet
    positive: '#34d399',   // emerald
    negative: '#f87171',   // red
    neutral: '#6b7280',    // gray
    warning: '#fbbf24',    // yellow/amber
    series: ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#14b8a6'],
  },
  axis: {
    stroke: 'rgba(255,255,255,0.08)',
    tick: { fill: 'rgba(255,255,255,0.35)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
  },
  grid: { stroke: 'rgba(255,255,255,0.04)' },
  tooltip: {
    bg: 'rgba(10, 14, 26, 0.92)',
    border: 'rgba(255,255,255,0.08)',
    backdropFilter: 'blur(12px)',
  },
};

/**
 * Format a metric value for display.
 * @param {*} value
 * @param {'sharpe'|'winRate'|'pnl'|'trades'|'percent'|'drawdown'|'decimal'} type
 * @returns {string}
 */
export function formatMetric(value, type) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }
  const n = Number(value);
  switch (type) {
    case 'sharpe':
    case 'decimal':
      return n.toFixed(2);
    case 'winRate':
      return `${(n * 100).toFixed(1)}%`;
    case 'percent':
      return `${n.toFixed(1)}%`;
    case 'pnl':
      if (n < 0) return `-$${Math.abs(n).toFixed(2)}`;
      return `+$${n.toFixed(2)}`;
    case 'trades':
      return String(Math.round(n));
    case 'drawdown':
      return `${(n * 100).toFixed(1)}%`;
    default:
      return n.toFixed(2);
  }
}
