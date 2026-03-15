import React, { useState } from 'react';

/**
 * Data coverage grid: rows = symbols, columns = coverage metrics.
 * L2 availability color-coded: >80% green, 50-80% yellow, <50% red.
 */

function formatDate(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function CoverageMatrix({ coverage }) {
  const [expanded, setExpanded] = useState(null);

  if (!coverage || coverage.length === 0) {
    return (
      <div className="glass p-5 rounded-xl">
        <p className="text-xs text-white/25 text-center py-8">No coverage data available</p>
      </div>
    );
  }

  const hasTimeline = coverage.some(c => c.timeline);

  return (
    <div className="glass p-5 rounded-xl">
      <h2 className="section-title mb-4">Data Coverage</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/[0.08]">
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Symbol</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Total Results</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Strategies Tested</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Date Range</th>
              <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Avg Sample Size</th>
              {hasTimeline && (
                <>
                  <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">Windows</th>
                  <th className="text-[11px] text-white/35 font-semibold uppercase tracking-wider px-3 py-2.5 text-left">L2 Avail %</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {coverage.map((c, i) => {
              const rowTimeline = !!c.timeline;
              const l2Pct = c.timeline?.l2Availability;
              let l2Color = 'text-white/40';
              if (l2Pct != null) {
                l2Color = l2Pct > 80 ? 'text-emerald-400' : l2Pct > 50 ? 'text-yellow-400' : 'text-red-400';
              }

              return (
                <React.Fragment key={c.symbol}>
                  <tr
                    className={`border-t border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors duration-150 ${
                      expanded === c.symbol ? 'bg-white/[0.03]' : ''
                    }`}
                    onClick={() => setExpanded(expanded === c.symbol ? null : c.symbol)}
                  >
                    <td className="text-xs text-white/90 px-3 py-2.5 uppercase font-medium tracking-wide">
                      <span className={`mr-1.5 text-[10px] transition-transform duration-150 inline-block ${expanded === c.symbol ? 'text-white/40' : 'text-white/20'}`}>
                        {expanded === c.symbol ? '\u25BC' : '\u25B6'}
                      </span>
                      {c.symbol}
                    </td>
                    <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">{c.totalResults}</td>
                    <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">{c.uniqueStrategies}</td>
                    <td className="text-xs text-white/50 px-3 py-2.5 font-mono tabular-nums">
                      {c.dateRange
                        ? `${formatDate(c.dateRange.from)} \u2013 ${formatDate(c.dateRange.to)}`
                        : '--'
                      }
                    </td>
                    <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">{c.avgSampleSize ?? '--'}</td>
                    {hasTimeline && (
                      <>
                        <td className="text-xs text-white/70 px-3 py-2.5 font-mono tabular-nums">
                          {rowTimeline ? c.timeline.totalWindows : '--'}
                        </td>
                        <td className={`text-xs font-semibold px-3 py-2.5 font-mono tabular-nums ${l2Color}`}>
                          {l2Pct != null ? `${l2Pct.toFixed(0)}%` : '--'}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Expanded detail row */}
                  {expanded === c.symbol && (
                    <tr className="border-t border-white/[0.04]">
                      <td colSpan={hasTimeline ? 7 : 5} className="px-4 py-3">
                        <div className="glass-subtle p-3 rounded-lg">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[11px]">
                            <div>
                              <div className="label-xs mb-0.5">Results</div>
                              <div className="text-white/60 font-mono tabular-nums">{c.totalResults} across {c.uniqueStrategies} strategies</div>
                            </div>
                            <div>
                              <div className="label-xs mb-0.5">Avg Sample</div>
                              <div className="text-white/60 font-mono tabular-nums">{c.avgSampleSize ?? 'N/A'}</div>
                            </div>
                            {c.dateRange && (
                              <div>
                                <div className="label-xs mb-0.5">Data Range</div>
                                <div className="text-white/60 font-mono tabular-nums">{formatDate(c.dateRange.from)} \u2013 {formatDate(c.dateRange.to)}</div>
                              </div>
                            )}
                            {rowTimeline && c.timeline.dateRange && (
                              <div>
                                <div className="label-xs mb-0.5">Cache Range</div>
                                <div className="text-white/60 font-mono tabular-nums">{formatDate(c.timeline.dateRange.from)} \u2013 {formatDate(c.timeline.dateRange.to)}</div>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
