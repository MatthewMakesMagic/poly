import React, { useState, useMemo } from 'react';
import ConfidenceBadge from './ConfidenceBadge.jsx';
import { formatMetric } from './chart-theme.js';

/**
 * Sortable, filterable leaderboard of top strategies.
 * Columns: Rank, Strategy, Symbol, Sharpe, PF, Win Rate, Trades, Max DD, Sample Size
 */

function SortableHeader({ label, field, sortField, sortDir, onSort }) {
  const active = sortField === field;
  return (
    <th
      className={`text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left cursor-pointer select-none transition-colors whitespace-nowrap ${
        active ? 'text-white/70' : 'text-white/35 hover:text-white/55'
      }`}
      onClick={() => onSort(field)}
    >
      {label}
      {active && (
        <span className="ml-1 text-violet-400/70">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
      )}
    </th>
  );
}

const METRIC_OPTIONS = [
  { value: 'sharpe', label: 'Sharpe' },
  { value: 'sortino', label: 'Sortino' },
  { value: 'profitFactor', label: 'Profit Factor' },
  { value: 'winRate', label: 'Win Rate' },
];

const TRADE_FILTERS = [
  { value: 0, label: 'All' },
  { value: 50, label: '50+' },
  { value: 100, label: '100+' },
  { value: 200, label: '200+' },
];

export default function LeaderboardTable({ strategies, onSelectStrategy }) {
  const [sortField, setSortField] = useState('sharpe');
  const [sortDir, setSortDir] = useState('desc');
  const [minTrades, setMinTrades] = useState(0);
  const [rankMetric, setRankMetric] = useState('sharpe');

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const sorted = useMemo(() => {
    let rows = [...(strategies || [])];

    // Filter by minimum trades
    if (minTrades > 0) {
      rows = rows.filter(r => (r.metrics?.trades || 0) >= minTrades);
    }

    // Sort
    rows.sort((a, b) => {
      const aVal = Number(a.metrics?.[sortField] ?? a[sortField]) || 0;
      const bVal = Number(b.metrics?.[sortField] ?? b[sortField]) || 0;
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return rows;
  }, [strategies, sortField, sortDir, minTrades]);

  const selectClass = 'bg-white/[0.04] text-white/70 text-[11px] font-medium px-3 py-1.5 rounded-lg border border-white/[0.08] focus:outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20 transition-all duration-200 appearance-none cursor-pointer';

  return (
    <div className="glass p-5 rounded-xl">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="section-title">Leaderboard</h2>
        <div className="flex items-center gap-3">
          <div>
            <label className="label-xs block mb-1">Rank by</label>
            <select value={rankMetric} onChange={e => setRankMetric(e.target.value)} className={selectClass}>
              {METRIC_OPTIONS.map(o => (
                <option key={o.value} value={o.value} className="bg-[#0a0e1a] text-white">{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label-xs block mb-1">Min Trades</label>
            <select value={minTrades} onChange={e => setMinTrades(Number(e.target.value))} className={selectClass}>
              {TRADE_FILTERS.map(o => (
                <option key={o.value} value={o.value} className="bg-[#0a0e1a] text-white">{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left w-10">#</th>
              <SortableHeader label="Strategy" field="strategy_name" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Symbol" field="symbol" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Sharpe" field="sharpe" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="PF" field="profitFactor" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Win Rate" field="winRate" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Trades" field="trades" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Max DD" field="maxDrawdown" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-xs text-white/20">No strategies match the current filters</td>
              </tr>
            ) : (
              sorted.map((row, i) => {
                const m = row.metrics || {};
                const sharpe = Number(m.sharpe ?? 0);
                const pf = Number(m.profitFactor ?? 0);
                const wr = Number(m.winRate ?? 0);
                const sharpeColor = sharpe > 0 ? 'text-emerald-400' : sharpe < 0 ? 'text-red-400' : 'text-white/40';
                const pfColor = pf > 1 ? 'text-emerald-400' : pf < 1 ? 'text-red-400' : 'text-white/40';
                const wrColor = wr > 0.5 ? 'text-emerald-400' : wr < 0.5 ? 'text-red-400' : 'text-white/40';

                return (
                  <tr
                    key={`${row.strategy_name}-${row.symbol}-${row.id}`}
                    className={`border-t border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors duration-150 ${
                      i === 0 ? 'bg-white/[0.02]' : ''
                    }`}
                    onClick={() => onSelectStrategy?.(row.strategy_name)}
                  >
                    <td className="text-[11px] text-white/25 px-3 py-2.5 font-mono tabular-nums">{i + 1}</td>
                    <td className="text-xs text-white/90 px-3 py-2.5 font-medium tracking-tight">{row.strategy_name}</td>
                    <td className="text-[11px] text-white/45 px-3 py-2.5 uppercase font-mono">{row.symbol}</td>
                    <td className={`text-xs font-semibold px-3 py-2.5 font-mono tabular-nums ${sharpeColor}`}>{formatMetric(m.sharpe, 'sharpe')}</td>
                    <td className={`text-xs font-medium px-3 py-2.5 font-mono tabular-nums ${pfColor}`}>{formatMetric(m.profitFactor, 'decimal')}</td>
                    <td className={`text-xs font-medium px-3 py-2.5 font-mono tabular-nums ${wrColor}`}>{formatMetric(m.winRate, 'winRate')}</td>
                    <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">{formatMetric(m.trades, 'trades')}</td>
                    <td className="text-xs text-red-400/60 px-3 py-2.5 font-mono tabular-nums">{formatMetric(m.maxDrawdown, 'drawdown')}</td>
                    <td className="text-xs px-3 py-2.5">
                      <ConfidenceBadge trades={m.trades} confidenceIntervals={m.confidenceIntervals} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
