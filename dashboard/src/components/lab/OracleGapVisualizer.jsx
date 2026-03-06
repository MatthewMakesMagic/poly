import React, { useState, useMemo } from 'react';
import {
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const TIMEPOINTS = [
  { offset: -60, suffix: '60s' },
  { offset: -30, suffix: '30s' },
  { offset: -10, suffix: '10s' },
  { offset: -5,  suffix: '5s' },
  { offset: -1,  suffix: '1s' },
  { offset: 0,   suffix: 'close' },
];

function buildChartData(window) {
  if (!window) return [];
  return TIMEPOINTS.map(({ offset, suffix }) => ({
    seconds: offset,
    clobUp: Number(window[`clob_up_${suffix}`]) || 0,
    clobDown: Number(window[`clob_down_${suffix}`]) || 0,
  }));
}

export default React.memo(function OracleGapVisualizer({ windows }) {
  const sortedWindows = useMemo(() => {
    if (!windows || windows.length === 0) return [];
    return [...windows]
      .sort((a, b) => {
        const ta = new Date(a.close_time || a.closeTime || 0).getTime();
        const tb = new Date(b.close_time || b.closeTime || 0).getTime();
        return tb - ta;
      })
      .slice(0, 50);
  }, [windows]);

  const [selectedIdx, setSelectedIdx] = useState(0);

  const selectedWindow = sortedWindows[selectedIdx] || null;
  const chartData = useMemo(() => buildChartData(selectedWindow), [selectedWindow]);

  const strikePrice = selectedWindow ? Number(selectedWindow.strike_price) || 0 : 0;

  if (!windows || windows.length === 0) {
    return (
      <div className="glass p-5">
        <h2 className="section-title mb-4">Oracle Gap Visualizer</h2>
        <div className="h-52 flex items-center justify-center">
          <p className="text-xs text-white/20">No window data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass p-5">
      <h2 className="section-title mb-4">Oracle Gap Visualizer</h2>

      {/* Window selector */}
      <div className="mb-4">
        <select
          value={selectedIdx}
          onChange={(e) => setSelectedIdx(Number(e.target.value))}
          className="bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300 appearance-none"
        >
          {sortedWindows.map((w, i) => (
            <option key={w.window_id || i} value={i}>
              {w.window_id} — {w.symbol}
            </option>
          ))}
        </select>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="seconds"
            label={{ value: 'Seconds to Close', position: 'insideBottom', offset: -5, fontSize: 10, fill: 'rgba(255,255,255,0.3)' }}
            stroke="rgba(255,255,255,0.15)"
            tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
          />
          <YAxis
            domain={[0, 1]}
            stroke="rgba(255,255,255,0.15)"
            tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
            axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'rgba(15,23,42,0.9)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px',
              fontSize: '11px',
              color: 'rgba(255,255,255,0.8)',
            }}
            labelFormatter={(v) => `T${v}s`}
          />
          <ReferenceLine y={0.5} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" label={{ value: 'Even', fill: 'rgba(255,255,255,0.3)', fontSize: 10, position: 'right' }} />
          <Line
            type="monotone"
            dataKey="clobUp"
            stroke="#34d399"
            strokeWidth={2}
            dot={{ r: 3, fill: '#34d399' }}
            name="CLOB UP"
          />
          <Line
            type="monotone"
            dataKey="clobDown"
            stroke="#f87171"
            strokeWidth={2}
            dot={{ r: 3, fill: '#f87171' }}
            name="CLOB DOWN"
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Info panel */}
      {selectedWindow && (
        <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
          <div className="bg-white/5 rounded-lg p-3 border border-white/5">
            <span className="text-white/30 block mb-1">Resolved Direction</span>
            <span className={`font-semibold ${selectedWindow.resolved_direction === 'UP' ? 'text-emerald-400' : 'text-red-400'}`}>
              {selectedWindow.resolved_direction || '—'}
            </span>
          </div>
          <div className="bg-white/5 rounded-lg p-3 border border-white/5">
            <span className="text-white/30 block mb-1">Consensus Direction</span>
            <span className={`font-semibold ${selectedWindow.market_consensus_direction === 'UP' ? 'text-emerald-400' : 'text-red-400'}`}>
              {selectedWindow.market_consensus_direction || '—'}
            </span>
          </div>
          <div className="bg-white/5 rounded-lg p-3 border border-white/5">
            <span className="text-white/30 block mb-1">Oracle Open</span>
            <span className="text-white/70 font-mono">
              ${Number(selectedWindow.oracle_open_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="bg-white/5 rounded-lg p-3 border border-white/5">
            <span className="text-white/30 block mb-1">Oracle Close</span>
            <span className="text-white/70 font-mono">
              ${Number(selectedWindow.oracle_close_price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
});
