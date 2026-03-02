import React, { useMemo } from 'react';
import { runBacktest } from '../../lib/backtestEngine.js';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

const tooltipStyle = {
  backgroundColor: 'rgba(15,23,42,0.9)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  fontSize: '11px',
  color: 'rgba(255,255,255,0.8)',
};

const tickStyle = { fontSize: 9, fill: 'rgba(255,255,255,0.3)' };
const axisStroke = 'rgba(255,255,255,0.15)';

function CustomTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const t = payload[0].payload;
  return (
    <div style={tooltipStyle}>
      <div><strong>Window:</strong> {t.windowId}</div>
      <div><strong>Symbol:</strong> {t.symbol}</div>
      <div><strong>Side:</strong> {t.side?.toUpperCase()}</div>
      <div><strong>Entry:</strong> {t.entryPrice?.toFixed(4)}</div>
      <div><strong>P&L:</strong> {t.pnl >= 0 ? '+' : ''}{t.pnl?.toFixed(4)}</div>
      <div><strong>Resolved:</strong> {t.resolved?.toUpperCase()}</div>
    </div>
  );
}

export default React.memo(function TradeScatter({ windows, filters }) {
  const { trades, wins, losses } = useMemo(
    () => runBacktest(windows, filters),
    [windows, filters],
  );

  const winData = useMemo(() => trades.filter(t => t.won === true), [trades]);
  const lossData = useMemo(() => trades.filter(t => t.won === false), [trades]);

  return (
    <div className="glass p-5">
      <h3 className="section-title mb-4">Trade Scatter</h3>

      {trades.length === 0 ? (
        <p className="text-white/30 text-sm">No trades match the current filters.</p>
      ) : (
        <>
          <p className="text-white/40 text-xs mb-4">
            {trades.length} trades &middot;{' '}
            <span className="text-emerald-400">{wins}W</span>{' / '}
            <span className="text-red-400">{losses}L</span>
          </p>

          <ResponsiveContainer width="100%" height={400}>
            <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                type="number"
                dataKey="entryPrice"
                domain={[0, 1]}
                name="Entry Price"
                stroke={axisStroke}
                tick={tickStyle}
              />
              <YAxis
                type="number"
                dataKey="pnl"
                domain={[-1, 1]}
                name="P&L"
                stroke={axisStroke}
                tick={tickStyle}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
              <Scatter name="Wins" data={winData} fill="#34d399" fillOpacity={0.6} />
              <Scatter name="Losses" data={lossData} fill="#f87171" fillOpacity={0.6} />
            </ScatterChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
});
