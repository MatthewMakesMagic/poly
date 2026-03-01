import React, { useState } from 'react';

const CONTROL_CONFIG = {
  kill_switch: {
    label: 'Kill Switch',
    type: 'select',
    options: ['off', 'pause', 'flatten', 'emergency'],
    colors: { off: 'text-accent-green', pause: 'text-accent-yellow', flatten: 'text-accent-red', emergency: 'text-accent-red' },
  },
  trading_mode: {
    label: 'Trading Mode',
    type: 'select',
    options: ['PAPER', 'LIVE', 'DRY_RUN'],
    colors: { PAPER: 'text-accent-blue', LIVE: 'text-accent-red', DRY_RUN: 'text-accent-yellow' },
    confirm: 'LIVE',
  },
  active_strategy: {
    label: 'Active Strategy',
    type: 'select',
    options: ['always-trade-canary', 'oracle-edge-only', 'lag-based', 'probability-only', 'hybrid', 'none'],
  },
  max_position_usd: {
    label: 'Max Position ($)',
    type: 'number',
    min: 1,
    max: 100,
  },
  max_session_loss: {
    label: 'Max Session Loss ($)',
    type: 'number',
    min: 1,
    max: 500,
  },
  allowed_instruments: {
    label: 'Allowed Instruments',
    type: 'text',
    placeholder: '* or BTC,ETH,SOL',
  },
  allowed_strategies: {
    label: 'Allowed Strategies',
    type: 'text',
    placeholder: '* or canary,hybrid',
  },
};

async function updateControl(key, value) {
  const res = await fetch('/api/controls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  return res.ok;
}

export default function RuntimeControls({ controls, onRefresh }) {
  const [editing, setEditing] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = (key, currentValue) => {
    setEditing(key);
    setEditValue(currentValue);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditValue('');
  };

  const saveEdit = async (key) => {
    const config = CONTROL_CONFIG[key];
    if (config?.confirm && editValue === config.confirm) {
      if (!window.confirm(`Are you sure you want to set ${key} to ${editValue}? This could affect real money.`)) {
        return;
      }
    }
    setSaving(true);
    const ok = await updateControl(key, editValue);
    setSaving(false);
    if (ok) {
      cancelEdit();
      onRefresh();
    }
  };

  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Runtime Controls
        </h2>
        <button
          onClick={onRefresh}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          refresh
        </button>
      </div>

      {controls.length === 0 ? (
        <p className="text-xs text-gray-500">
          No runtime controls available. The runtime_controls table may not exist yet.
        </p>
      ) : (
        <div className="space-y-1">
          {controls.map((ctrl) => {
            const config = CONTROL_CONFIG[ctrl.key] || {};
            const isEditing = editing === ctrl.key;
            const valueColor = config.colors?.[ctrl.value] || 'text-gray-400';

            return (
              <div
                key={ctrl.key}
                className="flex items-center justify-between py-2 px-3 rounded bg-bg-tertiary/30"
              >
                <span className="text-xs text-gray-300 font-semibold">
                  {config.label || ctrl.key}
                </span>

                {isEditing ? (
                  <div className="flex items-center gap-2">
                    {config.type === 'select' ? (
                      <select
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="bg-bg-primary text-xs text-gray-200 border border-gray-600 rounded px-2 py-1 focus:outline-none focus:border-accent-blue"
                      >
                        {config.options.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : config.type === 'number' ? (
                      <input
                        type="number"
                        value={editValue}
                        min={config.min}
                        max={config.max}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="bg-bg-primary text-xs text-gray-200 border border-gray-600 rounded px-2 py-1 w-20 focus:outline-none focus:border-accent-blue"
                      />
                    ) : (
                      <input
                        type="text"
                        value={editValue}
                        placeholder={config.placeholder}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="bg-bg-primary text-xs text-gray-200 border border-gray-600 rounded px-2 py-1 w-32 focus:outline-none focus:border-accent-blue"
                      />
                    )}
                    <button
                      onClick={() => saveEdit(ctrl.key)}
                      disabled={saving || editValue === ctrl.value}
                      className="text-xs px-2 py-1 rounded bg-accent-blue text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {saving ? '...' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-xs px-2 py-1 rounded text-gray-400 hover:text-gray-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono font-bold ${valueColor}`}>
                      {ctrl.value}
                    </span>
                    <button
                      onClick={() => startEdit(ctrl.key, ctrl.value)}
                      className="text-xs text-gray-600 hover:text-accent-blue transition-colors"
                    >
                      edit
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
