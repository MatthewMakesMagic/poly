import React from 'react';

export default function RuntimeControls({ controls, onRefresh }) {
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
        <div className="space-y-2">
          {controls.map((ctrl) => (
            <div
              key={ctrl.key}
              className="flex items-center justify-between py-2 px-3 rounded bg-bg-tertiary/30"
            >
              <span className="text-xs text-gray-300 font-semibold">{ctrl.key}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 font-mono">{ctrl.value}</span>
                {ctrl.updated_at && (
                  <span className="text-xs text-gray-600">
                    {new Date(ctrl.updated_at).toLocaleTimeString('en-US', { hour12: false })}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
