import React, { useState, useEffect, useRef } from 'react';

const SYMBOL_COLORS = {
  btc: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  eth: { bg: 'bg-violet-500/20', text: 'text-violet-400', border: 'border-violet-500/30' },
  sol: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  xrp: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/30' },
};

const WINDOW_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function formatTime(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function getTimerColor(ms) {
  if (ms > 5 * 60 * 1000) return 'text-accent-green';
  if (ms > 60 * 1000) return 'text-accent-yellow';
  return 'text-accent-red';
}

function getBarColor(ms) {
  if (ms > 5 * 60 * 1000) return 'bg-accent-green';
  if (ms > 60 * 1000) return 'bg-accent-yellow';
  return 'bg-accent-red';
}

function getBarGlow(ms) {
  if (ms <= 30 * 1000) return 'shadow-[0_0_8px_rgba(248,113,113,0.6)]';
  return '';
}

function WindowCard({ window: w }) {
  const [remaining, setRemaining] = useState(w.time_remaining_ms || 0);
  const lastUpdateRef = useRef(Date.now());
  const baseRemainingRef = useRef(w.time_remaining_ms || 0);

  // Reset base when server sends new data
  useEffect(() => {
    baseRemainingRef.current = w.time_remaining_ms || 0;
    lastUpdateRef.current = Date.now();
    setRemaining(w.time_remaining_ms || 0);
  }, [w.time_remaining_ms]);

  // Tick down every second
  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = Date.now() - lastUpdateRef.current;
      const r = Math.max(0, baseRemainingRef.current - elapsed);
      setRemaining(r);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const sym = (w.crypto || '').toLowerCase();
  const colors = SYMBOL_COLORS[sym] || SYMBOL_COLORS.btc;
  const progressPct = Math.min(100, Math.max(0, (remaining / WINDOW_DURATION_MS) * 100));
  const isPulsing = remaining <= 30 * 1000 && remaining > 0;

  return (
    <div className={`glass-subtle p-3 ${isPulsing ? 'animate-pulse' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        {/* Symbol badge */}
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${colors.bg} ${colors.text} ${colors.border} uppercase`}>
          {sym || '??'}
        </span>
        {/* Countdown */}
        <span className={`text-lg font-bold font-mono ${getTimerColor(remaining)}`}>
          {formatTime(remaining)}
        </span>
      </div>

      {/* Market price if available */}
      {w.market_price != null && (
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-white/30">CLOB</span>
          <span className="text-xs font-semibold text-white/70">
            {Number(w.market_price).toFixed(2)}c
          </span>
        </div>
      )}

      {/* Progress bar */}
      <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${getBarColor(remaining)} ${getBarGlow(remaining)}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Window ID */}
      <div className="mt-1.5">
        <span className="text-[9px] text-white/15 font-mono truncate block">
          {w.window_id || ''}
        </span>
      </div>
    </div>
  );
}

export default React.memo(function WindowTimers({ state }) {
  const windows = state?.windowDetails || [];

  if (windows.length === 0) {
    return (
      <div className="glass-subtle p-4">
        <h2 className="section-title mb-2">Active Windows</h2>
        <p className="text-xs text-white/20">No active windows</p>
      </div>
    );
  }

  // Sort by time remaining ascending (most urgent first)
  const sorted = [...windows].sort((a, b) => (a.time_remaining_ms || 0) - (b.time_remaining_ms || 0));

  return (
    <div>
      <h2 className="section-title mb-3">Active Windows ({windows.length})</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {sorted.map((w) => (
          <WindowCard key={w.window_id || `${w.crypto}-${w.epoch}`} window={w} />
        ))}
      </div>
    </div>
  );
});
