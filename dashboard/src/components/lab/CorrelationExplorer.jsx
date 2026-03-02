import React, { useMemo, useState } from 'react';
import { runBacktest } from '../../lib/backtestEngine.js';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const AXIS_OPTIONS = [
  { key: 'entryPrice', label: 'Entry Price' },
  { key: 'confidence', label: 'Consensus Confidence' },
  { key: 'pnl', label: 'P&L' },
  { key: 'hour', label: 'Hour (ET)' },
];

const selectClass =
  'bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300 appearance-none';

function getValue(trade, key) {
  if (key === 'hour') {
    return (new Date(trade.closeTime).getUTCHours() - 5 + 24) % 24;
  }
  return trade[key];
}

export default React.memo(function CorrelationExplorer({ windows, filters }) {
  const [xKey, setXKey] = useState('entryPrice');
  const [yKey, setYKey] = useState('pnl');

  const { wins, losses } = useMemo(() => {
    const { trades } = runBacktest(windows, filters);
    const w = [];
    const l = [];
    for (const t of trades) {
      const point = { x: getValue(t, xKey), y: getValue(t, yKey), ...t };
      if (t.won) {
        w.push(point);
      } else {
        l.push(point);
      }
    }
    return { wins: w, losses: l };
  }, [windows, filters, xKey, yKey]);

  const xLabel = AXIS_OPTIONS.find((o) => o.key === xKey)?.label ?? xKey;
  const yLabel = AXIS_OPTIONS.find((o) => o.key === yKey)?.label ?? yKey;

  return (
    <div className="glass p-5">
      <h3 className="section-title mb-4">Correlation Explorer</h3>

      <div className="flex items-center gap-4 mb-4">
        <label className="flex items-center gap-2 text-xs text-white/50">
          X Axis
          <select className={selectClass} value={xKey} onChange={(e) => setXKey(e.target.value)}>
            {AXIS_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-white/50">
          Y Axis
          <select className={selectClass} value={yKey} onChange={(e) => setYKey(e.target.value)}>
            {AXIS_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <ResponsiveContainer width="100%" height={400}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="x"
            name={xLabel}
            stroke="rgba(255,255,255,0.15)"
            tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
            label={{ value: xLabel, position: 'insideBottom', offset: -10, fontSize: 10, fill: 'rgba(255,255,255,0.4)' }}
            type="number"
          />
          <YAxis
            dataKey="y"
            name={yLabel}
            stroke="rgba(255,255,255,0.15)"
            tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 5, fontSize: 10, fill: 'rgba(255,255,255,0.4)' }}
            type="number"
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
          />
          <Scatter name="Wins" data={wins} fill="#34d399" fillOpacity={0.6} />
          <Scatter name="Losses" data={losses} fill="#f87171" fillOpacity={0.6} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
});
