import React, { useState, useMemo } from 'react';
import { formatMetric } from './chart-theme.js';
import ConfidenceBadge from './ConfidenceBadge.jsx';

/**
 * Side-by-side comparison table for factory results within a run.
 * Sortable columns, symbol filter, key config params displayed.
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

export default function ComparisonTable({ results, onSelectStrategy }) {
  const [sortField, setSortField] = useState('sharpe');
  const [sortDir, setSortDir] = useState('desc');
  const [symbolFilter, setSymbolFilter] = useState('ALL');

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  // Extract unique symbols
  const symbols = useMemo(() => {
    const set = new Set((results || []).map(r => (r.symbol || '').toUpperCase()));
    return ['ALL', ...Array.from(set).sort()];
  }, [results]);

  // Extract common config keys for display
  const configKeys = useMemo(() => {
    const keyCounts = {};
    for (const r of (results || [])) {
      for (const k of Object.keys(r.config || {})) {
        keyCounts[k] = (keyCounts[k] || 0) + 1;
      }
    }
    // Show keys that appear in at least half the results
    const threshold = Math.max(1, Math.floor((results || []).length / 2));
    return Object.keys(keyCounts).filter(k => keyCounts[k] >= threshold).slice(0, 3);
  }, [results]);

  const sorted = useMemo(() => {
    let rows = [...(results || [])];
    if (symbolFilter !== 'ALL') {
      rows = rows.filter(r => (r.symbol || '').toUpperCase() === symbolFilter);
    }
    rows.sort((a, b) => {
      const aVal = Number(a.metrics?.[sortField]) || 0;
      const bVal = Number(b.metrics?.[sortField]) || 0;
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });
    return rows;
  }, [results, symbolFilter, sortField, sortDir]);

  const selectClass = 'bg-white/[0.04] text-white/70 text-[11px] font-medium px-3 py-1.5 rounded-lg border border-white/[0.08] focus:outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20 transition-all duration-200 appearance-none cursor-pointer';

  return (
    <div className="glass p-5 rounded-xl">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="section-title">Results</h2>
        <div>
          <label className="label-xs block mb-1">Symbol</label>
          <select value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)} className={selectClass}>
            {symbols.map(s => (
              <option key={s} value={s} className="bg-[#0a0e1a] text-white">{s === 'ALL' ? 'All' : s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <SortableHeader label="Strategy" field="strategy_name" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Symbol</th>
              {configKeys.map(k => (
                <th key={k} className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left whitespace-nowrap">{k}</th>
              ))}
              <SortableHeader label="Sharpe" field="sharpe" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="PF" field="profitFactor" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Win Rate" field="winRate" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Trades" field="trades" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Max DD" field="maxDrawdown" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <SortableHeader label="Edge/Trade" field="edgePerTrade" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={7 + configKeys.length + 4} className="py-12 text-center text-xs text-white/20">No results</td>
              </tr>
            ) : (
              sorted.map((row, i) => {
                const m = row.metrics || {};
                const sharpe = Number(m.sharpe ?? 0);
                const pf = Number(m.profitFactor ?? 0);
                const wr = Number(m.winRate ?? 0);
                // Highlight best row
                const isBest = i === 0 && sortDir === 'desc' && sorted.length > 1;

                return (
                  <tr
                    key={`${row.strategy_name}-${row.symbol}-${row.id}`}
                    className={`border-t border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors duration-150 ${
                      isBest ? 'bg-violet-500/[0.04] border-l-2 border-l-violet-500/40' : ''
                    }`}
                    onClick={() => onSelectStrategy?.(row.strategy_name)}
                  >
                    <td className="text-xs text-white/90 px-3 py-2.5 font-medium tracking-tight">{row.strategy_name}</td>
                    <td className="text-[11px] text-white/45 px-3 py-2.5 uppercase font-mono">{row.symbol}</td>
                    {configKeys.map(k => (
                      <td key={k} className="text-[11px] text-white/35 px-3 py-2.5 font-mono tabular-nums">
                        {row.config?.[k] != null ? String(row.config[k]) : '--'}
                      </td>
                    ))}
                    <td className={`text-xs font-semibold px-3 py-2.5 font-mono tabular-nums ${sharpe > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatMetric(m.sharpe, 'sharpe')}
                    </td>
                    <td className={`text-xs font-medium px-3 py-2.5 font-mono tabular-nums ${pf > 1 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatMetric(m.profitFactor, 'decimal')}
                    </td>
                    <td className={`text-xs font-medium px-3 py-2.5 font-mono tabular-nums ${wr > 0.5 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatMetric(m.winRate, 'winRate')}
                    </td>
                    <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">{formatMetric(m.trades, 'trades')}</td>
                    <td className="text-xs text-red-400/60 px-3 py-2.5 font-mono tabular-nums">{formatMetric(m.maxDrawdown, 'drawdown')}</td>
                    <td className="text-xs text-white/55 px-3 py-2.5 font-mono tabular-nums">{formatMetric(m.edgePerTrade, 'decimal')}</td>
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
