import React from 'react';
import ConfidenceBadge from './ConfidenceBadge.jsx';
import { formatMetric } from './chart-theme.js';

/**
 * Rich strategy candidate card showing hypothesis, iteration count,
 * best Sharpe, trade count, and confidence at a glance.
 */
export default function StrategyCard({ strategy, lineage, onClick }) {
  const m = strategy?.metrics || {};
  const trades = m.trades || 0;
  const sharpe = m.sharpe;

  // Derive hypothesis from lineage data
  let hypothesis = 'N/A';
  let iterations = 'N/A';
  if (lineage && lineage.length > 0) {
    const self = lineage.find(l => l.strategy_name === strategy.strategy_name);
    if (self) {
      if (self.mutation_type === 'original') {
        hypothesis = self.mutation_reasoning || 'Original strategy';
      } else {
        hypothesis = `Mutation of ${self.parent_name || 'unknown'}`;
      }
    }
    iterations = lineage.length;
  }

  // Truncate hypothesis for card display
  const truncatedHypothesis = typeof hypothesis === 'string' && hypothesis.length > 120
    ? hypothesis.slice(0, 117) + '...'
    : hypothesis;

  const sharpeColor = sharpe > 0 ? 'text-emerald-400' : sharpe < 0 ? 'text-red-400' : 'text-white/40';
  const sharpeGlow = sharpe > 1.5 ? 'glow-green' : sharpe < -0.5 ? 'glow-red' : '';

  return (
    <div
      className={`glass p-4 rounded-xl cursor-pointer hover:bg-white/[0.07] transition-all duration-200 border border-white/[0.06] hover:border-white/[0.12] group ${sharpeGlow}`}
      onClick={() => onClick?.(strategy.strategy_name)}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-2.5 gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-white/90 truncate group-hover:text-white transition-colors tracking-tight">
            {strategy.strategy_name}
          </h3>
          <span className="text-[10px] text-white/30 uppercase font-mono tracking-wider">{strategy.symbol}</span>
        </div>
        <ConfidenceBadge trades={trades} confidenceIntervals={m.confidenceIntervals} />
      </div>

      {/* Hypothesis */}
      <p className="text-[10px] text-white/35 leading-relaxed mb-3 line-clamp-2" title={hypothesis}>
        {truncatedHypothesis}
      </p>

      {/* Metrics row */}
      <div className="grid grid-cols-3 gap-2 pt-2.5 border-t border-white/[0.06]">
        <div>
          <div className="label-xs mb-0.5">Sharpe</div>
          <div className={`text-sm font-bold font-mono tabular-nums ${sharpeColor}`}>{formatMetric(sharpe, 'sharpe')}</div>
        </div>
        <div>
          <div className="label-xs mb-0.5">Trades</div>
          <div className="text-sm font-bold text-white/80 font-mono tabular-nums">{formatMetric(trades, 'trades')}</div>
        </div>
        <div>
          <div className="label-xs mb-0.5">Iterations</div>
          <div className="text-sm font-bold text-white/50 font-mono tabular-nums">{iterations}</div>
        </div>
      </div>
    </div>
  );
}
