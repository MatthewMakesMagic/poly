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
    case 'assertion': return 'text-white/40';
    case 'window': return 'text-accent-violet';
    case 'error': return 'text-accent-red';
    default: return 'text-white/40';
  }
}

function eventBgColor(eventType) {
  switch (eventType) {
    case 'signal': return 'bg-accent-blue/10';
    case 'order': return 'bg-accent-yellow/10';
    case 'fill': return 'bg-accent-green/10';
    case 'error': return 'bg-accent-red/10';
    default: return 'bg-white/[0.02]';
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
    if (d.action) return d.action + (d.count != null ? ` (${d.count} open)` : '');
    return `${d.side || ''} $${d.size_dollars || d.sizeDollars || '?'} @ $${d.price || '?'}`;
  }
  if (e === 'fill') {
    if (d.action) return d.action + (d.strategy_id ? ` [${d.strategy_id}]` : '') + (d.symbol ? ` ${d.symbol}` : '');
    return `${d.shares || '?'} shares @ $${d.fill_price || d.fillPrice || '?'}`;
  }
  if (e === 'assertion') {
    const pass = d.passed ?? d.pass;
    return `${pass ? 'PASS' : 'FAIL'}: ${d.name || d.message || 'check'}`;
  }
  if (e === 'window') {
    return `${d.window_id || d.windowId || '?'} ${d.action || d.status || ''}`;
  }
  if (e === 'error') {
    return d.message || d.error || 'Unknown error';
  }

  // Fallback: show JSON snippet
  const keys = Object.keys(d).filter(k => !k.startsWith('_'));
  return keys.slice(0, 3).map(k => `${k}=${JSON.stringify(d[k])}`).join(' ');
}

export default function ActivityFeed({ events }) {
  return (
    <div className="glass p-5">
      <h2 className="section-title mb-4">Activity Feed</h2>

      {events.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-xs text-white/20">Waiting for activity...</p>
        </div>
      ) : (
        <div className="space-y-0.5 max-h-72 overflow-y-auto pr-1">
          {events.map((event, i) => (
            <div key={i} className={`flex items-start gap-2 py-1.5 px-2 text-[11px] rounded-md transition-colors duration-200 ${eventBgColor(event._event)} hover:bg-white/[0.04]`}>
              <span className="text-white/25 shrink-0 w-14 font-light">
                {formatTime(event._ts)}
              </span>
              <span className={`shrink-0 w-12 font-bold ${eventColor(event._event)}`}>
                {eventLabel(event._event)}
              </span>
              <span className="text-white/60 truncate">
                {formatEventData(event)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
