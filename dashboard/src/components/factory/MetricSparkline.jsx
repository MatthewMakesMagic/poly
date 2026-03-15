import React from 'react';
import { LineChart, Line, YAxis, Tooltip } from 'recharts';
import { CHART_THEME } from './chart-theme.js';

/**
 * Small inline sparkline showing metric progression (e.g. Sharpe across lineage iterations).
 * Minimal chrome — just the line with a gradient fill and dot on the last point.
 */

function SparkTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: CHART_THEME.tooltip.bg,
        border: `1px solid ${CHART_THEME.tooltip.border}`,
        backdropFilter: CHART_THEME.tooltip.backdropFilter,
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 10,
        fontFamily: 'JetBrains Mono, monospace',
        color: 'rgba(255,255,255,0.7)',
      }}
    >
      {payload[0]?.value?.toFixed(2)}
    </div>
  );
}

export default function MetricSparkline({ data, width = 120, height = 40, dataKey = 'sharpe' }) {
  if (!data || data.length < 2) return null;

  return (
    <LineChart width={width} height={height} data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
      <defs>
        <linearGradient id="sparkGradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={CHART_THEME.colors.primary} stopOpacity={0.3} />
          <stop offset="100%" stopColor={CHART_THEME.colors.primary} stopOpacity={0.8} />
        </linearGradient>
      </defs>
      <YAxis hide domain={['dataMin - 0.1', 'dataMax + 0.1']} />
      <Tooltip content={<SparkTooltip />} />
      <Line
        type="monotone"
        dataKey={dataKey}
        stroke="url(#sparkGradient)"
        strokeWidth={2}
        dot={false}
        activeDot={{ r: 3, fill: CHART_THEME.colors.primary, stroke: '#fff', strokeWidth: 1 }}
      />
    </LineChart>
  );
}
