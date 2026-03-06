import React, { useMemo } from 'react';
import { runBacktest } from '../../lib/backtestEngine.js';

const STRATEGY_VARIANTS = [
  { label: 'Consensus @ 60s', strategy: 'consensus', entryOffset: 60 },
  { label: 'Consensus @ 30s', strategy: 'consensus', entryOffset: 30 },
  { label: 'Consensus @ 10s', strategy: 'consensus', entryOffset: 10 },
  { label: 'Contrarian @ 60s', strategy: 'contrarian', entryOffset: 60 },
  { label: 'Threshold 0.65 @ 60s', strategy: 'threshold', entryOffset: 60, clobThreshold: 0.65 },
  { label: 'Threshold 0.70 @ 30s', strategy: 'threshold', entryOffset: 30, clobThreshold: 0.70 },
];

export default React.memo(function ComparisonMatrix({ windows, filters }) {
  const results = useMemo(() => {
    if (!windows || windows.length === 0) return [];

    const shared = {
      symbols: filters?.symbols ?? [],
      dateFrom: filters?.dateFrom ?? '',
      dateTo: filters?.dateTo ?? '',
      confidenceMin: filters?.confidenceMin ?? 0,
      confidenceMax: filters?.confidenceMax ?? 1,
    };

    return STRATEGY_VARIANTS.map((variant) => {
      const overrides = {
        ...shared,
        strategy: variant.strategy,
        entryOffset: variant.entryOffset,
      };
      if (variant.clobThreshold !== undefined) {
        overrides.clobThreshold = variant.clobThreshold;
      }

      const result = runBacktest(windows, overrides);
      return { label: variant.label, ...result };
    });
  }, [windows, filters]);

  if (results.length === 0) {
    return (
      <div className="glass p-5">
        <h3 className="section-title mb-4">Strategy Comparison</h3>
        <p className="text-white/40 text-xs">No windows loaded.</p>
      </div>
    );
  }

  const maxTrades = Math.max(...results.map((r) => r.totalTrades));

  return (
    <div className="glass p-5">
      <h3 className="section-title mb-4">Strategy Comparison</h3>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-white/5">
            <th className="label-xs pb-2 pr-3">Strategy</th>
            <th className="label-xs pb-2 pr-3">Trades</th>
            <th className="label-xs pb-2 pr-3">Win Rate</th>
            <th className="label-xs pb-2 pr-3">P&L</th>
            <th className="label-xs pb-2 pr-3">Avg Entry</th>
            <th className="label-xs pb-2 pr-3">Profit Factor</th>
            <th className="label-xs pb-2">Expectancy</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const pnlPositive = r.totalPnl >= 0;
            const barWidth = maxTrades > 0 ? (r.totalTrades / maxTrades) * 100 : 0;
            const barOpacity = r.totalTrades >= 50 ? 1 : r.totalTrades < 20 ? 0.3 : 0.6;

            return (
              <tr key={r.label} className="border-b border-white/5">
                <td className="text-[10px] text-white/80 py-1.5 pr-3">{r.label}</td>
                <td className="text-[10px] text-white/60 py-1.5 pr-3">{r.totalTrades}</td>
                <td className="text-[10px] text-white/80 py-1.5 pr-3">
                  <div className="relative w-full">
                    <div
                      className="absolute inset-y-0 left-0 bg-accent-violet/20 rounded-sm"
                      style={{ width: `${barWidth}%`, opacity: barOpacity }}
                    />
                    <span className="relative z-10">
                      {(r.winRate * 100).toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td
                  className={`text-[10px] py-1.5 pr-3 rounded-sm ${
                    pnlPositive
                      ? 'text-accent-green bg-accent-green/10'
                      : 'text-accent-red bg-accent-red/10'
                  }`}
                >
                  {pnlPositive ? '+' : ''}{r.totalPnl.toFixed(2)}
                </td>
                <td className="text-[10px] text-white/60 py-1.5 pr-3">
                  {r.avgEntry.toFixed(3)}
                </td>
                <td className="text-[10px] text-white/60 py-1.5 pr-3">
                  {r.profitFactor === Infinity ? '\u221e' : r.profitFactor.toFixed(2)}
                </td>
                <td className="text-[10px] text-white/60 py-1.5">
                  {r.expectancy >= 0 ? '+' : ''}{r.expectancy.toFixed(4)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
