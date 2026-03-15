import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts';
import { CHART_THEME, formatMetric } from './chart-theme.js';

const LOW_TRADE_THRESHOLD = 50;

/**
 * Check if sample sizes vary by more than 2x across symbols.
 * @param {Array<{symbol: string, trades: number}>} symbolData
 * @returns {boolean}
 */
export function hasSampleSizeWarning(symbolData) {
  if (!symbolData || symbolData.length < 2) return false;
  const trades = symbolData.map(d => d.trades).filter(t => t > 0);
  if (trades.length < 2) return false;
  const max = Math.max(...trades);
  const min = Math.min(...trades);
  return max > min * 2;
}

/**
 * Custom tooltip for cross-symbol chart.
 */
function SymbolTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
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
        minWidth: 140,
      }}
    >
      <p style={{ color: 'rgba(255,255,255,0.5)', margin: '0 0 4px', fontWeight: 600, fontSize: 10, letterSpacing: '0.05em' }}>{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color, margin: '2px 0', fontSize: 10 }}>
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toFixed(2) : entry.value}
        </p>
      ))}
    </div>
  );
}

/**
 * Cross-symbol comparison chart.
 * Shows Sharpe, Win Rate, and Trades for the same strategy across different symbols.
 * Flags unequal sample sizes and dims low-sample symbols.
 */
