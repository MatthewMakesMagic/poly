import React from 'react';

function StatBox({ label, value, color = 'text-white/80' }) {
  return (
    <div className="glass-subtle p-3 text-center">
      <div className="label-xs mb-1">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

function OrderRow({ win }) {
  const hasPair = win.paired;
  const edge = win.pairEdge != null ? `$${Number(win.pairEdge).toFixed(4)}` : '--';

  return (
    <tr className="border-t border-white/5 hover:bg-white/[0.03] transition-colors duration-200">
      <td className="py-2.5 px-3 text-xs text-white/70 font-mono">{win.windowId?.slice(0, 20) || '--'}</td>
      <td className="py-2.5 px-3 text-xs text-white/50">{win.ticks ?? 0}</td>
      <td className="py-2.5 px-3 text-xs text-white/50">{win.signals ?? 0}</td>
      <td className="py-2.5 px-3 text-xs text-white/50">{win.resting ?? 0}</td>
      <td className="py-2.5 px-3 text-xs text-white/80">{win.fills ?? 0}</td>
      <td className="py-2.5 px-3 text-xs">
        {win.upCost != null && win.upCost > 0 ? (
          <span className="text-accent-green">${Number(win.upCost).toFixed(3)}</span>
        ) : (
          <span className="text-white/20">--</span>
        )}
        {' / '}
        {win.downCost != null && win.downCost > 0 ? (
          <span className="text-accent-red">${Number(win.downCost).toFixed(3)}</span>
        ) : (
          <span className="text-white/20">--</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-xs">
        {hasPair ? (
          <span className="text-accent-green font-bold">PAIRED</span>
        ) : (
          <span className="text-white/20">--</span>
        )}
      </td>
      <td className="py-2.5 px-3 text-xs font-mono">
        {hasPair ? (
          <span className={Number(win.pairEdge) >= 0 ? 'text-accent-green' : 'text-accent-red'}>
            {edge}
          </span>
        ) : (
          <span className="text-white/20">--</span>
        )}
      </td>
    </tr>
  );
}

export default function PassiveMmPanel({ state }) {
  const mmState = state?.modules?.['passive-mm'] || state?.['passive-mm'];

  if (!mmState || !mmState.initialized) {
    return (
      <div className="glass p-5">
        <h2 className="section-title mb-3">Passive MM</h2>
        <p className="text-xs text-white/20">Module not initialized</p>
      </div>
    );
  }

  const { activeWindows = [], stats = {}, config = {} } = mmState;
  const pnl = stats.cumulativePnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
  const pnlSign = pnl > 0 ? '+' : '';
  const fillRate = stats.ordersPlaced > 0
    ? ((stats.fills / stats.ordersPlaced) * 100).toFixed(1)
    : '0.0';

  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title">Passive MM</h2>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
            config.tradingMode === 'LIVE'
              ? 'bg-accent-green/20 text-accent-green'
              : 'bg-accent-yellow/20 text-accent-yellow'
          }`}>
            {config.tradingMode || 'PAPER'}
          </span>
          <span className="text-[10px] text-white/25">{config.crypto?.toUpperCase()}</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
        <StatBox label="Windows" value={stats.windowsTracked ?? 0} />
        <StatBox label="Fills" value={stats.fills ?? 0} />
        <StatBox label="Paired" value={stats.pairedFills ?? 0} color="text-accent-violet" />
        <StatBox label="Fill Rate" value={`${fillRate}%`} />
        <StatBox
          label="Cumulative P&L"
          value={`${pnlSign}$${Math.abs(pnl).toFixed(4)}`}
          color={pnlColor}
        />
      </div>

      {/* Active windows table */}
      <div className="flex items-center justify-between mb-2">
        <span className="label-xs">Active Windows</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
          activeWindows.length > 0
            ? 'bg-accent-blue/20 text-accent-blue'
            : 'bg-white/5 text-white/25'
        }`}>
          {activeWindows.length}
        </span>
      </div>

      {activeWindows.length === 0 ? (
        <div className="py-4 text-center">
          <p className="text-xs text-white/20">No active windows</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="label-xs">
                <th className="pb-2 px-3 font-medium">Window</th>
                <th className="pb-2 px-3 font-medium">Ticks</th>
                <th className="pb-2 px-3 font-medium">Signals</th>
                <th className="pb-2 px-3 font-medium">Resting</th>
                <th className="pb-2 px-3 font-medium">Fills</th>
                <th className="pb-2 px-3 font-medium">Up / Down Cost</th>
                <th className="pb-2 px-3 font-medium">Pair</th>
                <th className="pb-2 px-3 font-medium">Edge</th>
              </tr>
            </thead>
            <tbody>
              {activeWindows.map((win, i) => (
                <OrderRow key={win.windowId || i} win={win} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
