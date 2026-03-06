import React, { useState, useEffect, useCallback } from 'react';

const PAGE_SIZE = 25;

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export default function TradeHistory() {
  const [source, setSource] = useState('positions'); // 'positions' | 'passive-mm'
  const [trades, setTrades] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  // Passive MM state
  const [mmData, setMmData] = useState(null);

  // Filters (positions only)
  const [strategy, setStrategy] = useState('');
  const [instrument, setInstrument] = useState('');
  const [outcome, setOutcome] = useState('');
  const [mode, setMode] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      if (source === 'passive-mm') {
        const res = await fetch('/api/passive-mm/trades');
        const data = await res.json();
        setMmData(data);
        setTrades(data.recentFills || []);
        setTotal(data.summary?.totalFills || 0);
      } else {
        const params = new URLSearchParams();
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', String(page * PAGE_SIZE));
        if (strategy) params.set('strategy', strategy);
        if (instrument) params.set('instrument', instrument);
        if (outcome) params.set('outcome', outcome);
        if (mode) params.set('mode', mode);
        if (dateFrom) params.set('from', dateFrom);
        if (dateTo) params.set('to', dateTo);

        const res = await fetch(`/api/trades?${params.toString()}`);
        const data = await res.json();
        setTrades(data.trades || []);
        setTotal(data.total || 0);
      }
    } catch {
      setTrades([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [source, page, strategy, instrument, outcome, mode, dateFrom, dateTo]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // Reset page when filters or source change
  useEffect(() => {
    setPage(0);
  }, [source, strategy, instrument, outcome, mode, dateFrom, dateTo]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleExport = () => {
    window.open('/api/trades/export', '_blank');
  };

  const inputClass = "bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300";
  const selectClass = `${inputClass} appearance-none`;

  const tabClass = (active) =>
    `px-4 py-2 text-xs font-medium rounded-lg border transition-all duration-300 ${
      active
        ? 'bg-accent-violet/20 text-accent-violet border-accent-violet/30'
        : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white/60'
    }`;

  return (
    <div className="space-y-4">
      {/* Source tabs */}
      <div className="flex items-center gap-2">
        <button className={tabClass(source === 'positions')} onClick={() => setSource('positions')}>
          Paper Trader
        </button>
        <button className={tabClass(source === 'passive-mm')} onClick={() => setSource('passive-mm')}>
          Passive MM
        </button>
      </div>

      {/* Passive MM summary card */}
      {source === 'passive-mm' && mmData?.summary && (
        <div className="glass p-5">
          <div className="flex items-center gap-8 text-xs">
            <div>
              <span className="label-xs block mb-1">Windows</span>
              <span className="text-white/70 font-bold">{mmData.summary.totalWindows}</span>
            </div>
            <div>
              <span className="label-xs block mb-1">Fills</span>
              <span className="text-white/70 font-bold">{mmData.summary.totalFills}</span>
            </div>
            <div>
              <span className="label-xs block mb-1">Paired</span>
              <span className="text-white/70 font-bold">{mmData.summary.pairedWindows}</span>
            </div>
            <div>
              <span className="label-xs block mb-1">Cumulative P&L</span>
              <span className={`font-bold ${mmData.summary.cumulativePnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {mmData.summary.cumulativePnl >= 0 ? '+' : ''}${mmData.summary.cumulativePnl.toFixed(4)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Filters bar (positions only) */}
      {source === 'positions' && (
        <div className="glass p-5">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block label-xs mb-1.5">Strategy</label>
              <input
                type="text"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
                placeholder="All"
                className={`${inputClass} w-32`}
              />
            </div>
            <div>
              <label className="block label-xs mb-1.5">Instrument</label>
              <select
                value={instrument}
                onChange={(e) => setInstrument(e.target.value)}
                className={`${selectClass} w-28`}
              >
                <option value="">All</option>
                <option value="btc">BTC</option>
                <option value="eth">ETH</option>
                <option value="sol">SOL</option>
                <option value="xrp">XRP</option>
              </select>
            </div>
            <div>
              <label className="block label-xs mb-1.5">Outcome</label>
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                className={`${selectClass} w-28`}
              >
                <option value="">All</option>
                <option value="win">Win</option>
                <option value="loss">Loss</option>
              </select>
            </div>
            <div>
              <label className="block label-xs mb-1.5">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className={`${selectClass} w-28`}
              >
                <option value="">All</option>
                <option value="LIVE">LIVE</option>
                <option value="PAPER">PAPER</option>
                <option value="DRY_RUN">DRY_RUN</option>
              </select>
            </div>
            <div>
              <label className="block label-xs mb-1.5">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block label-xs mb-1.5">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className={inputClass}
              />
            </div>
            <button
              onClick={handleExport}
              className="px-4 py-2 bg-white/5 text-white/50 text-xs font-medium rounded-lg border border-white/10 hover:bg-white/10 hover:text-white/70 transition-all duration-300"
            >
              Export CSV
            </button>
          </div>
        </div>
      )}

      {/* Trade table */}
      <div className="glass p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title">{source === 'passive-mm' ? 'Passive MM Fills' : 'Trade History'}</h2>
          <span className="text-[10px] text-white/25">
            {total} total {loading && '(loading...)'}
          </span>
        </div>

        <div className="overflow-x-auto">
          {source === 'passive-mm' ? (
            <table className="w-full text-left">
              <thead>
                <tr className="label-xs">
                  <th className="pb-3 px-3 font-medium">ID</th>
                  <th className="pb-3 px-3 font-medium">Time</th>
                  <th className="pb-3 px-3 font-medium">Window</th>
                  <th className="pb-3 px-3 font-medium">Side</th>
                  <th className="pb-3 px-3 font-medium">Price</th>
                  <th className="pb-3 px-3 font-medium">Size</th>
                  <th className="pb-3 px-3 font-medium">Capital</th>
                  <th className="pb-3 px-3 font-medium">Resolution</th>
                  <th className="pb-3 px-3 font-medium">Payout</th>
                  <th className="pb-3 px-3 font-medium">P&L</th>
                  <th className="pb-3 px-3 font-medium">Paired</th>
                </tr>
              </thead>
              <tbody>
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-12 text-center text-xs text-white/20">
                      {loading ? 'Loading...' : 'No passive MM fills yet'}
                    </td>
                  </tr>
                ) : (
                  trades.map((t, i) => {
                    const pnl = Number(t.pnl || 0);
                    const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
                    return (
                      <tr key={t.id || i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors duration-200">
                        <td className="py-2.5 px-3 text-[10px] text-white/30">{t.id}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">{formatDate(t.filled_at)}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/60">{t.window_id || '--'}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/60">{(t.side || '').toUpperCase()}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">${Number(t.fill_price || 0).toFixed(4)}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">{Number(t.fill_size || 0).toFixed(2)}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">${Number(t.capital || 0).toFixed(4)}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/60">{t.resolved_direction || '--'}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">
                          {t.payout != null ? `$${Number(t.payout).toFixed(4)}` : '--'}
                        </td>
                        <td className={`py-2.5 px-3 text-[10px] font-bold ${pnlColor}`}>
                          {pnl !== 0 ? `${pnl > 0 ? '+' : ''}$${pnl.toFixed(4)}` : '--'}
                        </td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">{t.is_paired ? 'Yes' : 'No'}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="label-xs">
                  <th className="pb-3 px-3 font-medium">ID</th>
                  <th className="pb-3 px-3 font-medium">Time</th>
                  <th className="pb-3 px-3 font-medium">Window</th>
                  <th className="pb-3 px-3 font-medium">Mode</th>
                  <th className="pb-3 px-3 font-medium">Side</th>
                  <th className="pb-3 px-3 font-medium">Entry</th>
                  <th className="pb-3 px-3 font-medium">Exit</th>
                  <th className="pb-3 px-3 font-medium">Size</th>
                  <th className="pb-3 px-3 font-medium">P&L</th>
                  <th className="pb-3 px-3 font-medium">Strategy</th>
                  <th className="pb-3 px-3 font-medium">Status</th>
                  <th className="pb-3 px-3 font-medium">Close Reason</th>
                </tr>
              </thead>
              <tbody>
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-12 text-center text-xs text-white/20">
                      {loading ? 'Loading...' : 'No trades found'}
                    </td>
                  </tr>
                ) : (
                  trades.map((t, i) => {
                    const pnl = Number(t.pnl || 0);
                    const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
                    const entryPrice = Number(t.entry_price || 0);
                    const exitPrice = Number(t.close_price || t.current_price || 0);

                    const modeColor =
                      t.mode === 'LIVE' ? 'text-accent-red' :
                      t.mode === 'PAPER' ? 'text-accent-blue' :
                      t.mode === 'DRY_RUN' ? 'text-accent-yellow' : 'text-white/30';

                    const statusColor =
                      t.status === 'open' ? 'text-accent-blue' :
                      t.status === 'closed' ? 'text-white/40' :
                      t.status === 'liquidated' ? 'text-accent-red' : 'text-white/30';

                    return (
                      <tr key={t.id || i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors duration-200">
                        <td className="py-2.5 px-3 text-[10px] text-white/30">{t.id}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">{formatDate(t.closed_at || t.opened_at)}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/60">{t.window_id || '--'}</td>
                        <td className={`py-2.5 px-3 text-[10px] font-bold ${modeColor}`}>{t.mode || '--'}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/60">{(t.side || '').toUpperCase()}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">${entryPrice.toFixed(4)}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/60">
                          {t.close_price != null ? `$${exitPrice.toFixed(4)}` : '--'}
                        </td>
                        <td className="py-2.5 px-3 text-[10px] text-white/40">
                          {t.size != null ? Number(t.size).toFixed(2) : '--'}
                        </td>
                        <td className={`py-2.5 px-3 text-[10px] font-bold ${pnlColor}`}>
                          {pnl !== 0 ? `${pnl > 0 ? '+' : ''}$${pnl.toFixed(4)}` : '--'}
                        </td>
                        <td className="py-2.5 px-3 text-[10px] text-white/30">{t.strategy_id || '--'}</td>
                        <td className={`py-2.5 px-3 text-[10px] ${statusColor}`}>{t.status || '--'}</td>
                        <td className="py-2.5 px-3 text-[10px] text-white/30">{t.close_reason || '--'}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination (positions only) */}
        {source === 'positions' && totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/5">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-1.5 text-[10px] text-white/40 hover:text-white/70 hover:bg-white/5 rounded-lg disabled:opacity-20 disabled:cursor-not-allowed transition-all duration-300"
            >
              Previous
            </button>
            <span className="text-[10px] text-white/25">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-4 py-1.5 text-[10px] text-white/40 hover:text-white/70 hover:bg-white/5 rounded-lg disabled:opacity-20 disabled:cursor-not-allowed transition-all duration-300"
            >
              Next
            </button>
          </div>
        )}

        {/* Per-window breakdown for passive MM */}
        {source === 'passive-mm' && mmData?.windows?.length > 0 && (
          <div className="mt-4 pt-4 border-t border-white/5">
            <h3 className="label-xs mb-3">Per-Window Summary</h3>
            <table className="w-full text-left">
              <thead>
                <tr className="label-xs">
                  <th className="pb-2 px-3 font-medium">Window</th>
                  <th className="pb-2 px-3 font-medium">Fills</th>
                  <th className="pb-2 px-3 font-medium">Cost</th>
                  <th className="pb-2 px-3 font-medium">Payout</th>
                  <th className="pb-2 px-3 font-medium">P&L</th>
                  <th className="pb-2 px-3 font-medium">Resolution</th>
                  <th className="pb-2 px-3 font-medium">Paired</th>
                </tr>
              </thead>
              <tbody>
                {mmData.windows.map((w, i) => {
                  const pnl = Number(w.pnl || 0);
                  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
                  return (
                    <tr key={w.window_id || i} className="border-t border-white/5">
                      <td className="py-2 px-3 text-[10px] text-white/60">{w.window_id}</td>
                      <td className="py-2 px-3 text-[10px] text-white/40">{w.fills}</td>
                      <td className="py-2 px-3 text-[10px] text-white/40">${Number(w.total_cost || 0).toFixed(4)}</td>
                      <td className="py-2 px-3 text-[10px] text-white/40">${Number(w.total_payout || 0).toFixed(4)}</td>
                      <td className={`py-2 px-3 text-[10px] font-bold ${pnlColor}`}>
                        {pnl !== 0 ? `${pnl > 0 ? '+' : ''}$${pnl.toFixed(4)}` : '--'}
                      </td>
                      <td className="py-2 px-3 text-[10px] text-white/60">{w.resolved_direction || '--'}</td>
                      <td className="py-2 px-3 text-[10px] text-white/40">{w.is_paired ? 'Yes' : 'No'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Slippage summary for visible trades (positions only) */}
        {source === 'positions' && trades.length > 0 && trades.some(t => t.close_price && t.entry_price) && (
          <SlippageSummary trades={trades} />
        )}
      </div>
    </div>
  );
}

function SlippageSummary({ trades }) {
  const closedTrades = trades.filter(t => t.status === 'closed' && t.pnl != null);
  if (closedTrades.length === 0) return null;

  const totalPnl = closedTrades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const wins = closedTrades.filter(t => Number(t.pnl || 0) > 0).length;
  const losses = closedTrades.filter(t => Number(t.pnl || 0) < 0).length;
  const winRate = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(1) : '0';

  const pnlColor = totalPnl > 0 ? 'text-accent-green' : totalPnl < 0 ? 'text-accent-red' : 'text-white/40';

  return (
    <div className="mt-4 pt-4 border-t border-white/5 flex items-center gap-6 text-[10px]">
      <span className="text-white/25">Page Summary:</span>
      <span className="text-white/40">{closedTrades.length} closed</span>
      <span className="text-accent-green/70">{wins}W</span>
      <span className="text-accent-red/70">{losses}L</span>
      <span className="text-white/40">WR: {winRate}%</span>
      <span className={`font-bold ${pnlColor}`}>
        Net: {totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(4)}
      </span>
    </div>
  );
}
