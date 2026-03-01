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
    <div className="bg-bg-secondary rounded-lg border border-gray-700 px-4 py-3 flex items-center gap-3">
      {isPaused ? (
        <button
          onClick={() => handleAction('resume')}
          disabled={loading === 'resume'}
          className="px-4 py-1.5 bg-green-700 hover:bg-green-600 text-white text-sm rounded font-semibold transition-colors disabled:opacity-50"
        >
          {loading === 'resume' ? '...' : 'RESUME'}
        </button>
      ) : (
        <button
          onClick={() => handleAction('pause')}
          disabled={loading === 'pause' || isStopped}
          className="px-4 py-1.5 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded font-semibold transition-colors disabled:opacity-50"
        >
          {loading === 'pause' ? '...' : 'PAUSE'}
        </button>
      )}

      {confirmStop ? (
        <div className="flex items-center gap-2">
          <span className="text-accent-red text-xs">Confirm?</span>
          <button
            onClick={() => handleAction('stop')}
            disabled={loading === 'stop'}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm rounded font-semibold transition-colors"
          >
            YES STOP
          </button>
          <button
            onClick={() => setConfirmStop(false)}
            className="px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmStop(true)}
          disabled={isStopped}
          className="px-4 py-1.5 bg-red-900 hover:bg-red-800 text-accent-red text-sm rounded font-semibold border border-red-700 transition-colors disabled:opacity-50"
        >
          EMERGENCY STOP
        </button>
      )}
    </div>
  );
}
