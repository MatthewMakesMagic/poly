import React, { useState, useEffect, useCallback } from 'react';

async function setActiveStrategy(strategyName) {
  const res = await fetch('/api/controls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'active_strategy', value: strategyName }),
  });
  return res.ok;
}

function ModeMetrics({ mode, data }) {
  const pnl = data.total_pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/25';
  const pnlSign = pnl > 0 ? '+' : '';

  return (
    <div className="flex items-center gap-3 mt-1.5 ml-5 text-[9px] text-white/25">
      <span className={`font-bold ${mode === 'LIVE' ? 'text-accent-green/60' : 'text-accent-yellow/60'}`}>{mode}</span>
      <span>{data.total_trades} trades</span>
      <span>{data.win_rate} WR</span>
      <span className={pnlColor}>{pnlSign}${pnl.toFixed(2)}</span>
      <span>best: ${data.best_trade?.toFixed(2) ?? '--'}</span>
      <span>worst: ${data.worst_trade?.toFixed(2) ?? '--'}</span>
      {data.open_positions > 0 && (
        <span className="text-accent-blue/60">{data.open_positions} open</span>
      )}
    </div>
  );
}

function StrategyRow({ name, isActive, onActivate, activating, modes }) {
  const allPnl = Object.values(modes || {}).reduce((s, m) => s + (m.total_pnl ?? 0), 0);
  const pnlColor = allPnl > 0 ? 'text-accent-green' : allPnl < 0 ? 'text-accent-red' : 'text-white/25';
  const pnlSign = allPnl > 0 ? '+' : '';
  const totalTrades = Object.values(modes || {}).reduce((s, m) => s + (m.total_trades ?? 0), 0);

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
          {totalTrades > 0 && (
            <span className={`text-[10px] font-bold ${pnlColor}`}>
              {pnlSign}${allPnl.toFixed(2)}
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
      {modes && Object.entries(modes).map(([mode, data]) => (
        data.total_trades > 0 && <ModeMetrics key={mode} mode={mode} data={data} />
      ))}
    </div>
  );
}

export default React.memo(function StrategiesPanel({ state }) {
  const [activating, setActivating] = useState(false);
  const [strategyPerf, setStrategyPerf] = useState({});
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

  // Fetch pre-aggregated strategy performance
  useEffect(() => {
    async function fetchPerf() {
      try {
        const res = await fetch('/api/strategy-performance');
        const data = await res.json();
        const byStrategy = {};
        for (const s of (data.strategies || [])) {
          byStrategy[s.strategy_id] = s.modes || {};
        }
        setStrategyPerf(byStrategy);
      } catch {
        // Ignore
      }
    }
    fetchPerf();
    const interval = setInterval(fetchPerf, 15000);
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
              modes={strategyPerf[name]}
            />
          ))}
        </div>
      )}
    </div>
  );
})
