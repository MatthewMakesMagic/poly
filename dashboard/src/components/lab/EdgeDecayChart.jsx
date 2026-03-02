import React, { useMemo } from 'react';
import { runBacktest } from '../../lib/backtestEngine.js';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const ENTRY_OFFSETS = [60, 30, 10, 5, 1];

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

export default React.memo(function EdgeDecayChart({ windows, filters }) {
  const data = useMemo(() => {
    if (!windows || windows.length === 0) return [];

    return ENTRY_OFFSETS.map((offset) => {
      const result = runBacktest(windows, { ...filters, entryOffset: offset });
      return {
        offset: `${offset}s`,
        winRate: result.winRate,
        avgEntry: result.avgEntry,
        trades: result.totalTrades,
        pnl: result.totalPnl,
        expectancy: result.expectancy,
      };
    });
  }, [windows, filters]);

  if (data.length === 0) {
    return (
      <div className="glass p-5">
        <h3 className="section-title mb-4">Edge Decay by Entry Timing</h3>
        <p className="text-white/40 text-xs">No windows loaded.</p>
      </div>
    );
  }

  return (
    <div className="glass p-5">
      <h3 className="section-title mb-4">Edge Decay by Entry Timing</h3>

      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis
            dataKey="offset"
            stroke={axisStroke}
            tick={tickStyle}
          />
          <YAxis
            yAxisId="left"
            domain={[0, 1]}
            stroke={axisStroke}
            tick={tickStyle}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, 1]}
            stroke={axisStroke}
            tick={tickStyle}
          />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar
            dataKey="winRate"
            yAxisId="left"
            fill="#a78bfa"
            fillOpacity={0.6}
            name="Win Rate"
          />
          <Line
            dataKey="avgEntry"
            yAxisId="right"
            stroke="#34d399"
            strokeWidth={2}
            dot={{ fill: '#34d399', r: 4 }}
            name="Avg Entry"
          />
        </ComposedChart>
      </ResponsiveContainer>

      <table className="w-full text-left mt-4">
        <thead>
          <tr className="border-b border-white/5">
            <th className="label-xs pb-2 pr-3">Offset</th>
            <th className="label-xs pb-2 pr-3">Trades</th>
            <th className="label-xs pb-2 pr-3">Win Rate</th>
            <th className="label-xs pb-2 pr-3">P&L</th>
            <th className="label-xs pb-2">Expectancy</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const pnlPositive = row.pnl >= 0;
            return (
              <tr key={row.offset} className="border-b border-white/5">
                <td className="text-[10px] text-white/80 py-1.5 pr-3">{row.offset}</td>
                <td className="text-[10px] text-white/60 py-1.5 pr-3">{row.trades}</td>
                <td className="text-[10px] text-white/80 py-1.5 pr-3">
                  {(row.winRate * 100).toFixed(1)}%
                </td>
                <td
                  className={`text-[10px] py-1.5 pr-3 ${
                    pnlPositive
                      ? 'text-accent-green'
                      : 'text-accent-red'
                  }`}
                >
                  {pnlPositive ? '+' : ''}{row.pnl.toFixed(2)}
                </td>
                <td className="text-[10px] text-white/60 py-1.5">
                  {row.expectancy >= 0 ? '+' : ''}{row.expectancy.toFixed(4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
