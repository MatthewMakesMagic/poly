import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import { CHART_THEME, formatMetric } from './chart-theme.js';

/**
 * Compute parameter importance scores from sweep results.
 *
 * For each config parameter key, groups results by that key's value,
 * computes the standard deviation of Sharpe across groups.
 * Keys with stddev > 0.3 are considered "important".
 *
 * @param {Array} results - Factory result rows with config and metrics
 * @returns {Array<{param: string, importance: number, isImportant: boolean}>}
 */
export function computeParameterImportance(results) {
  if (!results?.length || results.length < 2) return [];

  // Collect all config keys
  const allKeys = new Set();
  for (const r of results) {
    if (r.config) {
      for (const k of Object.keys(r.config)) {
        allKeys.add(k);
      }
    }
  }

  const scores = [];

  for (const key of allKeys) {
    // Group sharpe values by this key's value
    const groups = {};
    for (const r of results) {
      const val = r.config?.[key];
      if (val === undefined || val === null) continue;
      const sharpe = Number(r.metrics?.sharpe);
      if (isNaN(sharpe)) continue;
      const groupKey = String(val);
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(sharpe);
    }

    // Need at least 2 distinct groups for variance
    const groupKeys = Object.keys(groups);
    if (groupKeys.length < 2) continue;

    // Compute mean Sharpe per group, then stddev of group means
    const groupMeans = groupKeys.map(gk => {
      const vals = groups[gk];
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    });

    const overallMean = groupMeans.reduce((s, v) => s + v, 0) / groupMeans.length;
    const variance = groupMeans.reduce((s, v) => s + (v - overallMean) ** 2, 0) / groupMeans.length;
    const stddev = Math.sqrt(variance);

    scores.push({
      param: key,
      importance: Math.round(stddev * 100) / 100,
      isImportant: stddev > 0.3,
    });
  }

  // Sort descending by importance
  scores.sort((a, b) => b.importance - a.importance);
  return scores;
}

/**
 * Custom tooltip for parameter importance chart.
 */
function ImportanceTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  return (
    <div
      style={{
        background: CHART_THEME.tooltip.bg,
        border: `1px solid ${CHART_THEME.tooltip.border}`,
        backdropFilter: CHART_THEME.tooltip.backdropFilter,
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 11,
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontWeight: 600 }}>
        {d?.param}
      </p>
      <p style={{ color: 'rgba(255,255,255,0.45)', margin: '3px 0 0', fontSize: 10 }}>
        Sharpe stddev: {d?.importance?.toFixed(3)}
      </p>
      <p style={{ color: d?.isImportant ? CHART_THEME.colors.primary : 'rgba(255,255,255,0.25)', margin: '2px 0 0', fontSize: 10 }}>
        {d?.isImportant ? 'Significant driver' : 'Low impact'}
      </p>
    </div>
  );
}

/**
 * Parameter importance visualization.
 * Horizontal bar chart showing which config parameters have the highest
 * variance contribution to Sharpe across sweep variants.
 */
export default function ParameterImportance({ results }) {
  const scores = useMemo(() => computeParameterImportance(results), [results]);

  if (!scores.length) {
    return (
      <div className="glass p-5 rounded-xl">
        <h3 className="section-title mb-3">Parameter Importance</h3>
        <p className="text-xs text-white/20 text-center py-8">
          Not enough parameter variation to compute importance
        </p>
      </div>
    );
  }

  return (
    <div className="glass p-5 rounded-xl">
      <h3 className="section-title mb-1">Parameter Importance</h3>
      <p className="text-[10px] text-white/20 mb-4">
        Sharpe variance by parameter — higher = more impact on performance
      </p>

      <ResponsiveContainer width="100%" height={Math.max(120, scores.length * 36 + 20)}>
        <BarChart
          data={scores}
          layout="vertical"
          margin={{ top: 4, right: 40, bottom: 4, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} horizontal={false} vertical />
          <XAxis
            type="number"
            stroke={CHART_THEME.axis.stroke}
            tick={CHART_THEME.axis.tick}
            domain={[0, 'auto']}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="param"
            stroke={CHART_THEME.axis.stroke}
            tick={{ ...CHART_THEME.axis.tick, fontSize: 10 }}
            width={120}
            axisLine={false}
          />
          <Tooltip content={<ImportanceTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />
          <Bar dataKey="importance" name="Importance" radius={[0, 4, 4, 0]} barSize={18}>
            {scores.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.isImportant ? CHART_THEME.colors.primary : CHART_THEME.colors.neutral}
                fillOpacity={entry.isImportant ? 0.75 : 0.35}
              />
            ))}
            <LabelList
              dataKey="importance"
              position="right"
              style={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}
              formatter={v => v.toFixed(2)}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Importance threshold legend */}
      <div className="flex items-center gap-4 mt-3 pt-3 border-t border-white/[0.04] text-[10px]">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CHART_THEME.colors.primary, opacity: 0.75 }} />
          <span className="text-white/30">Significant (&gt; 0.3)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CHART_THEME.colors.neutral, opacity: 0.35 }} />
          <span className="text-white/30">Low impact</span>
        </div>
      </div>
    </div>
  );
}
