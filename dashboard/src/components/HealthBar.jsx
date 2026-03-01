import React from 'react';

function formatUptime(seconds) {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function FeedDot({ label, status }) {
  let dotClass = 'bg-white/20';
  if (status === 'healthy' || status === 'connected') dotClass = 'bg-accent-green shadow-[0_0_6px_rgba(52,211,153,0.6)]';
  else if (status === 'stale') dotClass = 'bg-accent-yellow shadow-[0_0_6px_rgba(251,191,36,0.6)]';
  else if (status === 'dead' || status === 'disconnected') dotClass = 'bg-accent-red shadow-[0_0_6px_rgba(248,113,113,0.6)]';

  return (
    <div className="flex items-center gap-1.5 text-[10px] text-white/50" title={`${label}: ${status}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`} />
      {label}
    </div>
  );
}

/**
 * Summarize per-feed-symbol entries into per-feed status.
 * Takes the worst status across all symbols for each feed.
 */
function summarizeFeeds(feeds) {
  if (!feeds || typeof feeds !== 'object') return {};

  const feedSummary = {};
  const statusPriority = { dead: 0, stale: 1, no_data: 2, unknown: 3, healthy: 4 };

  for (const [key, entry] of Object.entries(feeds)) {
    const [feedName] = key.split(':');
    const st = entry.status || 'unknown';
    if (!feedSummary[feedName] || (statusPriority[st] ?? 3) < (statusPriority[feedSummary[feedName]] ?? 3)) {
      feedSummary[feedName] = st;
    }
  }

  return feedSummary;
}

export default function HealthBar({ state, connected }) {
  const wsColor = connected ? 'text-accent-green' : 'text-accent-red';
  const wsDot = connected
    ? 'bg-accent-green shadow-[0_0_8px_rgba(52,211,153,0.6)] animate-pulse-slow'
    : 'bg-accent-red shadow-[0_0_8px_rgba(248,113,113,0.6)]';

  const cbState = state?.circuitBreakerState || 'UNKNOWN';
  const cbColor =
    cbState === 'CLOSED'
      ? 'text-accent-green'
      : cbState === 'HALF_OPEN'
        ? 'text-accent-yellow'
        : cbState === 'OPEN'
          ? 'text-accent-red'
          : 'text-white/30';

  // Per-feed health from feed-monitor module
  const feedMonitor = state?.feedMonitor;
  const feedSummary = summarizeFeeds(feedMonitor?.feeds);
  const activeGapCount = feedMonitor?.activeGapCount || 0;

  // Key feeds to show in the health bar
  const keyFeeds = ['crypto_prices', 'crypto_prices_chainlink', 'binance', 'coinbaseexchange', 'kraken'];
  const feedLabels = {
    crypto_prices: 'REF',
    crypto_prices_chainlink: 'CL',
    binance: 'BIN',
    coinbaseexchange: 'CB',
    kraken: 'KRK',
  };

  return (
    <header className="bg-black/30 backdrop-blur-md border-b border-white/5 px-5 py-2 flex items-center justify-between text-[10px]">
      <div className="flex items-center gap-4">
        <span className="text-sm font-bold tracking-widest text-white/90">POLY</span>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${wsDot}`} />
          <span className={`font-medium ${wsColor}`}>{connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
        </div>
        <div className="w-px h-3 bg-white/10" />
        <span className={`font-semibold ${cbColor}`}>CB: {cbState}</span>
      </div>

      <div className="flex items-center gap-3">
        {keyFeeds.map((feed) => (
          <FeedDot
            key={feed}
            label={feedLabels[feed] || feed}
            status={feedSummary[feed] || 'unknown'}
          />
        ))}
        {activeGapCount > 0 && (
          <>
            <div className="w-px h-3 bg-white/10" />
            <span className="text-accent-red font-semibold">Gaps: {activeGapCount}</span>
          </>
        )}
        <div className="w-px h-3 bg-white/10" />
        <span className="text-white/35">
          Errors/1m: {state?.errorCount1m ?? '-'}
        </span>
        <div className="w-px h-3 bg-white/10" />
        <span className="text-white/35">
          Up: {formatUptime(state?.uptime)}
        </span>
      </div>
    </header>
  );
}
