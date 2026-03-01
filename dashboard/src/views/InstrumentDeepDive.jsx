import React, { useState, useEffect, useCallback } from 'react';

const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];

function tickAge(updatedAt) {
  if (!updatedAt) return null;
  return (Date.now() - new Date(updatedAt).getTime()) / 1000;
}

function AgeDot({ seconds }) {
  if (seconds == null) return <span className="inline-block w-1.5 h-1.5 rounded-full bg-white/15" />;
  if (seconds < 2) return <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-green shadow-[0_0_4px_rgba(52,211,153,0.5)]" />;
  if (seconds < 5) return <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-yellow shadow-[0_0_4px_rgba(251,191,36,0.5)]" />;
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-red shadow-[0_0_4px_rgba(248,113,113,0.5)]" />;
}

function formatAge(seconds) {
  if (seconds == null) return '--';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m`;
}

function PriceRow({ label, price, updatedAt }) {
  const age = tickAge(updatedAt);
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/[0.03] transition-colors duration-200">
      <div className="flex items-center gap-2">
        <AgeDot seconds={age} />
        <span className="text-[10px] text-white/40">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-white/80 font-semibold">
          {price != null ? `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
        </span>
        <span className="text-[10px] text-white/20 w-8 text-right">{formatAge(age)}</span>
      </div>
    </div>
  );
}

