import React from 'react';

function StrategyRow({ name, isActive }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-bg-tertiary/50">
      <span className={`text-sm ${isActive ? 'text-accent-green' : 'text-gray-500'}`}>
        {isActive ? '[active]' : '[--]'}
      </span>
      <span className={`text-sm ${isActive ? 'text-gray-200' : 'text-gray-400'}`}>
        {name}
      </span>
    </div>
  );
}

export default function StrategiesPanel({ state }) {
  const active = state?.activeStrategy;
  const loaded = state?.loadedStrategies || [];
  const available = state?.availableStrategies || [];

  // Combine loaded + available, deduplicate
  const allStrategies = [...new Set([...loaded, ...available])];

  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4 h-full">
      <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
        Strategies
      </h2>

      {allStrategies.length === 0 ? (
        <p className="text-xs text-gray-500">No strategies loaded</p>
      ) : (
        <div className="space-y-0.5">
          {allStrategies.map((name) => (
            <StrategyRow key={name} name={name} isActive={name === active} />
          ))}
        </div>
      )}
    </div>
  );
}
