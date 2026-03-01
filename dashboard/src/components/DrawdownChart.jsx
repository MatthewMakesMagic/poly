import React, { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

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
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
        Session P&L / Drawdown
      </h2>

      {chartData.length < 2 ? (
        <div className="h-48 flex items-center justify-center">
          <p className="text-xs text-gray-500">
            Need at least 2 closed trades to show chart
          </p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} />
            <YAxis stroke="#64748b" tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e293b',
                border: '1px solid #475569',
                borderRadius: '4px',
                fontSize: '12px',
              }}
            />
            <Line
              type="monotone"
              dataKey="pnl"
              stroke="#22c55e"
              strokeWidth={2}
              dot={false}
              name="Cumulative P&L"
            />
            <Line
              type="monotone"
              dataKey="drawdown"
              stroke="#ef4444"
              strokeWidth={1}
              dot={false}
              name="Drawdown"
              strokeDasharray="4 2"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
