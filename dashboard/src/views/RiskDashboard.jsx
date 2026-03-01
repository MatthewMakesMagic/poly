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
        <StrategyPnL trades={trades} state={state} />
      </div>

      {/* Bottom row: Assertions + Runtime controls */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <AssertionBoard assertions={assertions} />
        <RuntimeControls controls={controls} onRefresh={fetchControls} />
      </div>
    </div>
  );
}

function StrategyPnL({ trades, state }) {
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
  const activeStrategy = state?.activeStrategy;

  return (
    <div className="glass p-5">
      <h2 className="section-title mb-4">Per-Strategy Performance</h2>

      {strategies.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-xs text-white/20">No trade data available</p>
        </div>
      ) : (
        <div className="space-y-2">
          {strategies.map(([name, data]) => {
            const pnlColor = data.pnl > 0 ? 'text-accent-green' : data.pnl < 0 ? 'text-accent-red' : 'text-white/40';
            const pnlSign = data.pnl > 0 ? '+' : '';
            const winRate = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(0) : '0';
            const isActive = name === activeStrategy;

            return (
              <div key={name} className={`rounded-lg p-3 transition-all duration-300 ${
                isActive
                  ? 'bg-accent-violet/[0.08] border border-accent-violet/15'
                  : 'bg-white/[0.02] border border-white/5 hover:bg-white/[0.04]'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-violet shadow-[0_0_6px_rgba(167,139,250,0.6)] animate-pulse-slow" />
                    )}
                    <span className="text-xs font-semibold text-white/80">{name}</span>
                  </div>
                  <span className={`text-sm font-bold ${pnlColor}`}>
                    {pnlSign}${data.pnl.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-[10px] text-white/30">
                  <span>{data.count} trades</span>
                  <span className="text-accent-green/70">{data.wins}W</span>
                  <span className="text-accent-red/70">{data.losses}L</span>
                  <span>WR: {winRate}%</span>
                  {data.count > 0 && (
                    <span>Avg: ${(data.pnl / data.count).toFixed(2)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
