import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend, ReferenceLine,
} from 'recharts';
import { CHART_THEME, formatMetric } from './chart-theme.js';

/**
 * Custom tooltip matching the glass aesthetic.
 */
function RegimeTooltip({ active, payload, label, formatter }) {
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
      }}
    >
      <p style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 4, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em' }}>{label}</p>
      {payload.map((entry, i) => (
        <p key={i} style={{ color: entry.color || 'rgba(255,255,255,0.7)', margin: '2px 0', fontSize: 11 }}>
          {entry.name}: {formatter ? formatter(entry.value, entry.name) : entry.value}
        </p>
      ))}
    </div>
  );
}

/**
 * Time-of-day bar chart: x = time buckets, y = win rate, bars colored by PnL.
 */
function TimeOfDayChart({ data }) {
  if (!data?.length) return null;

  return (
    <div>
      <h4 className="label-xs mb-2">Time of Day</h4>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} vertical={false} />
          <XAxis
            dataKey="bucket"
            stroke={CHART_THEME.axis.stroke}
            tick={{ ...CHART_THEME.axis.tick, fontSize: 9 }}
            axisLine={false}
          />
          <YAxis
            stroke={CHART_THEME.axis.stroke}
            tick={CHART_THEME.axis.tick}
            domain={[0, 1]}
            tickFormatter={v => `${(v * 100).toFixed(0)}%`}
            axisLine={false}
            width={40}
          />
          <Tooltip
            content={
              <RegimeTooltip
                formatter={(val, name) => {
                  if (name === 'Win Rate') return formatMetric(val, 'winRate');
                  if (name === 'PnL') return formatMetric(val, 'pnl');
                  return String(val);
                }}
              />
            }
          />
          <Bar dataKey="winRate" name="Win Rate" radius={[3, 3, 0, 0]}>
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={entry.pnl >= 0 ? CHART_THEME.colors.positive : CHART_THEME.colors.negative}
                fillOpacity={0.65}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {/* Trade count labels */}
      <div className="flex justify-around px-2 -mt-1">
        {data.map((d, i) => (
          <span key={i} className="text-[9px] text-white/20 text-center font-mono tabular-nums" style={{ flex: 1 }}>
            {d.trades}t
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * First/second half grouped comparison.
 */
function HalfComparisonChart({ firstHalf, secondHalf }) {
  if (!firstHalf || !secondHalf) return null;

  const data = [
    { metric: 'Sharpe', 'First Half': firstHalf.sharpe, 'Second Half': secondHalf.sharpe },
    { metric: 'Win Rate', 'First Half': firstHalf.winRate, 'Second Half': secondHalf.winRate },
  ];

  return (
    <div>
      <h4 className="label-xs mb-2">First / Second Half</h4>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <div className="glass-subtle p-2.5 rounded-lg text-center">
          <div className="text-[9px] text-white/25 uppercase tracking-wider mb-1.5 font-semibold">First Half</div>
          <div className="flex gap-3 justify-center">
            <div>
              <div className="text-xs font-semibold text-white/70 font-mono tabular-nums">{formatMetric(firstHalf.sharpe, 'sharpe')}</div>
              <div className="text-[9px] text-white/20">Sharpe</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-white/70 font-mono tabular-nums">{formatMetric(firstHalf.winRate, 'winRate')}</div>
              <div className="text-[9px] text-white/20">WR</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-white/70 font-mono tabular-nums">{formatMetric(firstHalf.trades, 'trades')}</div>
              <div className="text-[9px] text-white/20">Trades</div>
            </div>
          </div>
        </div>
        <div className="glass-subtle p-2.5 rounded-lg text-center">
          <div className="text-[9px] text-white/25 uppercase tracking-wider mb-1.5 font-semibold">Second Half</div>
          <div className="flex gap-3 justify-center">
            <div>
              <div className="text-xs font-semibold text-white/70 font-mono tabular-nums">{formatMetric(secondHalf.sharpe, 'sharpe')}</div>
              <div className="text-[9px] text-white/20">Sharpe</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-white/70 font-mono tabular-nums">{formatMetric(secondHalf.winRate, 'winRate')}</div>
              <div className="text-[9px] text-white/20">WR</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-white/70 font-mono tabular-nums">{formatMetric(secondHalf.trades, 'trades')}</div>
              <div className="text-[9px] text-white/20">Trades</div>
            </div>
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} vertical={false} />
          <XAxis dataKey="metric" stroke={CHART_THEME.axis.stroke} tick={CHART_THEME.axis.tick} axisLine={false} />
          <YAxis stroke={CHART_THEME.axis.stroke} tick={CHART_THEME.axis.tick} axisLine={false} width={40} />
          <Tooltip content={<RegimeTooltip formatter={(v) => typeof v === 'number' ? v.toFixed(2) : v} />} />
          <Legend wrapperStyle={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', paddingTop: 8 }} />
          <Bar dataKey="First Half" fill={CHART_THEME.colors.series[0]} fillOpacity={0.65} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Second Half" fill={CHART_THEME.colors.series[1]} fillOpacity={0.65} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Day-of-week chart: x = Mon-Sun, y = Sharpe, bars colored by trade count intensity.
 */
function DayOfWeekChart({ data }) {
  if (!data?.length) return null;

  // Compute max trades for intensity scaling
  const maxTrades = Math.max(...data.map(d => d.trades || 0), 1);

  return (
    <div>
      <h4 className="label-xs mb-2">Day of Week</h4>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_THEME.grid.stroke} vertical={false} />
          <XAxis
            dataKey="day"
            stroke={CHART_THEME.axis.stroke}
            tick={{ ...CHART_THEME.axis.tick, fontSize: 9 }}
            axisLine={false}
          />
          <YAxis
            stroke={CHART_THEME.axis.stroke}
            tick={CHART_THEME.axis.tick}
            domain={[0, 'auto']}
            axisLine={false}
            width={40}
          />
          <ReferenceLine y={0} stroke={CHART_THEME.axis.stroke} strokeDasharray="3 3" />
          <Tooltip
            content={
              <RegimeTooltip
                formatter={(val, name) => {
                  if (name === 'Sharpe') return formatMetric(val, 'sharpe');
                  return String(val);
                }}
              />
            }
          />
          <Bar dataKey="sharpe" name="Sharpe" radius={[3, 3, 0, 0]}>
            {data.map((entry, i) => {
              const intensity = 0.35 + 0.55 * ((entry.trades || 0) / maxTrades);
              return (
                <Cell
                  key={i}
                  fill={CHART_THEME.colors.primary}
                  fillOpacity={intensity}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex justify-around px-2 -mt-1">
        {data.map((d, i) => (
          <span key={i} className="text-[9px] text-white/20 text-center font-mono tabular-nums" style={{ flex: 1 }}>
            {d.trades}t
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Regime breakdown visualizations for a factory result.
 * Renders three charts: time-of-day, first/second half, day-of-week.
 */
export default function RegimeBreakdown({ regime }) {
  if (!regime) {
    return (
      <div className="glass p-5 rounded-xl">
        <h3 className="section-title mb-3">Regime Breakdown</h3>
        <p className="text-xs text-white/20 text-center py-8">No regime data available</p>
      </div>
    );
  }

  const hasTimeOfDay = regime.timeOfDay?.length > 0;
  const hasDayOfWeek = regime.dayOfWeek?.length > 0;
  const hasHalves = regime.firstHalf && regime.secondHalf;
  const hasAny = hasTimeOfDay || hasDayOfWeek || hasHalves;

  if (!hasAny) {
    return (
      <div className="glass p-5 rounded-xl">
        <h3 className="section-title mb-3">Regime Breakdown</h3>
        <p className="text-xs text-white/20 text-center py-8">No regime data available</p>
      </div>
    );
  }

  return (
    <div className="glass p-5 rounded-xl">
      <h3 className="section-title mb-4">Regime Breakdown</h3>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div>{hasTimeOfDay ? <TimeOfDayChart data={regime.timeOfDay} /> : <EmptySlot label="Time of Day" />}</div>
        <div>{hasHalves ? <HalfComparisonChart firstHalf={regime.firstHalf} secondHalf={regime.secondHalf} /> : <EmptySlot label="Half Comparison" />}</div>
        <div>{hasDayOfWeek ? <DayOfWeekChart data={regime.dayOfWeek} /> : <EmptySlot label="Day of Week" />}</div>
      </div>
    </div>
  );
}

function EmptySlot({ label }) {
  return (
    <div>
      <h4 className="label-xs mb-2">{label}</h4>
      <div className="flex items-center justify-center h-[200px] text-[10px] text-white/15 border border-dashed border-white/[0.06] rounded-lg">
        No data
      </div>
    </div>
  );
}
