import React, { useMemo, useState } from 'react';
import { runBacktest } from '../../lib/backtestEngine.js';

const SYMBOLS = ['ALL', 'BTC', 'ETH', 'SOL', 'XRP'];
const MODES = ['Win Rate', 'EV', 'Trades'];

function getETHour(closeTime) {
  return (new Date(closeTime).getUTCHours() - 5 + 24) % 24;
}

function interpolateColor(value, min, mid, max) {
  // value in [min, max], mid is neutral point
  if (value <= min) return 'hsl(0, 70%, 30%)';
  if (value >= max) return 'hsl(140, 70%, 30%)';
  if (value <= mid) {
    const t = (value - min) / (mid - min);
    const h = 0;
    const s = 70 - t * 70;
    const l = 30 + t * 10;
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  const t = (value - mid) / (max - mid);
  const h = t * 140;
  const s = t * 70;
  const l = 40 - t * 10;
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function getCellColor(cell, mode, maxTrades) {
  if (!cell || cell.trades === 0) return 'rgba(255,255,255,0.03)';

  if (mode === 'Win Rate') {
    return interpolateColor(cell.winRate, 0.45, 0.50, 0.55);
  }
  if (mode === 'EV') {
    const avgPnl = cell.pnl / cell.trades;
    return interpolateColor(avgPnl, -0.05, 0, 0.05);
  }
  // Trades mode: darker for fewer, brighter for more
  const t = maxTrades > 0 ? cell.trades / maxTrades : 0;
  const l = 15 + t * 30;
  return `hsl(220, 40%, ${l}%)`;
}

function formatCellValue(cell, mode) {
  if (!cell || cell.trades === 0) return '-';

  if (mode === 'Win Rate') {
    return `${(cell.winRate * 100).toFixed(0)}%`;
  }
  if (mode === 'EV') {
    const avgPnl = cell.pnl / cell.trades;
    return `${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(3)}`;
  }
  return `${cell.trades}`;
}

export default React.memo(function TimingHeatmap({ windows, filters }) {
  const [mode, setMode] = useState('Win Rate');

  const { grid, maxTrades } = useMemo(() => {
    if (!windows || windows.length === 0) {
      return { grid: [], maxTrades: 0 };
    }

    const result = runBacktest(windows, filters);
    const trades = result.trades || [];

    // Build 2D grid: 24 hours x 5 symbols
    const g = Array.from({ length: 24 }, () =>
      Object.fromEntries(SYMBOLS.map((s) => [s, { trades: 0, wins: 0, winRate: 0, pnl: 0 }]))
    );

    for (const trade of trades) {
      const hour = getETHour(trade.closeTime);
      const sym = (trade.symbol || '').toUpperCase();

      // ALL column
      g[hour]['ALL'].trades += 1;
      g[hour]['ALL'].wins += trade.won ? 1 : 0;
      g[hour]['ALL'].pnl += trade.pnl || 0;

      // Symbol column
      if (SYMBOLS.includes(sym)) {
        g[hour][sym].trades += 1;
        g[hour][sym].wins += trade.won ? 1 : 0;
        g[hour][sym].pnl += trade.pnl || 0;
      }
    }

    // Compute win rates
    let mt = 0;
    for (let h = 0; h < 24; h++) {
      for (const sym of SYMBOLS) {
        const cell = g[h][sym];
        cell.winRate = cell.trades > 0 ? cell.wins / cell.trades : 0;
        if (cell.trades > mt) mt = cell.trades;
      }
    }

    return { grid: g, maxTrades: mt };
  }, [windows, filters]);

  if (!grid || grid.length === 0) {
    return (
      <div className="glass p-5">
        <h3 className="section-title mb-4">Timing Heatmap (ET)</h3>
        <p className="text-white/40 text-xs">No windows loaded.</p>
      </div>
    );
  }

  return (
    <div className="glass p-5">
      <h3 className="section-title mb-4">Timing Heatmap (ET)</h3>

      {/* Mode toggle */}
      <div className="flex items-center gap-2 mb-4">
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-300 ${
              mode === m
                ? 'bg-white/10 text-white border border-white/10'
                : 'text-white/40 hover:text-white/60 hover:bg-white/5 border border-transparent'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Heatmap grid */}
      <div className="grid grid-cols-6 gap-px">
        {/* Header row */}
        <div className="label-xs text-white/40 flex items-center justify-center py-1">Hour</div>
        {SYMBOLS.map((sym) => (
          <div key={sym} className="label-xs text-white/40 flex items-center justify-center py-1">
            {sym}
          </div>
        ))}

        {/* Data rows */}
        {grid.map((row, hour) => (
          <React.Fragment key={hour}>
            <div className="label-xs text-white/50 flex items-center justify-center" style={{ minHeight: 24 }}>
              {hour}:00
            </div>
            {SYMBOLS.map((sym) => {
              const cell = row[sym];
              const bg = getCellColor(cell, mode, maxTrades);
              return (
                <div
                  key={sym}
                  className="rounded-sm flex items-center justify-center"
                  style={{ backgroundColor: bg, minHeight: 24 }}
                >
                  <span className="text-[9px] text-white">
                    {formatCellValue(cell, mode)}
                  </span>
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
});