export default function CrossSymbolChart({ results, strategyName }) {
  const symbolData = useMemo(() => {
    if (!results?.length) return [];

    // Deduplicate: pick best Sharpe per symbol
    const bySymbol = {};
    for (const r of results) {
      const sym = (r.symbol || '').toUpperCase();
      const sharpe = Number(r.metrics?.sharpe) || 0;
      if (!bySymbol[sym] || sharpe > (Number(bySymbol[sym].metrics?.sharpe) || 0)) {
        bySymbol[sym] = r;
      }
    }

    return Object.entries(bySymbol)
      .map(([sym, r]) => ({
        symbol: sym,
        sharpe: Number(r.metrics?.sharpe) || 0,
        winRate: Number(r.metrics?.winRate) || 0,
        trades: Number(r.metrics?.trades) || 0,
        profitFactor: Number(r.metrics?.profitFactor) || 0,
        maxDrawdown: Number(r.metrics?.maxDrawdown) || 0,
        isLowSample: (Number(r.metrics?.trades) || 0) < LOW_TRADE_THRESHOLD,
      }))
      .sort((a, b) => b.sharpe - a.sharpe);
  }, [results]);

  const showWarning = useMemo(() => hasSampleSizeWarning(symbolData), [symbolData]);

  if (!symbolData.length) {
    return (
      <div className="glass p-5 rounded-xl">
        <h3 className="section-title mb-3">Cross-Symbol Comparison</h3>
        <p className="text-xs text-white/20 text-center py-8">No cross-symbol data available</p>
      </div>
    );
  }

  // Color mapping per symbol
  const symbolColors = {};
  symbolData.forEach((d, i) => {
    symbolColors[d.symbol] = CHART_THEME.colors.series[i % CHART_THEME.colors.series.length];
  });

  return (
    <div className="glass p-5 rounded-xl">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h3 className="section-title">Cross-Symbol Comparison</h3>
        {strategyName && (
          <span className="text-[11px] text-white/35 font-mono tracking-tight">{strategyName}</span>
        )}
      </div>

      {showWarning && (
        <div className="mb-4 mt-2 px-3 py-2 rounded-lg bg-yellow-500/[0.07] border border-yellow-500/15">
          <p className="text-[11px] text-yellow-400/70 font-medium">
            Sample sizes vary significantly across symbols — comparison may be unreliable
          </p>
        </div>
      )}

      {/* Sharpe comparison */}
      <div className="mb-6 mt-3">
        <h4 className="label-xs mb-2">Sharpe Ratio</h4>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={symbolData} margin={{ top: 20, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} vertical={false} />
            <XAxis dataKey="symbol" stroke={CHART_THEME.axis.stroke} tick={CHART_THEME.axis.tick} axisLine={false} />
            <YAxis stroke={CHART_THEME.axis.stroke} tick={CHART_THEME.axis.tick} domain={[0, 'auto']} axisLine={false} width={40} />
            <Tooltip content={<SymbolTooltip />} />
            <Bar dataKey="sharpe" name="Sharpe" radius={[4, 4, 0, 0]}>
              {symbolData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={symbolColors[entry.symbol]}
                  fillOpacity={entry.isLowSample ? 0.25 : 0.7}
                  stroke={entry.isLowSample ? symbolColors[entry.symbol] : 'none'}
                  strokeWidth={entry.isLowSample ? 1.5 : 0}
                  strokeDasharray={entry.isLowSample ? '4 2' : 'none'}
                />
              ))}
              <LabelList
                dataKey="trades"
                position="top"
                style={{ fill: 'rgba(255,255,255,0.3)', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                formatter={v => `${v}t`}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Win Rate + PF side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h4 className="label-xs mb-2">Win Rate</h4>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={symbolData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} vertical={false} />
              <XAxis dataKey="symbol" stroke={CHART_THEME.axis.stroke} tick={{ ...CHART_THEME.axis.tick, fontSize: 9 }} axisLine={false} />
              <YAxis
                stroke={CHART_THEME.axis.stroke}
                tick={CHART_THEME.axis.tick}
                domain={[0, 1]}
                tickFormatter={v => `${(v * 100).toFixed(0)}%`}
                axisLine={false}
                width={40}
              />
              <Tooltip content={<SymbolTooltip />} />
              <Bar dataKey="winRate" name="Win Rate" radius={[4, 4, 0, 0]}>
                {symbolData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={symbolColors[entry.symbol]}
                    fillOpacity={entry.isLowSample ? 0.25 : 0.65}
                    stroke={entry.isLowSample ? symbolColors[entry.symbol] : 'none'}
                    strokeWidth={entry.isLowSample ? 1.5 : 0}
                    strokeDasharray={entry.isLowSample ? '4 2' : 'none'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div>
          <h4 className="label-xs mb-2">Profit Factor</h4>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={symbolData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} vertical={false} />
              <XAxis dataKey="symbol" stroke={CHART_THEME.axis.stroke} tick={{ ...CHART_THEME.axis.tick, fontSize: 9 }} axisLine={false} />
              <YAxis stroke={CHART_THEME.axis.stroke} tick={CHART_THEME.axis.tick} domain={[0, 'auto']} axisLine={false} width={40} />
              <Tooltip content={<SymbolTooltip />} />
              <Bar dataKey="profitFactor" name="Profit Factor" radius={[4, 4, 0, 0]}>
                {symbolData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={symbolColors[entry.symbol]}
                    fillOpacity={entry.isLowSample ? 0.25 : 0.65}
                    stroke={entry.isLowSample ? symbolColors[entry.symbol] : 'none'}
                    strokeWidth={entry.isLowSample ? 1.5 : 0}
                    strokeDasharray={entry.isLowSample ? '4 2' : 'none'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Symbol legend with sample info */}
      <div className="flex flex-wrap items-center gap-4 mt-4 pt-3 border-t border-white/[0.04] text-[10px]">
        {symbolData.map((d, i) => (
          <div key={d.symbol} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{
                background: symbolColors[d.symbol],
                opacity: d.isLowSample ? 0.25 : 0.7,
                border: d.isLowSample ? `1px dashed ${symbolColors[d.symbol]}` : 'none',
              }}
            />
            <span className={`font-mono ${d.isLowSample ? 'text-white/20' : 'text-white/40'}`}>
              {d.symbol} ({d.trades}t)
            </span>
            {d.isLowSample && (
              <span className="text-red-400/40 text-[9px] font-medium">low sample</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
