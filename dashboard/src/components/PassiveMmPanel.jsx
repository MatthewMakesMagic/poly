import React from 'react';

function StatBox({ label, value, color = 'text-white/80' }) {
  return (
    <div className="glass-subtle p-3 text-center">
      <div className="label-xs mb-1">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

function formatTimeLeft(ms) {
  if (ms == null || ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function RestingOrderPill({ order }) {
  const sideColor = order.side === 'up' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red';
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded ${sideColor}`}>
      {order.side.toUpperCase()} @{Number(order.price).toFixed(3)}
      <span className="text-white/20">${Number(order.capital).toFixed(1)}</span>
    </span>
  );
}

function FillPill({ fill }) {
  const sideColor = fill.side === 'up' ? 'text-accent-green' : 'text-accent-red';
  const ago = fill.filledAt ? Math.round((Date.now() - fill.filledAt) / 1000) : null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5">
      <span className={sideColor}>{fill.side.toUpperCase()}</span>
      @{Number(fill.price).toFixed(3)}
      {ago != null && <span className="text-white/15">{ago}s ago</span>}
    </span>
  );
}

function WindowCard({ win }) {
  const hasPair = win.paired;
  const edge = win.pairEdge != null ? Number(win.pairEdge).toFixed(4) : null;
  const timeLeft = formatTimeLeft(win.timeToCloseMs);
  const pctDone = win.timeToCloseMs != null
    ? Math.max(0, Math.min(100, 100 - (win.timeToCloseMs / (15 * 60 * 1000)) * 100))
    : 0;
  const restingOrders = win.restingOrderDetails || [];
  const fillDetails = win.fillDetails || [];
  const upResting = restingOrders.filter(o => o.side === 'up');
  const downResting = restingOrders.filter(o => o.side === 'down');
  const upFills = fillDetails.filter(f => f.side === 'up');
  const downFills = fillDetails.filter(f => f.side === 'down');

  return (
    <div className={`rounded-lg p-3 border transition-all duration-300 ${
      hasPair
        ? 'bg-accent-violet/[0.06] border-accent-violet/20'
        : 'bg-white/[0.02] border-white/5'
    }`}>
      {/* Header: Window ID + Time */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono text-white/50">{win.windowId?.slice(0, 24) || '--'}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white/70">{timeLeft}</span>
          {hasPair && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-accent-violet/20 text-accent-violet">
              PAIRED
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-full bg-white/5 mb-3 overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-blue/50 transition-all duration-1000"
          style={{ width: `${pctDone}%` }}
        />
      </div>

      {/* Tick/Signal stats */}
      <div className="flex items-center gap-4 text-[10px] text-white/30 mb-2">
        <span>{win.ticks ?? 0} ticks</span>
        <span>{win.signals ?? 0} signals</span>
        <span>{win.resting ?? 0} resting</span>
        <span>{win.fills ?? 0} fills</span>
        {edge != null && (
          <span className={Number(edge) >= 0 ? 'text-accent-green font-bold' : 'text-accent-red font-bold'}>
            Edge: ${edge}
          </span>
        )}
      </div>

      {/* Two-column: UP side / DOWN side */}
      <div className="grid grid-cols-2 gap-2">
        {/* UP Side */}
        <div className="rounded p-2 bg-accent-green/[0.03] border border-accent-green/10">
          <div className="text-[9px] font-semibold text-accent-green/60 mb-1">UP</div>
          {upResting.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {upResting.map(o => <RestingOrderPill key={o.id} order={o} />)}
            </div>
          )}
          {upFills.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {upFills.map((f, i) => <FillPill key={i} fill={f} />)}
            </div>
          )}
          {upResting.length === 0 && upFills.length === 0 && (
            <span className="text-[9px] text-white/15">No orders</span>
          )}
          {win.upCost > 0 && (
            <div className="text-[9px] text-accent-green/40 mt-1">
              Cost: ${Number(win.upCost).toFixed(3)}
            </div>
          )}
        </div>

        {/* DOWN Side */}
        <div className="rounded p-2 bg-accent-red/[0.03] border border-accent-red/10">
          <div className="text-[9px] font-semibold text-accent-red/60 mb-1">DOWN</div>
          {downResting.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {downResting.map(o => <RestingOrderPill key={o.id} order={o} />)}
            </div>
          )}
          {downFills.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {downFills.map((f, i) => <FillPill key={i} fill={f} />)}
            </div>
          )}
          {downResting.length === 0 && downFills.length === 0 && (
            <span className="text-[9px] text-white/15">No orders</span>
          )}
          {win.downCost > 0 && (
            <div className="text-[9px] text-accent-red/40 mt-1">
              Cost: ${Number(win.downCost).toFixed(3)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default React.memo(function PassiveMmPanel({ state }) {
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

      {/* Active windows */}
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
        <div className="space-y-2">
          {activeWindows.map((win, i) => (
            <WindowCard key={win.windowId || i} win={win} />
          ))}
        </div>
      )}
    </div>
  );
})
