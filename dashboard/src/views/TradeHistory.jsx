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
  }, [page, strategy, instrument, outcome, dateFrom, dateTo]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [strategy, instrument, outcome, dateFrom, dateTo]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleExport = () => {
    window.open('/api/trades/export', '_blank');
  };

  return (
    <div className="space-y-4">
      {/* Filters bar */}
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Strategy</label>
            <input
              type="text"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              placeholder="All"
              className="bg-bg-tertiary text-gray-200 text-sm px-2 py-1.5 rounded border border-gray-600 w-32 focus:outline-none focus:border-accent-blue"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Instrument</label>
            <select
              value={instrument}
              onChange={(e) => setInstrument(e.target.value)}
              className="bg-bg-tertiary text-gray-200 text-sm px-2 py-1.5 rounded border border-gray-600 w-28 focus:outline-none focus:border-accent-blue"
            >
              <option value="">All</option>
              <option value="btc">BTC</option>
              <option value="eth">ETH</option>
              <option value="sol">SOL</option>
              <option value="xrp">XRP</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Outcome</label>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className="bg-bg-tertiary text-gray-200 text-sm px-2 py-1.5 rounded border border-gray-600 w-28 focus:outline-none focus:border-accent-blue"
            >
              <option value="">All</option>
              <option value="win">Win</option>
              <option value="loss">Loss</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="bg-bg-tertiary text-gray-200 text-sm px-2 py-1.5 rounded border border-gray-600 focus:outline-none focus:border-accent-blue"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="bg-bg-tertiary text-gray-200 text-sm px-2 py-1.5 rounded border border-gray-600 focus:outline-none focus:border-accent-blue"
            />
          </div>
          <button
            onClick={handleExport}
            className="px-3 py-1.5 bg-bg-tertiary text-gray-300 text-sm rounded border border-gray-600 hover:bg-gray-600 transition-colors"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Trade table */}
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Trade History
          </h2>
          <span className="text-xs text-gray-500">
            {total} total {loading && '(loading...)'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-gray-500 uppercase">
                <th className="pb-2 px-2">ID</th>
                <th className="pb-2 px-2">Time</th>
                <th className="pb-2 px-2">Window</th>
                <th className="pb-2 px-2">Side</th>
                <th className="pb-2 px-2">Entry</th>
                <th className="pb-2 px-2">Exit</th>
                <th className="pb-2 px-2">Size</th>
                <th className="pb-2 px-2">P&L</th>
                <th className="pb-2 px-2">Strategy</th>
                <th className="pb-2 px-2">Status</th>
                <th className="pb-2 px-2">Close Reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-8 text-center text-sm text-gray-500">
                    {loading ? 'Loading...' : 'No trades found'}
                  </td>
                </tr>
              ) : (
                trades.map((t, i) => {
                  const pnl = Number(t.pnl || 0);
                  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-gray-400';
                  const entryPrice = Number(t.entry_price || 0);
                  const exitPrice = Number(t.close_price || t.current_price || 0);

                  const statusColor =
                    t.status === 'open' ? 'text-accent-blue' :
                    t.status === 'closed' ? 'text-gray-400' :
                    t.status === 'liquidated' ? 'text-accent-red' : 'text-gray-500';

                  return (
                    <tr key={t.id || i} className="border-t border-gray-700/50 hover:bg-bg-tertiary/30">
                      <td className="py-2 px-2 text-xs text-gray-500">{t.id}</td>
                      <td className="py-2 px-2 text-xs text-gray-400">{formatDate(t.closed_at || t.opened_at)}</td>
                      <td className="py-2 px-2 text-xs text-gray-300">{t.window_id || '--'}</td>
                      <td className="py-2 px-2 text-xs text-gray-300">{(t.side || '').toUpperCase()}</td>
                      <td className="py-2 px-2 text-xs text-gray-400">${entryPrice.toFixed(4)}</td>
                      <td className="py-2 px-2 text-xs text-gray-300">
                        {t.close_price != null ? `$${exitPrice.toFixed(4)}` : '--'}
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-400">
                        {t.size != null ? Number(t.size).toFixed(2) : '--'}
                      </td>
                      <td className={`py-2 px-2 text-xs font-semibold ${pnlColor}`}>
                        {pnl !== 0 ? `${pnl > 0 ? '+' : ''}$${pnl.toFixed(4)}` : '--'}
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-500">{t.strategy_id || '--'}</td>
                      <td className={`py-2 px-2 text-xs ${statusColor}`}>{t.status || '--'}</td>
                      <td className="py-2 px-2 text-xs text-gray-500">{t.close_reason || '--'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-700">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="text-xs text-gray-500">
              Page {page + 1} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
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

  const pnlColor = totalPnl > 0 ? 'text-accent-green' : totalPnl < 0 ? 'text-accent-red' : 'text-gray-400';

  return (
    <div className="mt-4 pt-3 border-t border-gray-700 flex items-center gap-6 text-xs">
      <span className="text-gray-500">Page Summary:</span>
      <span className="text-gray-400">{closedTrades.length} closed</span>
      <span className="text-accent-green">{wins}W</span>
      <span className="text-accent-red">{losses}L</span>
      <span className="text-gray-400">WR: {winRate}%</span>
      <span className={`font-semibold ${pnlColor}`}>
        Net: {totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(4)}
      </span>
    </div>
  );
}
