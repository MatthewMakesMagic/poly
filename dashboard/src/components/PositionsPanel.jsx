import React from 'react';

const LIFECYCLE_COLORS = {
  MONITORING: 'text-accent-green',
  STOP_TRIGGERED: 'text-accent-red',
  TP_TRIGGERED: 'text-accent-green',
  EXIT_PENDING: 'text-yellow-400',
  EXPIRY: 'text-yellow-400',
  SETTLEMENT: 'text-yellow-400',
  CLOSED: 'text-gray-500',
  ENTRY: 'text-blue-400',
};

function PositionRow({ pos }) {
  const pnl = pos.unrealized_pnl ?? pos.unrealizedPnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-gray-400';
  const pnlSign = pnl > 0 ? '+' : '';

  const entry = pos.entry_price ?? pos.entryPrice ?? 0;
  const current = pos.current_price ?? pos.currentPrice ?? entry;
  const side = (pos.side || pos.direction || '').toUpperCase();
  const sideColor = side === 'UP' || side === 'LONG' ? 'text-accent-green' : 'text-accent-red';
  const lifecycle = pos.lifecycle_state || pos.lifecycleState || '--';
  const lifecycleColor = LIFECYCLE_COLORS[lifecycle] || 'text-gray-500';

  return (
    <tr className="border-t border-gray-700/50 hover:bg-bg-tertiary/30">
      <td className="py-2 px-2 text-sm text-gray-300">{pos.window_id || pos.windowId || '--'}</td>
      <td className={`py-2 px-2 text-sm font-semibold ${sideColor}`}>{side}</td>
      <td className="py-2 px-2 text-sm text-gray-400">${Number(entry).toFixed(2)}</td>
      <td className="py-2 px-2 text-sm text-gray-300">${Number(current).toFixed(2)}</td>
      <td className={`py-2 px-2 text-sm font-semibold ${pnlColor}`}>
        {pnlSign}${Number(pnl).toFixed(2)}
      </td>
      <td className={`py-2 px-2 text-xs font-mono ${lifecycleColor}`}>{lifecycle}</td>
      <td className="py-2 px-2 text-sm text-gray-500">{pos.strategy_id || pos.strategyId || '--'}</td>
    </tr>
  );
}

export default function PositionsPanel({ state }) {
  const positions = state?.openPositions || [];

  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4 h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Open Positions
        </h2>
        <span className="text-xs text-gray-500">
          {positions.length} open
        </span>
      </div>

      {positions.length === 0 ? (
        <p className="text-xs text-gray-500">No open positions</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-gray-500 uppercase">
                <th className="pb-2 px-2">Window</th>
                <th className="pb-2 px-2">Side</th>
                <th className="pb-2 px-2">Entry</th>
                <th className="pb-2 px-2">Current</th>
                <th className="pb-2 px-2">P&L</th>
                <th className="pb-2 px-2">State</th>
                <th className="pb-2 px-2">Strategy</th>
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
