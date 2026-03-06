import React, { useState, useEffect, useCallback } from 'react';

export default React.memo(function StrategyPerformanceCards() {
  const [strategies, setStrategies] = useState([]);
  const [error, setError] = useState(null);

  const fetchPerformance = useCallback(async () => {
    try {
      const res = await fetch('/api/strategy-performance');
      const data = await res.json();
      setStrategies(data.strategies || []);
      setError(null);
    } catch {
      setError('Failed to load');
    }
  }, []);

  useEffect(() => {
    fetchPerformance();
    const interval = setInterval(fetchPerformance, 15000);
    return () => clearInterval(interval);
  }, [fetchPerformance]);

  if (error) {
    return (
      <div className="glass p-5">
        <h2 className="section-title mb-4">Strategy Performance</h2>
        <p className="text-xs text-accent-red/70">{error}</p>
      </div>
    );
  }

  if (strategies.length === 0) {
    return (
      <div className="glass p-5">
        <h2 className="section-title mb-4">Strategy Performance</h2>
        <div className="py-8 text-center">
          <p className="text-xs text-white/20">No strategy data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass p-5">
      <h2 className="section-title mb-4">Strategy Performance</h2>
      <div className="space-y-3">
        {strategies.map((s) => (
          <StrategyCard key={s.strategy_id} strategy={s} />
        ))}
      </div>
    </div>
  );
});

function StrategyCard({ strategy }) {
  const modes = Object.entries(strategy.modes || {});

  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-white/90">{strategy.strategy_id}</span>
        <div className="flex gap-1 ml-auto">
          {modes.map(([mode]) => (
            <span
              key={mode}
              className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                mode === 'LIVE'
                  ? 'bg-accent-red/20 text-accent-red border border-accent-red/30'
                  : 'bg-accent-blue/20 text-accent-blue border border-accent-blue/30'
              }`}
            >
              {mode}
            </span>
          ))}
        </div>
      </div>

      {modes.map(([mode, data]) => (
        <ModeStats key={mode} mode={mode} data={data} />
      ))}
    </div>
  );
}

function ModeStats({ mode, data }) {
  const pnl = Number(data.total_pnl || 0);
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
  const pnlSign = pnl > 0 ? '+' : '';

  const winRateStr = data.win_rate || '0%';
  const winRateNum = parseFloat(winRateStr) || 0;

  const avgPnl = Number(data.avg_pnl || 0);
  const bestTrade = Number(data.best_trade || 0);
  const worstTrade = Number(data.worst_trade || 0);
  const openPositions = Number(data.open_positions || 0);

  const activeSince = data.first_trade
    ? new Date(data.first_trade).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '--';

  return (
    <div className="space-y-2">
      {/* Mode label + P&L */}
      <div className="flex items-center justify-between">
        <span className={`text-[10px] font-semibold ${
          mode === 'LIVE' ? 'text-accent-red/60' : 'text-accent-blue/60'
        }`}>
          {mode}
        </span>
        <span className={`text-sm font-bold ${pnlColor}`}>
          {pnlSign}${pnl.toFixed(2)}
        </span>
      </div>

      {/* Win rate bar */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-white/30 w-8 shrink-0">WR</span>
        <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full bg-accent-green/60 transition-all duration-500"
            style={{ width: `${Math.min(winRateNum, 100)}%` }}
          />
        </div>
        <span className="text-[10px] text-white/50 w-10 text-right">{winRateStr}</span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-[10px]">
        <StatItem label="Trades" value={data.total_trades || 0} />
        <StatItem label="Wins" value={data.wins || 0} className="text-accent-green/70" />
        <StatItem label="Losses" value={data.losses || 0} className="text-accent-red/70" />
        <StatItem label="Avg P&L" value={`$${avgPnl.toFixed(2)}`} className={avgPnl >= 0 ? 'text-accent-green/70' : 'text-accent-red/70'} />
        <StatItem label="Best" value={`$${bestTrade.toFixed(2)}`} className="text-accent-green/70" />
        <StatItem label="Worst" value={`$${worstTrade.toFixed(2)}`} className="text-accent-red/70" />
      </div>

      {/* Footer: open positions + active since */}
      <div className="flex items-center justify-between text-[10px] text-white/25 pt-1 border-t border-white/5">
        {openPositions > 0 ? (
          <span className="text-accent-yellow/70">{openPositions} open position{openPositions !== 1 ? 's' : ''}</span>
        ) : (
          <span>No open positions</span>
        )}
        <span>Active since {activeSince}</span>
      </div>
    </div>
  );
}

function StatItem({ label, value, className = 'text-white/50' }) {
  return (
    <div className="flex justify-between">
      <span className="text-white/25">{label}</span>
      <span className={className}>{value}</span>
    </div>
  );
}
