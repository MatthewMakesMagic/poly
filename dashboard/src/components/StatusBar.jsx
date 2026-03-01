import React from 'react';

function SystemStateIndicator({ systemState, tradingMode }) {
  const stateMap = {
    RUNNING: { label: 'RUNNING', color: 'bg-accent-green', text: 'text-accent-green', glow: 'shadow-[0_0_12px_rgba(52,211,153,0.4)]' },
    PAUSED: { label: 'PAUSED', color: 'bg-accent-yellow', text: 'text-accent-yellow', glow: 'shadow-[0_0_12px_rgba(251,191,36,0.4)]' },
    INITIALIZED: { label: 'STOPPED', color: 'bg-accent-red', text: 'text-accent-red', glow: 'shadow-[0_0_12px_rgba(248,113,113,0.4)]' },
    STOPPED: { label: 'STOPPED', color: 'bg-accent-red', text: 'text-accent-red', glow: 'shadow-[0_0_12px_rgba(248,113,113,0.4)]' },
    ERROR: { label: 'ERROR', color: 'bg-accent-red', text: 'text-accent-red', glow: 'shadow-[0_0_12px_rgba(248,113,113,0.4)]' },
  };

  const info = stateMap[systemState] || { label: systemState || '?', color: 'bg-white/20', text: 'text-white/50', glow: '' };
  const modeLabel = tradingMode === 'LIVE' ? 'LIVE' : 'PAPER';

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-3 h-3 rounded-full ${info.color} ${info.glow} animate-pulse`} />
        <span className={`text-lg font-bold ${info.text}`}>{info.label}</span>
      </div>
      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold tracking-wider ${
        tradingMode === 'LIVE'
          ? 'bg-accent-red/20 text-accent-red border border-accent-red/30'
          : 'bg-accent-blue/20 text-accent-blue border border-accent-blue/30'
      }`}>
        {modeLabel}
      </span>
    </div>
  );
}

export default function StatusBar({ state, connected }) {
  const balance = state?.balance;
  const pnl = state?.sessionPnl;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/60';
  const pnlSign = pnl > 0 ? '+' : '';
  const pnlGlow = pnl > 0 ? 'glow-green' : pnl < 0 ? 'glow-red' : '';

  return (
    <div className={`glass p-5 flex-1 ${pnlGlow}`}>
      <div className="flex items-center justify-between flex-wrap gap-4">
        <SystemStateIndicator
          systemState={state?.systemState}
          tradingMode={state?.tradingMode}
        />

        <div className="flex items-center gap-8">
          <div className="text-right">
            <div className="label-xs mb-1">Balance</div>
            <div className="value-lg">
              {balance != null ? `$${Number(balance).toFixed(2)}` : '--'}
            </div>
          </div>
          <div className="text-right">
            <div className="label-xs mb-1">Session P&L</div>
            <div className={`value-lg ${pnlColor}`}>
              {pnl != null ? `${pnlSign}$${Number(pnl).toFixed(2)}` : '--'}
            </div>
          </div>
          <div className="text-right">
            <div className="label-xs mb-1">Windows</div>
            <div className="value-lg">{state?.activeWindows ?? '--'}</div>
          </div>
          <div className="text-right">
            <div className="label-xs mb-1">Positions</div>
            <div className="value-lg">{state?.positionCount ?? state?.openPositions?.length ?? '--'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
