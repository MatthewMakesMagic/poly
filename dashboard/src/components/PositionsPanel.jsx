import React from 'react';

const LIFECYCLE_COLORS = {
  MONITORING: 'text-accent-green',
  STOP_TRIGGERED: 'text-accent-red',
  TP_TRIGGERED: 'text-accent-green',
  EXIT_PENDING: 'text-accent-yellow',
  EXPIRY: 'text-accent-yellow',
  SETTLEMENT: 'text-accent-yellow',
  CLOSED: 'text-white/30',
  ENTRY: 'text-accent-blue',
};

function PositionRow({ pos }) {
  const pnl = pos.unrealized_pnl ?? pos.unrealizedPnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
  const pnlSign = pnl > 0 ? '+' : '';

  const entry = pos.entry_price ?? pos.entryPrice ?? 0;
  const current = pos.current_price ?? pos.currentPrice ?? entry;
  const side = (pos.side || pos.direction || '').toUpperCase();
  const sideColor = side === 'UP' || side === 'LONG' ? 'text-accent-green' : 'text-accent-red';
  const lifecycle = pos.lifecycle_state || pos.lifecycleState || '--';
  const lifecycleColor = LIFECYCLE_COLORS[lifecycle] || 'text-white/30';

  return (
    <tr className="border-t border-white/5 hover:bg-white/[0.03] transition-colors duration-200">
      <td className="py-3 px-3 text-xs text-white/70">{pos.window_id || pos.windowId || '--'}</td>
      <td className={`py-3 px-3 text-xs font-bold ${sideColor}`}>{side}</td>
      <td className="py-3 px-3 text-xs text-white/50">${Number(entry).toFixed(2)}</td>
      <td className="py-3 px-3 text-xs text-white/80">${Number(current).toFixed(2)}</td>
      <td className={`py-3 px-3 text-xs font-bold ${pnlColor}`}>
        {pnlSign}${Number(pnl).toFixed(2)}
      </td>
      <td className={`py-3 px-3 text-[10px] font-mono ${lifecycleColor}`}>{lifecycle}</td>
      <td className="py-3 px-3 text-xs text-white/30">{pos.strategy_id || pos.strategyId || '--'}</td>
    </tr>
  );
}

export default function PositionsPanel({ state }) {
  const positions = state?.openPositions || [];

  return (
    <div className="glass p-5 h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title">Open Positions</h2>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
          positions.length > 0
            ? 'bg-accent-violet/20 text-accent-violet'
            : 'bg-white/5 text-white/25'
        }`}>
          {positions.length}
        </span>
      </div>

      {positions.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-xs text-white/20">No open positions</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="label-xs">
                <th className="pb-3 px-3 font-medium">Window</th>
                <th className="pb-3 px-3 font-medium">Side</th>
                <th className="pb-3 px-3 font-medium">Entry</th>
                <th className="pb-3 px-3 font-medium">Current</th>
                <th className="pb-3 px-3 font-medium">P&L</th>
                <th className="pb-3 px-3 font-medium">State</th>
                <th className="pb-3 px-3 font-medium">Strategy</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos, i) => (
                <PositionRow key={pos.id || i} pos={pos} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
