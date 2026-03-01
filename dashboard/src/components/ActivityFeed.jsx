import React from 'react';

function formatTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

function eventColor(eventType) {
  switch (eventType) {
    case 'signal': return 'text-accent-blue';
    case 'order': return 'text-accent-yellow';
    case 'fill': return 'text-accent-green';
    case 'assertion': return 'text-gray-400';
    case 'window': return 'text-gray-500';
    case 'error': return 'text-accent-red';
    default: return 'text-gray-400';
  }
}

function eventLabel(eventType) {
  switch (eventType) {
    case 'signal': return 'SIGNAL';
    case 'order': return 'ORDER';
    case 'fill': return 'FILL';
    case 'assertion': return 'ASSERT';
    case 'window': return 'WINDOW';
    case 'error': return 'ERROR';
    default: return eventType?.toUpperCase() || 'EVENT';
  }
}

function formatEventData(event) {
  const e = event._event;
  const d = event;

  if (e === 'signal') {
    return `${d.strategy_id || d.strategyId || '?'} -> ${(d.symbol || '').toUpperCase()} ${d.side || d.direction || ''} (edge: ${d.edge != null ? (d.edge * 100).toFixed(1) + '%' : '?'})`;
  }
  if (e === 'order') {
    return `${d.side || ''} $${d.size_dollars || d.sizeDollars || '?'} @ $${d.price || '?'}`;
  }
  if (e === 'fill') {
    return `${d.shares || '?'} shares @ $${d.fill_price || d.fillPrice || '?'}`;
  }
  if (e === 'assertion') {
    const pass = d.passed ?? d.pass;
    return `${pass ? 'PASS' : 'FAIL'}: ${d.name || d.message || 'check'}`;
  }
  if (e === 'window') {
    return `Window ${d.window_id || d.windowId || '?'} ${d.action || d.status || ''}`;
  }

  // Fallback: show JSON snippet
  const keys = Object.keys(d).filter(k => !k.startsWith('_'));
  return keys.slice(0, 3).map(k => `${k}=${JSON.stringify(d[k])}`).join(' ');
}

export default function ActivityFeed({ events }) {
  return (
    <div className="bg-bg-secondary rounded-lg border border-gray-700 p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
        Activity Feed
      </h2>

      {events.length === 0 ? (
        <p className="text-xs text-gray-500">No events yet. Waiting for activity...</p>
      ) : (
        <div className="space-y-0.5 max-h-64 overflow-y-auto">
          {events.map((event, i) => (
            <div key={i} className="flex items-start gap-2 py-1 px-1 text-xs hover:bg-bg-tertiary/30 rounded">
              <span className="text-gray-500 shrink-0 w-16">
                {formatTime(event._ts)}
              </span>
              <span className={`shrink-0 w-14 font-semibold ${eventColor(event._event)}`}>
                {eventLabel(event._event)}
              </span>
              <span className="text-gray-300 truncate">
                {formatEventData(event)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
