import React, { useState, useEffect, useCallback } from 'react';
import DrawdownChart from '../components/DrawdownChart.jsx';
import AssertionBoard from '../components/AssertionBoard.jsx';
import RuntimeControls from '../components/RuntimeControls.jsx';

export default function RiskDashboard({ state, connected }) {
  const [assertions, setAssertions] = useState(null);
  const [controls, setControls] = useState([]);
  const [trades, setTrades] = useState([]);

  // Fetch assertions
  const fetchAssertions = useCallback(async () => {
    try {
      const res = await fetch('/api/assertions');
      const data = await res.json();
      setAssertions(data);
    } catch {
      // Ignore
    }
  }, []);

  // Fetch runtime controls
  const fetchControls = useCallback(async () => {
    try {
      const res = await fetch('/api/controls');
      const data = await res.json();
      setControls(data.controls || []);
    } catch {
      // Ignore
    }
  }, []);

  // Fetch recent trades for P&L breakdown
  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/trades');
      const data = await res.json();
      setTrades(data.trades || []);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchAssertions();
    fetchControls();
    fetchTrades();

    const interval = setInterval(() => {
      fetchAssertions();
      fetchControls();
    }, 5000);

    return () => clearInterval(interval);
  }, [fetchAssertions, fetchControls, fetchTrades]);

  return (
    <div className="space-y-4">
      {/* Top row: Drawdown chart + Strategy P&L */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DrawdownChart state={state} trades={trades} />
        <StrategyPnL trades={trades} />
      </div>

      {/* Bottom row: Assertions + Runtime controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AssertionBoard assertions={assertions} />
        <RuntimeControls controls={controls} onRefresh={fetchControls} />
      </div>
    </div>
  );
}

function StrategyPnL({ trades }) {
  // Group trades by strategy
  const byStrategy = {};
  for (const t of trades) {
    const sid = t.strategy_id || t.strategyId || 'unknown';
    if (!byStrategy[sid]) {
      byStrategy[sid] = { count: 0, pnl: 0, wins: 0, losses: 0 };
    }
    byStrategy[sid].count++;
    const pnl = Number(t.realized_pnl || t.realizedPnl || 0);
    byStrategy[sid].pnl += pnl;
    if (pnl > 0) byStrategy[sid].wins++;
    else if (pnl < 0) byStrategy[sid].losses++;
  }

  const strategies = Object.entries(byStrategy);

  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
        Per-Strategy P&L
      </h2>

      {strategies.length === 0 ? (
        <p className="text-xs text-gray-500">No trade data</p>
      ) : (
        <div className="space-y-2">
          {strategies.map(([name, data]) => {
            const pnlColor = data.pnl > 0 ? 'text-accent-green' : data.pnl < 0 ? 'text-accent-red' : 'text-gray-400';
            const pnlSign = data.pnl > 0 ? '+' : '';
            return (
              <div key={name} className="flex items-center justify-between py-2 px-2 rounded bg-bg-tertiary/30">
                <div>
                  <span className="text-sm text-gray-200 font-semibold">{name}</span>
                  <span className="text-xs text-gray-500 ml-2">
                    {data.count} trades ({data.wins}W / {data.losses}L)
                  </span>
                </div>
                <span className={`text-sm font-bold ${pnlColor}`}>
                  {pnlSign}${data.pnl.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
