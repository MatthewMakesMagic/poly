import React, { useState, useCallback } from 'react';

const ACTIONS = [
  {
    id: 'reset-cb',
    label: 'Reset Circuit Breaker',
    description: 'Clears circuit breaker trip state, re-enabling trading after a CB halt.',
    endpoint: '/api/controls/reset-cb',
    styles: {
      text: 'text-accent-yellow',
      textLabel: 'text-accent-yellow/90',
      bg: 'bg-accent-yellow/15',
      bgHover: 'hover:bg-accent-yellow/25',
      bgConfirm: 'bg-accent-yellow/30',
      bgConfirmHover: 'hover:bg-accent-yellow/40',
      border: 'border-accent-yellow/20',
      borderConfirm: 'border-accent-yellow/40',
    },
  },
  {
    id: 'clear-entries',
    label: 'Clear Window Entries',
    description: 'Removes all pending window entries. Use if stale entries are blocking new trades.',
    endpoint: '/api/controls/clear-entries',
    styles: {
      text: 'text-accent-blue',
      textLabel: 'text-accent-blue/90',
      bg: 'bg-accent-blue/15',
      bgHover: 'hover:bg-accent-blue/25',
      bgConfirm: 'bg-accent-blue/30',
      bgConfirmHover: 'hover:bg-accent-blue/40',
      border: 'border-accent-blue/20',
      borderConfirm: 'border-accent-blue/40',
    },
  },
  {
    id: 'backfill-pnl',
    label: 'Backfill P&L',
    description: 'Recalculates realized P&L for all closed trades from on-chain resolution data.',
    endpoint: '/api/controls/backfill-pnl',
    styles: {
      text: 'text-accent-green',
      textLabel: 'text-accent-green/90',
      bg: 'bg-accent-green/15',
      bgHover: 'hover:bg-accent-green/25',
      bgConfirm: 'bg-accent-green/30',
      bgConfirmHover: 'hover:bg-accent-green/40',
      border: 'border-accent-green/20',
      borderConfirm: 'border-accent-green/40',
    },
  },
];

export default React.memo(function AdminActionsPanel() {
  return (
    <div className="glass p-5 space-y-3">
      <h2 className="section-title">Admin Actions</h2>
      {ACTIONS.map((action) => (
        <ActionButton key={action.id} action={action} />
      ))}
    </div>
  );
});

function ActionButton({ action }) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const execute = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(action.endpoint, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setResult({ ok: true, message: data.message || 'Done' });
      } else {
        setResult({ ok: false, message: data.error || `HTTP ${res.status}` });
      }
    } catch (err) {
      setResult({ ok: false, message: err.message || 'Request failed' });
    } finally {
      setLoading(false);
      setConfirming(false);
    }
  }, [action.endpoint]);

  const s = action.styles;

  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <span className={`text-xs font-bold ${s.textLabel}`}>{action.label}</span>
          <p className="text-[10px] text-white/30 mt-0.5">{action.description}</p>
        </div>

        {confirming ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className={`text-[10px] ${s.text} font-semibold animate-pulse`}>Confirm?</span>
            <button
              onClick={execute}
              disabled={loading}
              className={`px-3 py-1.5 ${s.bgConfirm} ${s.bgConfirmHover} ${s.text} text-[10px] font-bold rounded-lg border ${s.borderConfirm} transition-all duration-300 disabled:opacity-50`}
            >
              {loading ? '...' : 'YES'}
            </button>
            <button
              onClick={() => { setConfirming(false); setResult(null); }}
              className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/50 text-[10px] rounded-lg border border-white/10 transition-all duration-300"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setConfirming(true); setResult(null); }}
            className={`px-4 py-1.5 ${s.bg} ${s.bgHover} ${s.text} text-[10px] font-bold rounded-lg border ${s.border} transition-all duration-300 hover:shadow-[0_0_15px_rgba(255,255,255,0.05)] shrink-0`}
          >
            {action.label}
          </button>
        )}
      </div>

      {result && (
        <div className={`text-[10px] px-2 py-1 rounded ${
          result.ok
            ? 'bg-accent-green/10 text-accent-green/80'
            : 'bg-accent-red/10 text-accent-red/80'
        }`}>
          {result.message}
        </div>
      )}
    </div>
  );
}
