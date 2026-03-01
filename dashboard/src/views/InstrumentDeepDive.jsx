import React, { useState, useEffect, useCallback } from 'react';

const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];

function tickAge(updatedAt) {
  if (!updatedAt) return null;
  return (Date.now() - new Date(updatedAt).getTime()) / 1000;
}

function AgeDot({ seconds }) {
  if (seconds == null) return <span className="inline-block w-2 h-2 rounded-full bg-gray-600" />;
  if (seconds < 2) return <span className="inline-block w-2 h-2 rounded-full bg-accent-green" />;
  if (seconds < 5) return <span className="inline-block w-2 h-2 rounded-full bg-accent-yellow" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-accent-red" />;
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
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-bg-tertiary/30">
      <div className="flex items-center gap-2">
        <AgeDot seconds={age} />
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-200 font-semibold">
          {price != null ? `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
        </span>
        <span className="text-xs text-gray-500 w-8 text-right">{formatAge(age)}</span>
      </div>
    </div>
  );
}

function FeedStatusBadge({ status }) {
  const colors = {
    healthy: 'bg-green-900/50 text-accent-green',
    stale: 'bg-yellow-900/50 text-accent-yellow',
    dead: 'bg-red-900/50 text-accent-red',
    no_data: 'bg-gray-800 text-gray-500',
    unknown: 'bg-gray-800 text-gray-500',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs ${colors[status] || colors.unknown}`}>
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
    <div className="space-y-4">
      {/* Oracle Prices */}
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Oracle Prices
        </h3>
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
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Exchange Prices
        </h3>
        {Object.keys(exchanges).length === 0 ? (
          <p className="text-xs text-gray-500">No recent exchange data</p>
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
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Feed Health
        </h3>
        {Object.keys(symbolFeeds).length === 0 && Object.keys(feedHealth).length === 0 ? (
          <p className="text-xs text-gray-500">No feed data available</p>
        ) : (
          <div className="space-y-0.5">
            {Object.entries(symbolFeeds).map(([feed, entry]) => (
              <div key={feed} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-bg-tertiary/30">
                <div className="flex items-center gap-2">
                  <AgeDot seconds={entry.ageMs != null ? entry.ageMs / 1000 : null} />
                  <span className="text-xs text-gray-400">{feed}</span>
                </div>
                <div className="flex items-center gap-3">
                  <FeedStatusBadge status={entry.status} />
                  <span className="text-xs text-gray-500 w-8 text-right">
                    {formatAge(entry.ageMs != null ? entry.ageMs / 1000 : null)}
                  </span>
                  {entry.inGap && (
                    <span className="text-xs text-accent-red font-semibold">GAP</span>
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
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Active Windows
        </h3>
        {windows.length === 0 ? (
          <p className="text-xs text-gray-500">No active windows</p>
        ) : (
          <div className="space-y-1">
            {windows.map((w, i) => {
              const remaining = w.timeRemainingMs ? Math.floor(w.timeRemainingMs / 1000) : null;
              const minutes = remaining != null ? Math.floor(remaining / 60) : null;
              const secs = remaining != null ? remaining % 60 : null;
              return (
                <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-bg-tertiary/30">
                  <span className="text-xs text-gray-300">{w.windowId || '--'}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-400">
                      Strike: ${w.referencePrice != null ? Number(w.referencePrice).toLocaleString() : '--'}
                    </span>
                    <span className="text-xs text-gray-400">
                      YES: {w.yesPrice != null ? `$${Number(w.yesPrice).toFixed(2)}` : '--'}
                    </span>
                    <span className={`text-xs font-semibold ${
                      remaining != null && remaining < 60 ? 'text-accent-red' :
                      remaining != null && remaining < 300 ? 'text-accent-yellow' :
                      'text-gray-400'
                    }`}>
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
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Open Positions
        </h3>
        {positions.length === 0 ? (
          <p className="text-xs text-gray-500">No open positions</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs text-gray-500 uppercase">
                  <th className="pb-2 px-2">Window</th>
                  <th className="pb-2 px-2">Side</th>
                  <th className="pb-2 px-2">Entry</th>
                  <th className="pb-2 px-2">Current</th>
                  <th className="pb-2 px-2">P&L</th>
                  <th className="pb-2 px-2">Strategy</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos, i) => {
                  const pnl = Number(pos.pnl || 0);
                  const pnlColor = pnl > 0 ? 'text-accent-green' : pnl < 0 ? 'text-accent-red' : 'text-gray-400';
                  return (
                    <tr key={pos.id || i} className="border-t border-gray-700/50 hover:bg-bg-tertiary/30">
                      <td className="py-2 px-2 text-sm text-gray-300">{pos.window_id || '--'}</td>
                      <td className="py-2 px-2 text-sm text-gray-300">{(pos.side || '').toUpperCase()}</td>
                      <td className="py-2 px-2 text-sm text-gray-400">${Number(pos.entry_price || 0).toFixed(2)}</td>
                      <td className="py-2 px-2 text-sm text-gray-300">${Number(pos.current_price || pos.entry_price || 0).toFixed(2)}</td>
                      <td className={`py-2 px-2 text-sm font-semibold ${pnlColor}`}>
                        {pnl > 0 ? '+' : ''}${pnl.toFixed(2)}
                      </td>
                      <td className="py-2 px-2 text-sm text-gray-500">{pos.strategy_id || '--'}</td>
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
      <div className="bg-bg-secondary rounded-lg border border-gray-700 p-3 flex items-center gap-3">
        <span className="text-xs text-gray-400 uppercase tracking-wider">Instrument:</span>
        {SYMBOLS.map((sym) => {
          const inst = instruments[sym];
          const price = inst?.oraclePrices?.chainlink?.price || inst?.oraclePrices?.polymarketRef?.price;
          const hasPositions = (inst?.positions || []).length > 0;

          return (
            <button
              key={sym}
              onClick={() => setSelectedSymbol(sym)}
              className={`px-3 py-1.5 rounded text-sm font-semibold transition-colors ${
                selectedSymbol === sym
                  ? 'bg-accent-blue text-white'
                  : hasPositions
                    ? 'text-accent-green hover:bg-bg-tertiary border border-green-800'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-bg-tertiary'
              }`}
            >
              <span>{sym.toUpperCase()}</span>
              {price != null && (
                <span className="ml-2 text-xs opacity-70">
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
        <div className="bg-bg-secondary rounded-lg border border-gray-700 p-8 text-center">
          <p className="text-sm text-gray-500">
            {connected ? 'Loading instrument data...' : 'Waiting for connection...'}
          </p>
        </div>
      )}
    </div>
  );
}
