import React from 'react';

/**
 * Vertical timeline showing a strategy's mutation history.
 * Root (original) at top, children below. Each node shows:
 * strategy name, mutation type badge, reasoning, date, author.
 */

const MUTATION_COLORS = {
  original:      'bg-violet-500/15 text-violet-400 ring-1 ring-violet-500/20',
  param_perturb: 'bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/20',
  structural:    'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/20',
  crossover:     'bg-pink-500/15 text-pink-400 ring-1 ring-pink-500/20',
};

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export default function LineageTree({ lineage, highlightStrategy }) {
  if (!lineage || lineage.length === 0) {
    return (
      <div className="glass p-5 rounded-xl">
        <p className="text-xs text-white/25 text-center py-8">
          No lineage data available — strategy may predate the factory system
        </p>
      </div>
    );
  }

  return (
    <div className="glass p-5 rounded-xl">
      <h2 className="section-title mb-4">Mutation History</h2>
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[11px] top-3 bottom-3 w-px bg-gradient-to-b from-violet-500/30 via-white/[0.08] to-transparent" />

        <div className="space-y-0.5">
          {lineage.map((entry, i) => {
            const isHighlighted = highlightStrategy === entry.strategy_name;
            const isRoot = i === 0;
            const mutColor = MUTATION_COLORS[entry.mutation_type] || 'bg-white/10 text-white/40';

            return (
              <div
                key={entry.id || entry.strategy_name}
                className={`relative pl-8 py-3 rounded-lg transition-all duration-150 ${
                  isHighlighted ? 'bg-white/[0.05] border border-white/[0.08]' : 'hover:bg-white/[0.03]'
                }`}
              >
                {/* Node dot */}
                <div className={`absolute left-1.5 top-[18px] w-3 h-3 rounded-full border-2 transition-colors ${
                  isRoot
                    ? 'bg-violet-500/40 border-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.3)]'
                    : isHighlighted
                      ? 'bg-white/20 border-white/60'
                      : 'bg-white/[0.06] border-white/20'
                }`} />

                {/* Content */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-semibold tracking-tight ${isHighlighted ? 'text-white' : 'text-white/80'}`}>
                        {entry.strategy_name}
                      </span>
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-semibold rounded-full ${mutColor}`}>
                        {(entry.mutation_type || '').replace('_', ' ')}
                      </span>
                    </div>
                    <p className="text-[10px] text-white/35 leading-relaxed">
                      {entry.mutation_reasoning || 'No reasoning recorded'}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] text-white/30 font-mono tabular-nums">{formatDate(entry.created_at)}</div>
                    <div className="text-[10px] text-white/20">{entry.created_by || '--'}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