function FeedStatusBadge({ status }) {
  const colors = {
    healthy: 'bg-accent-green/15 text-accent-green border-accent-green/20',
    stale: 'bg-accent-yellow/15 text-accent-yellow border-accent-yellow/20',
    dead: 'bg-accent-red/15 text-accent-red border-accent-red/20',
    no_data: 'bg-white/5 text-white/30 border-white/5',
    unknown: 'bg-white/5 text-white/30 border-white/5',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold border ${colors[status] || colors.unknown}`}>
      {status}
    </span>
  );
}

function InstrumentPanel({ data, feedMonitor, symbol }) {
  if (!data) return null;

  const oracle = data.oraclePrices || {};
  const exchanges = data.exchangePrices || {};
  const feedHealth = data.feedHealth || {};
  const positions = data.positions || [];
  const windows = data.activeWindows || [];

  // Extract per-feed status for this symbol from feed-monitor
  const feedMonitorFeeds = feedMonitor?.feeds || {};
  const symbolFeeds = {};
  for (const [key, entry] of Object.entries(feedMonitorFeeds)) {
    const [feed, sym] = key.split(':');
    if (sym === symbol) {
      symbolFeeds[feed] = entry;
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Oracle Prices */}
      <div className="glass p-5">
        <h3 className="section-title mb-3">Oracle Prices</h3>
        <PriceRow
          label="Polymarket Ref"
          price={oracle.polymarketRef?.price}
          updatedAt={oracle.polymarketRef?.updatedAt}
        />
        <PriceRow
          label="Chainlink"
          price={oracle.chainlink?.price}
          updatedAt={oracle.chainlink?.updatedAt}
        />
      </div>

      {/* Exchange Prices */}
      <div className="glass p-5">
        <h3 className="section-title mb-3">Exchange Prices</h3>
        {Object.keys(exchanges).length === 0 ? (
          <p className="text-xs text-white/20">No recent exchange data</p>
        ) : (
          Object.entries(exchanges).map(([exchange, info]) => (
            <PriceRow
              key={exchange}
              label={exchange}
              price={info.price}
              updatedAt={info.updatedAt}
            />
          ))
        )}
      </div>

      {/* Feed Health */}
      <div className="glass p-5">
        <h3 className="section-title mb-3">Feed Health</h3>
        {Object.keys(symbolFeeds).length === 0 && Object.keys(feedHealth).length === 0 ? (
          <p className="text-xs text-white/20">No feed data available</p>
        ) : (
          <div className="space-y-0.5">
            {Object.entries(symbolFeeds).map(([feed, entry]) => (
              <div key={feed} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/[0.03] transition-colors duration-200">
                <div className="flex items-center gap-2">
                  <AgeDot seconds={entry.ageMs != null ? entry.ageMs / 1000 : null} />
                  <span className="text-[10px] text-white/40">{feed}</span>
                </div>
                <div className="flex items-center gap-3">
                  <FeedStatusBadge status={entry.status} />
                  <span className="text-[10px] text-white/20 w-8 text-right">
                    {formatAge(entry.ageMs != null ? entry.ageMs / 1000 : null)}
                  </span>
                  {entry.inGap && (
                    <span className="text-[10px] text-accent-red font-bold">GAP</span>
                  )}
                </div>
              </div>
            ))}
            {/* Fallback: show DB-based feed health if feed-monitor not available */}
            {Object.keys(symbolFeeds).length === 0 && Object.entries(feedHealth).map(([topic, info]) => (
              <PriceRow
                key={topic}
                label={topic}
                price={info.price}
                updatedAt={info.lastTickAt}
              />
            ))}
          </div>
        )}
      </div>

      {/* Active Windows */}
      <div className="glass p-5">
        <h3 className="section-title mb-3">Active Windows</h3>
        {windows.length === 0 ? (
          <p className="text-xs text-white/20">No active windows</p>
        ) : (
          <div className="space-y-1">
            {windows.map((w, i) => {
              const remaining = w.timeRemainingMs ? Math.floor(w.timeRemainingMs / 1000) : null;
              const minutes = remaining != null ? Math.floor(remaining / 60) : null;
              const secs = remaining != null ? remaining % 60 : null;
              const urgencyColor = remaining != null && remaining < 60 ? 'text-accent-red' :
                remaining != null && remaining < 300 ? 'text-accent-yellow' : 'text-white/50';

              return (
                <div key={i} className="flex items-center justify-between py-2 px-3 rounded-lg bg-white/[0.02] border border-white/5">
                  <span className="text-xs text-white/60">{w.windowId || '--'}</span>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] text-white/30">
                      Strike: ${w.referencePrice != null ? Number(w.referencePrice).toLocaleString() : '--'}
                    </span>
                    <span className="text-[10px] text-white/30">
                      YES: {w.yesPrice != null ? `$${Number(w.yesPrice).toFixed(2)}` : '--'}
                    </span>
                    <span className={`text-xs font-bold ${urgencyColor}`}>
                      {minutes != null ? `${minutes}m ${secs}s` : '--'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Positions for this instrument */}
      <div className="glass p-5 lg:col-span-2">
        <h3 className="section-title mb-3">Open Positions</h3>
        {positions.length === 0 ? (
          <p className="text-xs text-white/20">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="label-xs">
                  <th className="pb-3 px-3 font-medium">Window</th>
                  <th className="pb-3 px-3 font-medium">Side</th>
                  <th className="pb-3 px-3 font-medium">Entry</th>
                  <th className="pb-3 px-3 font-medium">Current</th>
                  <th className="pb-3 px-3 font-medium">P&L</th>
                  <th className="pb-3 px-3 font-medium">Strategy</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos, i) => {
                  const pnl = Number(pos.pnl || 0);
                  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-white/40';
                  return (
                    <tr key={pos.id || i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors duration-200">
                      <td className="py-2.5 px-3 text-xs text-white/60">{pos.window_id || '--'}</td>
                      <td className="py-2.5 px-3 text-xs font-bold text-white/70">{(pos.side || '').toUpperCase()}</td>
                      <td className="py-2.5 px-3 text-xs text-white/40">${Number(pos.entry_price || 0).toFixed(2)}</td>
                      <td className="py-2.5 px-3 text-xs text-white/70">${Number(pos.current_price || pos.entry_price || 0).toFixed(2)}</td>
                      <td className={`py-2.5 px-3 text-xs font-bold ${pnlColor}`}>
                        {pnl > 0 ? '+' : ''}${pnl.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-white/30">{pos.strategy_id || '--'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function InstrumentDeepDive({ state, connected }) {
  const [selectedSymbol, setSelectedSymbol] = useState('btc');
  const [instruments, setInstruments] = useState({});

  const fetchInstruments = useCallback(async () => {
    try {
      const res = await fetch('/api/instruments');
      const data = await res.json();
      setInstruments(data.instruments || {});
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchInstruments();
    const interval = setInterval(fetchInstruments, 2000);
    return () => clearInterval(interval);
  }, [fetchInstruments]);

  const selected = instruments[selectedSymbol];

  return (
    <div className="space-y-4">
      {/* Instrument selector */}
      <div className="glass p-3 flex items-center gap-2">
        <span className="section-title mr-2">Instrument</span>
        {SYMBOLS.map((sym) => {
          const inst = instruments[sym];
          const price = inst?.oraclePrices?.chainlink?.price || inst?.oraclePrices?.polymarketRef?.price;
          const hasPositions = (inst?.positions || []).length > 0;

          return (
            <button
              key={sym}
              onClick={() => setSelectedSymbol(sym)}
              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-300 ${
                selectedSymbol === sym
                  ? 'bg-white/10 text-white border border-white/15 shadow-lg shadow-accent-violet/10'
                  : hasPositions
                    ? 'text-accent-green hover:bg-white/5 border border-accent-green/20'
                    : 'text-white/40 hover:text-white/60 hover:bg-white/5 border border-transparent'
              }`}
            >
              <span>{sym.toUpperCase()}</span>
              {price != null && (
                <span className="ml-2 text-[10px] opacity-50">
                  ${Number(price).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected instrument detail */}
      {selected ? (
        <InstrumentPanel data={selected} feedMonitor={state?.feedMonitor} symbol={selectedSymbol} />
      ) : (
        <div className="glass p-12 text-center">
          <p className="text-xs text-white/20">
            {connected ? 'Loading instrument data...' : 'Waiting for connection...'}
          </p>
        </div>
      )}
    </div>
  );
}
