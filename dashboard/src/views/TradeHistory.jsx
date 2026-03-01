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
  const [trades, setTrades] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);

  // Filters
  const [strategy, setStrategy] = useState('');
  const [instrument, setInstrument] = useState('');
  const [outcome, setOutcome] = useState('');
  const [mode, setMode] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
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
    } catch {
      setTrades([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, strategy, instrument, outcome, mode, dateFrom, dateTo]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [strategy, instrument, outcome, mode, dateFrom, dateTo]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleExport = () => {
    window.open('/api/trades/export', '_blank');
  };

  const inputClass = "bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300";
  const selectClass = `${inputClass} appearance-none`;

  return (
    <div className="space-y-4">
      {/* Filters bar */}
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

      {/* Trade table */}
      <div className="glass p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title">Trade History</h2>
          <span className="text-[10px] text-white/25">
            {total} total {loading && '(loading...)'}
          </span>
        </div>

        <div className="overflow-x-auto">
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
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
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

        {/* Slippage summary for visible trades */}
        {trades.length > 0 && trades.some(t => t.close_price && t.entry_price) && (
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
