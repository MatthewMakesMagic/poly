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
  let color = 'bg-gray-500';
  if (status === 'healthy') color = 'bg-accent-green';
  else if (status === 'stale') color = 'bg-accent-yellow';
  else if (status === 'dead') color = 'bg-accent-red';
  else if (status === 'connected') color = 'bg-accent-green';
  else if (status === 'disconnected') color = 'bg-accent-red';

  return (
    <div className="flex items-center gap-1 text-xs text-gray-400" title={`${label}: ${status}`}>
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
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
  const wsLabel = connected ? 'WS' : 'WS DISCONNECTED';

  const cbState = state?.circuitBreakerState || 'UNKNOWN';
  const cbColor =
    cbState === 'CLOSED'
      ? 'text-accent-green'
      : cbState === 'HALF_OPEN'
        ? 'text-accent-yellow'
        : cbState === 'OPEN'
          ? 'text-accent-red'
          : 'text-gray-500';

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
    <header className="bg-bg-secondary border-b border-gray-700 px-4 py-1.5 flex items-center justify-between text-xs">
      <div className="flex items-center gap-4">
        <span className="text-gray-200 font-semibold">POLY</span>
        <span className={wsColor}>{wsLabel}</span>
        <span className={cbColor}>CB: {cbState}</span>
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
            <span className="text-gray-500">|</span>
            <span className="text-accent-red">Gaps: {activeGapCount}</span>
          </>
        )}
        <span className="text-gray-500">|</span>
        <span className="text-gray-400">
          Errors/1m: {state?.errorCount1m ?? '-'}
        </span>
        <span className="text-gray-500">|</span>
        <span className="text-gray-400">
          Uptime: {formatUptime(state?.uptime)}
        </span>
      </div>
    </header>
  );
}
