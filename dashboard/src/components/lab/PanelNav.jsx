import React from 'react';

const PANELS = [
  { key: 'filter', label: 'Filter Workbench' },
  { key: 'matrix', label: 'Comparison' },
  { key: 'scatter', label: 'Scatter' },
  { key: 'oracle', label: 'Oracle Gap' },
  { key: 'timing', label: 'Timing' },
  { key: 'decay', label: 'Edge Decay' },
  { key: 'correlation', label: 'Correlation' },
  { key: 'ab', label: 'A/B Test' },
];

export default React.memo(function PanelNav({ activePanel, onSelect }) {
  return (
    <div className="glass p-3 flex items-center gap-2 flex-wrap">
      <span className="section-title mr-2">Panel</span>
      {PANELS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onSelect(key)}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-300 ${
            activePanel === key
              ? 'bg-white/10 text-white shadow-lg shadow-accent-violet/10 border border-white/10'
              : 'text-white/40 hover:text-white/60 hover:bg-white/5 border border-transparent'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
});
