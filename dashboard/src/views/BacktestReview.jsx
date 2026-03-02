import React, { useState, useEffect, useCallback, useMemo } from 'react';

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function StatusBadge({ status }) {
  const colors = {
    completed: 'bg-emerald-500/20 text-emerald-400',
    running: 'bg-yellow-500/20 text-yellow-400',
    failed: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 text-[10px] rounded-full ${colors[status] || 'bg-white/10 text-white/40'}`}>
      {status}
    </span>
  );
}

function SortableHeader({ label, field, sortField, sortDir, onSort }) {
  const active = sortField === field;
  return (
    <th
      className="text-xs text-white/40 font-medium px-3 py-2 text-left cursor-pointer select-none hover:text-white/60 transition-colors"
      onClick={() => onSort(field)}
    >
      {label}
      {active && (
        <span className="ml-1 text-white/60">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
      )}
    </th>
  );
}

// --- Runs List ---
function RunsList({ onSelectRun }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/backtest/runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(data.runs || data || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  if (loading) {
    return (
      <div className="glass p-12 text-center">
        <p className="text-xs text-white/30 animate-pulse">Loading backtest runs...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass p-12 text-center">
        <p className="text-xs text-red-400">Failed to load runs: {error}</p>
        <button
          onClick={fetchRuns}
          className="mt-4 px-4 py-2 text-xs bg-white/5 rounded-lg border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all duration-300"
        >
          Retry
        </button>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="glass p-12 text-center">
        <p className="text-xs text-white/30">No backtest runs found</p>
      </div>
    );
  }

  return (
    <div className="glass p-6 rounded-xl">
      <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Backtest Runs</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Date</th>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Status</th>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Strategies</th>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Symbols</th>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Trades</th>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Total PnL</th>
              <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const pnl = Number(run.total_pnl || 0);
              const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-white/40';
              return (
                <tr
                  key={run.run_id || run.id}
                  onClick={() => onSelectRun(run)}
                  className="border-t border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors duration-200"
                >
                  <td className="text-xs text-white/80 px-3 py-2">{formatDate(run.created_at || run.date)}</td>
                  <td className="text-xs px-3 py-2">
                    <StatusBadge status={run.status} />
                    {run.status === 'running' && (
                      <div className="mt-1 w-24 h-1 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-yellow-400/60 rounded-full animate-pulse" style={{ width: '60%' }} />
                      </div>
                    )}
                  </td>
                  <td className="text-xs text-white/80 px-3 py-2">{run.strategies_count ?? run.strategies ?? '--'}</td>
                  <td className="text-xs text-white/60 px-3 py-2">{run.symbols || '--'}</td>
                  <td className="text-xs text-white/80 px-3 py-2">{run.total_trades ?? '--'}</td>
                  <td className={`text-xs font-medium px-3 py-2 ${pnlColor}`}>
                    {pnl !== 0 ? `${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)}` : '--'}
                  </td>
                  <td className="text-xs text-white/60 px-3 py-2">{formatDuration(run.duration_seconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Run Detail ---
function RunDetail({ run, onBack }) {
  const [summary, setSummary] = useState([]);
  const [cheap, setCheap] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters
  const [symbolFilter, setSymbolFilter] = useState('ALL');
  const [strategyFilter, setStrategyFilter] = useState('ALL');
  const [entryFilter, setEntryFilter] = useState('ALL');

  // Sort
  const [sortField, setSortField] = useState(null);
  const [sortDir, setSortDir] = useState('desc');

  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true);
      const id = run.run_id || run.id;
      const [sumRes, cheapRes] = await Promise.all([
        fetch(`/api/backtest/runs/${id}/summary`),
        fetch(`/api/backtest/runs/${id}/cheap`),
      ]);
      if (!sumRes.ok) throw new Error(`Summary: HTTP ${sumRes.status}`);
      const sumData = await sumRes.json();
      setSummary(sumData.summary || sumData || []);

      if (cheapRes.ok) {
        const cheapData = await cheapRes.json();
        setCheap(cheapData.trades || cheapData || []);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [run.id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  // Derive unique strategies from data
  const strategies = useMemo(() => {
    const set = new Set(summary.map((s) => s.strategy));
    return ['ALL', ...Array.from(set).sort()];
  }, [summary]);

  // Filter summary rows
  const filteredSummary = useMemo(() => {
    let rows = [...summary];
    if (symbolFilter !== 'ALL') rows = rows.filter((r) => (r.symbol || '').toUpperCase() === symbolFilter);
    if (strategyFilter !== 'ALL') rows = rows.filter((r) => r.strategy === strategyFilter);
    if (entryFilter !== 'ALL') {
      const avg = (r) => Number(r.avg_entry || 0);
      if (entryFilter === '<0.10') rows = rows.filter((r) => avg(r) < 0.10);
      else if (entryFilter === '0.10-0.20') rows = rows.filter((r) => avg(r) >= 0.10 && avg(r) < 0.20);
      else if (entryFilter === '0.20-0.30') rows = rows.filter((r) => avg(r) >= 0.20 && avg(r) < 0.30);
    }
    if (sortField) {
      rows.sort((a, b) => {
        const av = Number(a[sortField]) || 0;
        const bv = Number(b[sortField]) || 0;
        return sortDir === 'asc' ? av - bv : bv - av;
      });
    }
    return rows;
  }, [summary, symbolFilter, strategyFilter, entryFilter, sortField, sortDir]);

  // Filter cheap trades
  const filteredCheap = useMemo(() => {
    let rows = [...cheap];
    if (symbolFilter !== 'ALL') rows = rows.filter((r) => (r.symbol || '').toUpperCase() === symbolFilter);
    if (strategyFilter !== 'ALL') rows = rows.filter((r) => r.strategy === strategyFilter);
    return rows;
  }, [cheap, symbolFilter, strategyFilter]);

  const selectClass = "bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-white/30 transition-all duration-300 appearance-none";

  if (loading) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="text-xs text-white/40 hover:text-white/70 transition-colors">
          &larr; Back to runs
        </button>
        <div className="glass p-12 text-center">
          <p className="text-xs text-white/30 animate-pulse">Loading run details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="text-xs text-white/40 hover:text-white/70 transition-colors">
          &larr; Back to runs
        </button>
        <div className="glass p-12 text-center">
          <p className="text-xs text-red-400">Failed to load: {error}</p>
          <button
            onClick={fetchDetail}
            className="mt-4 px-4 py-2 text-xs bg-white/5 rounded-lg border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all duration-300"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back button */}
      <button onClick={onBack} className="text-xs text-white/40 hover:text-white/70 transition-colors">
        &larr; Back to runs
      </button>

      {/* Header */}
      <div className="glass p-4 flex items-center gap-6">
        <span className="text-sm font-semibold text-white/60 uppercase tracking-wider">Run Detail</span>
        <div className="flex items-center gap-4 text-[10px] text-white/40">
          <span>{formatDate(run.created_at || run.date)}</span>
          <StatusBadge status={run.status} />
          {run.duration_seconds && <span>{formatDuration(run.duration_seconds)}</span>}
          {run.symbols && <span>{run.symbols}</span>}
        </div>
      </div>

      {/* AI Commentary */}
      {run.commentary && (
        <div className="glass p-6 rounded-xl">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">AI Commentary</h2>
          <p className="text-xs text-white/70 leading-relaxed whitespace-pre-wrap">{run.commentary}</p>
        </div>
      )}

      {/* Filters bar */}
      <div className="glass p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-[10px] text-white/30 mb-1">Symbol</label>
          <select value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)} className={selectClass}>
            <option value="ALL">All</option>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
            <option value="SOL">SOL</option>
            <option value="XRP">XRP</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-white/30 mb-1">Strategy</label>
          <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)} className={selectClass}>
            {strategies.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? 'All' : s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] text-white/30 mb-1">Entry Price</label>
          <select value={entryFilter} onChange={(e) => setEntryFilter(e.target.value)} className={selectClass}>
            <option value="ALL">All</option>
            <option value="<0.10">{'< $0.10'}</option>
            <option value="0.10-0.20">$0.10 - $0.20</option>
            <option value="0.20-0.30">$0.20 - $0.30</option>
          </select>
        </div>
      </div>

      {/* Summary table */}
      <div className="glass p-6 rounded-xl">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Strategy Summary</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <SortableHeader label="Strategy" field="strategy" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="Symbol" field="symbol" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="Trades" field="trades" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="Wins" field="wins" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="WR%" field="win_rate" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="Total PnL" field="total_pnl" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="Avg PnL" field="avg_pnl" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="Avg Entry" field="avg_entry" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Description</th>
              </tr>
            </thead>
            <tbody>
              {filteredSummary.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-xs text-white/20">No matching strategies</td>
                </tr>
              ) : (
                filteredSummary.map((row, i) => {
                  const pnl = Number(row.total_pnl || 0);
                  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-white/40';
                  const avgPnl = Number(row.avg_pnl || 0);
                  const avgPnlColor = avgPnl > 0 ? 'text-emerald-400' : avgPnl < 0 ? 'text-red-400' : 'text-white/40';
                  const wr = Number(row.win_rate || 0);
                  const wrColor = wr >= 55 ? 'text-emerald-400' : wr < 45 ? 'text-red-400' : 'text-white/70';

                  return (
                    <tr key={`${row.strategy}-${row.symbol}-${i}`} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors duration-200">
                      <td className="text-xs text-white/80 px-3 py-2">{row.strategy}</td>
                      <td className="text-xs text-white/60 px-3 py-2">{(row.symbol || '').toUpperCase()}</td>
                      <td className="text-xs text-white/80 px-3 py-2">{row.trades}</td>
                      <td className="text-xs text-white/80 px-3 py-2">{row.wins}</td>
                      <td className={`text-xs font-medium px-3 py-2 ${wrColor}`}>{wr.toFixed(1)}%</td>
                      <td className={`text-xs font-medium px-3 py-2 ${pnlColor}`}>
                        {pnl > 0 ? '+' : ''}${pnl.toFixed(2)}
                      </td>
                      <td className={`text-xs px-3 py-2 ${avgPnlColor}`}>
                        {avgPnl > 0 ? '+' : ''}${avgPnl.toFixed(4)}
                      </td>
                      <td className="text-xs text-white/60 px-3 py-2">${Number(row.avg_entry || 0).toFixed(3)}</td>
                      <td className="text-xs text-white/40 px-3 py-2 max-w-xs truncate">{row.description || '--'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cheap entries section */}
      {filteredCheap.length > 0 && (
        <div className="glass p-6 rounded-xl">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
            Cheap Entries ({'<'} $0.20)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Strategy</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Symbol</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Direction</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Entry$</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Tokens</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Cost$</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">PnL$</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">ROC%</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Won</th>
                  <th className="text-xs text-white/40 font-medium px-3 py-2 text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredCheap.map((t, i) => {
                  const pnl = Number(t.pnl || 0);
                  const roc = Number(t.roc || 0);
                  const won = t.won || t.win;
                  const rowColor = won ? 'hover:bg-emerald-500/[0.03]' : 'hover:bg-red-500/[0.03]';
                  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-white/40';
                  const rocColor = roc > 0 ? 'text-emerald-400' : roc < 0 ? 'text-red-400' : 'text-white/40';

                  return (
                    <tr key={i} className={`border-t border-white/5 ${rowColor} transition-colors duration-200`}>
                      <td className="text-xs text-white/80 px-3 py-2">{t.strategy}</td>
                      <td className="text-xs text-white/60 px-3 py-2">{(t.symbol || '').toUpperCase()}</td>
                      <td className="text-xs text-white/60 px-3 py-2">{(t.direction || t.side || '').toUpperCase()}</td>
                      <td className="text-xs text-white/80 px-3 py-2">${Number(t.entry_price || t.entry || 0).toFixed(3)}</td>
                      <td className="text-xs text-white/60 px-3 py-2">{Number(t.tokens || t.size || 0).toFixed(1)}</td>
                      <td className="text-xs text-white/60 px-3 py-2">${Number(t.cost || 0).toFixed(2)}</td>
                      <td className={`text-xs font-medium px-3 py-2 ${pnlColor}`}>
                        {pnl > 0 ? '+' : ''}${pnl.toFixed(2)}
                      </td>
                      <td className={`text-xs font-medium px-3 py-2 ${rocColor}`}>
                        {roc > 0 ? '+' : ''}{roc.toFixed(1)}%
                      </td>
                      <td className="text-xs px-3 py-2">
                        {won ? (
                          <span className="text-emerald-400">Y</span>
                        ) : (
                          <span className="text-red-400">N</span>
                        )}
                      </td>
                      <td className="text-xs text-white/40 px-3 py-2 max-w-xs truncate">{t.reason || t.close_reason || '--'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main View ---
export default function BacktestReview() {
  const [selectedRun, setSelectedRun] = useState(null);

  if (selectedRun) {
    return <RunDetail run={selectedRun} onBack={() => setSelectedRun(null)} />;
  }

  return <RunsList onSelectRun={setSelectedRun} />;
}
