import React, { useState, useEffect, useCallback } from 'react';

const STATUS_DOT = {
  healthy: 'bg-accent-green shadow-[0_0_6px_rgba(52,211,153,0.5)]',
  stale: 'bg-accent-yellow shadow-[0_0_6px_rgba(251,191,36,0.5)]',
  dead: 'bg-accent-red shadow-[0_0_6px_rgba(248,113,113,0.5)]',
};

const ORACLE_FEEDS = ['crypto_prices', 'crypto_prices_chainlink', 'crypto_prices_pyth'];

function classifyFeed(key) {
  const prefix = key.split(':')[0];
  return ORACLE_FEEDS.includes(prefix) ? 'oracle' : 'exchange';
}

export default React.memo(function FeedHealthPanel() {
  const [feeds, setFeeds] = useState({});
  const [activeGapCount, setActiveGapCount] = useState(0);
  const [recentGaps, setRecentGaps] = useState([]);
  const [error, setError] = useState(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/feed-health');
      const data = await res.json();
      setFeeds(data.feeds || {});
      setActiveGapCount(data.activeGapCount || 0);
      setRecentGaps(data.recentGaps || []);
      setError(null);
    } catch {
      setError('Failed to load feed health');
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const feedEntries = Object.entries(feeds);
  const counts = { healthy: 0, stale: 0, dead: 0 };
  for (const [, f] of feedEntries) {
    const s = f.status || 'dead';
    if (counts[s] !== undefined) counts[s]++;
  }

  const oracleFeeds = feedEntries.filter(([k]) => classifyFeed(k) === 'oracle');
  const exchangeFeeds = feedEntries.filter(([k]) => classifyFeed(k) === 'exchange');

  return (
    <div className="glass p-5 space-y-4">
      <h2 className="section-title">Feed Health</h2>

      {error && <p className="text-xs text-accent-red/70">{error}</p>}

      {/* Summary bar */}
      <div className="flex items-center gap-4 text-[11px]">
        <span className="text-accent-green/80">{counts.healthy} healthy</span>
        <span className="text-accent-yellow/80">{counts.stale} stale</span>
        <span className="text-accent-red/80">{counts.dead} dead</span>
        <span className="text-white/30 ml-auto">{activeGapCount} active gap{activeGapCount !== 1 ? 's' : ''}</span>
      </div>

      {/* Dead feed alert */}
      {counts.dead > 20 && (
        <div className="rounded-lg bg-accent-red/15 border border-accent-red/30 px-4 py-2 text-xs text-accent-red font-semibold animate-pulse">
          {counts.dead} feeds are dead — check infrastructure
        </div>
      )}

      {/* Oracle feeds */}
      {oracleFeeds.length > 0 && (
        <FeedGroup label="Oracle Feeds" feeds={oracleFeeds} />
      )}

      {/* Exchange feeds */}
      {exchangeFeeds.length > 0 && (
        <FeedGroup label="Exchange Feeds" feeds={exchangeFeeds} />
      )}

      {/* Recent gaps table */}
      {recentGaps.length > 0 && (
        <div>
          <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Recent Gaps</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-white/20 text-left">
                  <th className="pb-1 pr-3 font-medium">Feed</th>
                  <th className="pb-1 pr-3 font-medium">Symbol</th>
                  <th className="pb-1 pr-3 font-medium">Started</th>
                  <th className="pb-1 font-medium text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recentGaps.map((gap, i) => (
                  <tr key={i} className="text-white/40 border-t border-white/5">
                    <td className="py-1 pr-3">{gap.feed_name}</td>
                    <td className="py-1 pr-3">{gap.symbol}</td>
                    <td className="py-1 pr-3">
                      {gap.gap_start
                        ? new Date(gap.gap_start).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        : '--'}
                    </td>
                    <td className="py-1 text-right">
                      {gap.duration_seconds != null ? `${gap.duration_seconds}s` : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
});

function FeedGroup({ label, feeds }) {
  return (
    <div>
      <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-2">{label}</h3>
      <div className="flex flex-wrap gap-2">
        {feeds.map(([key, data]) => {
          const status = data.status || 'dead';
          const ageMs = data.ageMs != null ? data.ageMs : null;
          const ageLabel = ageMs != null
            ? ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`
            : '--';

          return (
            <div
              key={key}
              className="flex items-center gap-1.5 rounded-md bg-white/[0.03] border border-white/5 px-2 py-1"
              title={`${key}: ${status} (${ageLabel})`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[status] || STATUS_DOT.dead}`} />
              <span className="text-[10px] text-white/50">{key}</span>
              <span className="text-[9px] text-white/20">{ageLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
