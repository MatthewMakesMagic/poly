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

  const inputClass = "bg-white/5 text-xs text-white/80 border border-white/10 rounded-lg px-3 py-1.5 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300";

  return (
    <div className="glass p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title">Runtime Controls</h2>
        <button
          onClick={onRefresh}
          className="text-[10px] text-white/25 hover:text-white/50 transition-colors duration-300 px-2 py-1 rounded-md hover:bg-white/5"
        >
          refresh
        </button>
      </div>

      {controls.length === 0 ? (
        <p className="text-xs text-white/20">
          No runtime controls available.
        </p>
      ) : (
        <div className="space-y-1">
          {controls.map((ctrl) => {
            const config = CONTROL_CONFIG[ctrl.key] || {};
            const isEditing = editing === ctrl.key;
            const valueColor = config.colors?.[ctrl.value] || 'text-white/60';

            return (
              <div
                key={ctrl.key}
                className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-all duration-300"
              >
                <span className="text-[10px] text-white/50 font-medium">
                  {config.label || ctrl.key}
                </span>

                {isEditing ? (
                  <div className="flex items-center gap-2">
                    {config.type === 'select' ? (
                      <select
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className={`${inputClass} w-36`}
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
                        className={`${inputClass} w-20`}
                      />
                    ) : (
                      <input
                        type="text"
                        value={editValue}
                        placeholder={config.placeholder}
                        onChange={(e) => setEditValue(e.target.value)}
                        className={`${inputClass} w-32`}
                      />
                    )}
                    <button
                      onClick={() => saveEdit(ctrl.key)}
                      disabled={saving || editValue === ctrl.value}
                      className="text-[10px] px-3 py-1.5 rounded-lg bg-accent-violet/20 text-accent-violet font-semibold hover:bg-accent-violet/30 border border-accent-violet/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-300"
                    >
                      {saving ? '...' : 'Save'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-[10px] px-2 py-1.5 rounded-lg text-white/30 hover:text-white/50 hover:bg-white/5 transition-all duration-300"
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
                      className="text-[10px] px-2 py-1 rounded-md text-white/15 hover:text-accent-violet hover:bg-accent-violet/10 transition-all duration-300"
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
