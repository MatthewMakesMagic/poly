import React, { useMemo } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart } from 'recharts';

export default function DrawdownChart({ state, trades }) {
  // Build cumulative P&L data from trades (chronological)
  const chartData = useMemo(() => {
    if (!trades || trades.length === 0) return [];

    // Sort by closed_at ascending
    const sorted = [...trades]
      .filter(t => t.closed_at || t.closedAt)
      .sort((a, b) => {
        const ta = new Date(a.closed_at || a.closedAt).getTime();
        const tb = new Date(b.closed_at || b.closedAt).getTime();
        return ta - tb;
      });

    let cumPnl = 0;
    let peak = 0;
    return sorted.map((t) => {
      const pnl = Number(t.realized_pnl || t.realizedPnl || 0);
      cumPnl += pnl;
      if (cumPnl > peak) peak = cumPnl;
      const drawdown = peak - cumPnl;

      const time = new Date(t.closed_at || t.closedAt);
      return {
        time: time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        pnl: Number(cumPnl.toFixed(2)),
        drawdown: Number((-drawdown).toFixed(2)),
      };
    });
  }, [trades]);

  return (
    <div className="glass p-5">
      <h2 className="section-title mb-4">Session P&L / Drawdown</h2>

      {chartData.length < 2 ? (
        <div className="h-52 flex items-center justify-center">
          <p className="text-xs text-white/20">
            Need at least 2 closed trades to render chart
          </p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData}>
            <defs>
              <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="drawdownGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f87171" stopOpacity={0} />
                <stop offset="100%" stopColor="#f87171" stopOpacity={0.2} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis
              dataKey="time"
              stroke="rgba(255,255,255,0.15)"
              tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            />
            <YAxis
              stroke="rgba(255,255,255,0.15)"
              tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                fontSize: '11px',
                color: 'rgba(255,255,255,0.8)',
              }}
            />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke="#34d399"
              strokeWidth={2}
              fill="url(#pnlGradient)"
              name="Cumulative P&L"
            />
            <Line
              type="monotone"
              dataKey="drawdown"
              stroke="#f87171"
              strokeWidth={1}
              dot={false}
              name="Drawdown"
              strokeDasharray="4 2"
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
