import React, { useState, useEffect, useCallback } from 'react';

async function setActiveStrategy(strategyName) {
  const res = await fetch('/api/controls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'active_strategy', value: strategyName }),
  });
  return res.ok;
}

function StrategyRow({ name, isActive, onActivate, activating, metrics }) {
  const pnl = metrics?.pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/25';
  const pnlSign = pnl > 0 ? '+' : '';
  const winRate = metrics?.count > 0 ? ((metrics.wins / metrics.count) * 100).toFixed(0) : null;

  return (
    <div className={`rounded-lg p-3 transition-all duration-300 ${
      isActive
        ? 'bg-accent-green/[0.08] border border-accent-green/20'
        : 'bg-white/[0.02] hover:bg-white/[0.05] border border-transparent'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`inline-block w-2 h-2 rounded-full ${
            isActive
              ? 'bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse-slow'
              : 'bg-white/15'
          }`} />
          <span className={`text-xs font-medium ${isActive ? 'text-white' : 'text-white/50'}`}>
            {name}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {metrics && metrics.count > 0 && (
            <span className={`text-[10px] font-bold ${pnlColor}`}>
              {pnlSign}${pnl.toFixed(2)}
            </span>
          )}
          {isActive ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-green/20 text-accent-green font-semibold">
              ACTIVE
            </span>
          ) : (
            <button
              onClick={() => onActivate(name)}
              disabled={activating}
              className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/30 hover:text-white/60 hover:bg-white/10 transition-all duration-300 disabled:opacity-50"
            >
              {activating ? '...' : 'activate'}
            </button>
          )}
        </div>
      </div>
      {metrics && metrics.count > 0 && (
        <div className="flex items-center gap-3 mt-1.5 ml-5 text-[9px] text-white/25">
          <span>{metrics.count} trades</span>
          <span className="text-accent-green/60">{metrics.wins}W</span>
          <span className="text-accent-red/60">{metrics.losses}L</span>
          {winRate !== null && <span>WR: {winRate}%</span>}
        </div>
      )}
    </div>
  );
}

export default function StrategiesPanel({ state }) {
  const [activating, setActivating] = useState(false);
  const [tradeMetrics, setTradeMetrics] = useState({});
  const active = state?.activeStrategy;
  const loaded = state?.loadedStrategies || [];
  const available = state?.availableStrategies || [];

  // Combine loaded + available, deduplicate
  const allStrategies = [...new Set([...loaded, ...available])];

  const handleActivate = useCallback(async (name) => {
    setActivating(true);
    await setActiveStrategy(name);
    setActivating(false);
  }, []);

  // Fetch trade metrics per strategy
  useEffect(() => {
    async function fetchMetrics() {
      try {
        const res = await fetch('/api/trades');
        const data = await res.json();
        const trades = data.trades || [];
        const byStrategy = {};
        for (const t of trades) {
          const sid = t.strategy_id || t.strategyId || 'unknown';
          if (!byStrategy[sid]) {
            byStrategy[sid] = { count: 0, pnl: 0, wins: 0, losses: 0 };
          }
          byStrategy[sid].count++;
          const pnl = Number(t.realized_pnl || t.realizedPnl || t.pnl || 0);
          byStrategy[sid].pnl += pnl;
          if (pnl > 0) byStrategy[sid].wins++;
          else if (pnl < 0) byStrategy[sid].losses++;
        }
        setTradeMetrics(byStrategy);
      } catch {
        // Ignore
      }
    }
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="glass p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title">Strategies</h2>
        <span className="text-[10px] text-white/25">{allStrategies.length} loaded</span>
      </div>

      {allStrategies.length === 0 ? (
        <p className="text-xs text-white/30">No strategies loaded</p>
      ) : (
        <div className="space-y-1">
          {allStrategies.map((name) => (
            <StrategyRow
              key={name}
              name={name}
              isActive={name === active}
              onActivate={handleActivate}
              activating={activating}
              metrics={tradeMetrics[name]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
