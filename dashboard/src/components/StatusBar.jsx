import React from 'react';

function SystemStateIndicator({ systemState, tradingMode }) {
  const stateMap = {
    RUNNING: { label: 'LIVE', color: 'bg-accent-green', text: 'text-accent-green' },
    PAUSED: { label: 'PAUSED', color: 'bg-accent-yellow', text: 'text-accent-yellow' },
    INITIALIZED: { label: 'STOPPED', color: 'bg-accent-red', text: 'text-accent-red' },
    STOPPED: { label: 'STOPPED', color: 'bg-accent-red', text: 'text-accent-red' },
    ERROR: { label: 'ERROR', color: 'bg-accent-red', text: 'text-accent-red' },
  };

  const info = stateMap[systemState] || { label: systemState || '?', color: 'bg-gray-500', text: 'text-gray-500' };
  const modeLabel = tradingMode === 'LIVE' ? 'LIVE' : 'PAPER';

  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-3 h-3 rounded-full ${info.color} animate-pulse`} />
      <span className={`font-bold ${info.text}`}>{info.label}</span>
      <span className="text-gray-500">|</span>
      <span className={`text-xs px-1.5 py-0.5 rounded ${
        tradingMode === 'LIVE'
          ? 'bg-red-900/50 text-accent-red border border-red-700'
          : 'bg-yellow-900/30 text-accent-yellow border border-yellow-700'
      }`}>
        {modeLabel}
      </span>
    </div>
  );
}

export default function StatusBar({ state, connected }) {
  const balance = state?.balance;
  const pnl = state?.sessionPnl;
  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-gray-300';
  const pnlSign = pnl > 0 ? '+' : '';

  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 px-4 py-3 flex-1">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <SystemStateIndicator
          systemState={state?.systemState}
          tradingMode={state?.tradingMode}
        />

        <div className="flex items-center gap-6 text-sm">
          <div>
            <span className="text-gray-500 mr-1">Balance:</span>
            <span className="text-gray-200 font-semibold">
              {balance != null ? `$${Number(balance).toFixed(2)}` : '--'}
            </span>
          </div>
          <div>
            <span className="text-gray-500 mr-1">Session P&L:</span>
            <span className={`font-semibold ${pnlColor}`}>
              {pnl != null ? `${pnlSign}$${Number(pnl).toFixed(2)}` : '--'}
            </span>
          </div>
          <div>
            <span className="text-gray-500 mr-1">Windows:</span>
            <span className="text-gray-200">{state?.activeWindows ?? '--'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
