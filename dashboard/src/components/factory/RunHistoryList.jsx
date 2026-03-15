import React from 'react';
import { formatMetric } from './chart-theme.js';

/**
 * List of factory batch runs with status, timestamp, and summary stats.
 */

function StatusBadge({ status }) {
  const colors = {
    completed: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20',
    running: 'bg-yellow-500/15 text-yellow-400 ring-1 ring-yellow-500/20',
    failed: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-semibold rounded-full tracking-wide ${colors[status] || 'bg-white/10 text-white/40'}`}>
      {status}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export default function RunHistoryList({ runs, onSelectRun }) {
  if (!runs || runs.length === 0) {
    return (
      <div className="glass p-5 rounded-xl">
        <h2 className="section-title mb-4">Recent Runs</h2>
        <p className="text-xs text-white/20 text-center py-8">No factory runs found</p>
      </div>
    );
  }

  return (
    <div className="glass p-5 rounded-xl">
      <h2 className="section-title mb-4">Recent Runs</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Date</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Status</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Manifest</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Strategies</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Duration</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Best Sharpe</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run, i) => {
              const bestSharpe = run.summary?.bestSharpe;
              const progress = run.total_runs ? Math.round((run.completed_runs / run.total_runs) * 100) : 0;

              return (
                <tr
                  key={run.run_id}
                  className={`border-t border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors duration-150 ${
                    i === 0 && run.status === 'running' ? 'bg-yellow-500/[0.03]' : ''
                  }`}
                  onClick={() => onSelectRun?.(run)}
                >
                  <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">{formatDate(run.started_at)}</td>
                  <td className="text-xs px-3 py-2.5">
                    <StatusBadge status={run.status} />
                    {run.status === 'running' && (
                      <div className="mt-1.5 w-20 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-yellow-400/50 rounded-full transition-all duration-500"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    )}
                  </td>
                  <td className="text-xs text-white/55 px-3 py-2.5 font-mono tracking-tight">{run.manifest_name}</td>
                  <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">
                    {run.status === 'running'
                      ? `${run.completed_runs}/${run.total_runs}`
                      : run.total_runs ?? '--'
                    }
                  </td>
                  <td className="text-xs text-white/50 px-3 py-2.5 font-mono tabular-nums">{formatDuration(run.wall_clock_ms)}</td>
                  <td className={`text-xs font-semibold px-3 py-2.5 font-mono tabular-nums ${bestSharpe > 0 ? 'text-emerald-400' : 'text-white/25'}`}>
                    {bestSharpe != null ? formatMetric(bestSharpe, 'sharpe') : '--'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
