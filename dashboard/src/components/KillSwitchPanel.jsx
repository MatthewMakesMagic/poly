import React, { useState, useCallback } from 'react';

async function postControl(action) {
  const res = await fetch(`/api/controls/${action}`, { method: 'POST' });
  return res.json();
}

export default function KillSwitchPanel({ state }) {
  const [loading, setLoading] = useState(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const handleAction = useCallback(async (action) => {
    setLoading(action);
    try {
      await postControl(action);
    } catch {
      // Ignore errors
    } finally {
      setLoading(null);
      setConfirmStop(false);
    }
  }, []);

  const isPaused = state?.systemState === 'PAUSED';
  const isStopped = state?.systemState === 'STOPPED' || state?.systemState === 'INITIALIZED';

  return (
    <div className="glass p-5 flex items-center gap-3">
      <div className="section-title mr-3">Controls</div>

      {isPaused ? (
        <button
          onClick={() => handleAction('resume')}
          disabled={loading === 'resume'}
          className="px-5 py-2 bg-accent-green/20 hover:bg-accent-green/30 text-accent-green text-xs font-bold rounded-lg border border-accent-green/30 transition-all duration-300 disabled:opacity-50 hover:shadow-[0_0_20px_rgba(52,211,153,0.2)]"
        >
          {loading === 'resume' ? '...' : 'RESUME'}
        </button>
      ) : (
        <button
          onClick={() => handleAction('pause')}
          disabled={loading === 'pause' || isStopped}
          className="px-5 py-2 bg-accent-yellow/20 hover:bg-accent-yellow/30 text-accent-yellow text-xs font-bold rounded-lg border border-accent-yellow/30 transition-all duration-300 disabled:opacity-50 hover:shadow-[0_0_20px_rgba(251,191,36,0.2)]"
        >
          {loading === 'pause' ? '...' : 'PAUSE'}
        </button>
      )}

      {confirmStop ? (
        <div className="flex items-center gap-2">
          <span className="text-accent-red text-xs font-semibold animate-pulse">Confirm stop?</span>
          <button
            onClick={() => handleAction('stop')}
            disabled={loading === 'stop'}
            className="px-4 py-2 bg-accent-red/30 hover:bg-accent-red/40 text-accent-red text-xs font-bold rounded-lg border border-accent-red/40 transition-all duration-300 shadow-[0_0_20px_rgba(248,113,113,0.2)]"
          >
            YES STOP
          </button>
          <button
            onClick={() => setConfirmStop(false)}
            className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/50 text-xs rounded-lg border border-white/10 transition-all duration-300"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmStop(true)}
          disabled={isStopped}
          className="px-5 py-2 bg-accent-red/10 hover:bg-accent-red/20 text-accent-red text-xs font-bold rounded-lg border border-accent-red/20 transition-all duration-300 disabled:opacity-50 hover:shadow-[0_0_20px_rgba(248,113,113,0.2)]"
        >
          EMERGENCY STOP
        </button>
      )}
    </div>
  );
}
