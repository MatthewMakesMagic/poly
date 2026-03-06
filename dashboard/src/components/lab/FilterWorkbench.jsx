import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { runBacktest } from '../../lib/backtestEngine.js';

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const ENTRY_OFFSETS = [60, 30, 10, 5, 1];
const STRATEGIES = ['consensus', 'contrarian', 'threshold'];

const inputClass =
  'bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300';
const selectClass = `${inputClass} appearance-none`;

export default React.memo(function FilterWorkbench({ windows, filters, onFiltersChange }) {
  const results = useMemo(
    () => runBacktest(windows, filters),
    [windows, filters],
  );

  const { totalTrades, winRate, avgEntry, totalPnl, profitFactor, expectancy, equityCurve } = results;

  const update = (key, value) => onFiltersChange({ ...filters, [key]: value });

  const toggleSymbol = (sym) => {
    const current = filters.symbols || [];
    const lower = sym.toLowerCase();
    const next = current.includes(lower)
      ? current.filter((s) => s !== lower)
      : [...current, lower];
    update('symbols', next);
  };

  return (
    <div className="glass p-5">
      {/* ── Filter Controls ── */}
      <div className="section-title mb-4">Filters</div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        {/* Symbols */}
        <div>
          <div className="label-xs mb-1">Symbol</div>
          <div className="flex flex-wrap gap-1">
            {SYMBOLS.map((sym) => {
              const active = (filters.symbols || []).includes(sym.toLowerCase());
              return (
                <button
                  key={sym}
                  onClick={() => toggleSymbol(sym)}
                  className={`px-2 py-1 rounded text-xs font-semibold transition-all duration-300 border ${
                    active
                      ? 'bg-white/10 text-white border-white/20'
                      : 'text-white/30 border-transparent hover:text-white/50'
                  }`}
                >
                  {sym}
                </button>
              );
            })}
          </div>
        </div>

        {/* Date From */}
        <div>
          <div className="label-xs mb-1">From</div>
          <input
            type="date"
            value={filters.dateFrom || ''}
            onChange={(e) => update('dateFrom', e.target.value)}
            className={inputClass + ' w-full'}
          />
        </div>

        {/* Date To */}
        <div>
          <div className="label-xs mb-1">To</div>
          <input
            type="date"
            value={filters.dateTo || ''}
            onChange={(e) => update('dateTo', e.target.value)}
            className={inputClass + ' w-full'}
          />
        </div>

        {/* Confidence */}
        <div>
          <div className="label-xs mb-1">
            Confidence {Number(filters.confidenceMin || 0).toFixed(2)}–{Number(filters.confidenceMax ?? 1).toFixed(2)}
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={filters.confidenceMin || 0}
            onChange={(e) => update('confidenceMin', Number(e.target.value))}
            className="w-full accent-accent-violet"
          />
        </div>

        {/* Entry Offset */}
        <div>
          <div className="label-xs mb-1">Entry Offset</div>
          <select
            value={filters.entryOffset || 60}
            onChange={(e) => update('entryOffset', Number(e.target.value))}
            className={selectClass + ' w-full'}
          >
            {ENTRY_OFFSETS.map((o) => (
              <option key={o} value={o}>
                {o}s
              </option>
            ))}
          </select>
        </div>

        {/* Strategy */}
        <div>
          <div className="label-xs mb-1">Strategy</div>
          <select
            value={filters.strategy || 'consensus'}
            onChange={(e) => update('strategy', e.target.value)}
            className={selectClass + ' w-full'}
          >
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        {/* CLOB Threshold — only when strategy === 'threshold' */}
        {filters.strategy === 'threshold' && (
          <div>
            <div className="label-xs mb-1">
              CLOB Threshold {Number(filters.clobThreshold ?? 0.5).toFixed(2)}
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={filters.clobThreshold ?? 0.5}
              onChange={(e) => update('clobThreshold', Number(e.target.value))}
              className="w-full accent-accent-violet"
            />
          </div>
        )}
      </div>

      {/* ── Results Summary ── */}
      <div className="section-title mb-4">Results</div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-4 mb-6">
        <div>
          <div className="value-lg">{(winRate * 100).toFixed(1)}%</div>
          <div className="label-xs">Win Rate</div>
        </div>
        <div>
          <div className="value-lg">{totalTrades}</div>
          <div className="label-xs">Total Trades</div>
        </div>
        <div>
          <div className="value-lg">{avgEntry.toFixed(3)}</div>
          <div className="label-xs">Avg Entry</div>
        </div>
        <div>
          <div className={`value-lg ${totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </div>
          <div className="label-xs">Total P&L</div>
        </div>
        <div>
          <div className="value-lg">{profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}</div>
          <div className="label-xs">Profit Factor</div>
        </div>
        <div>
          <div className={`value-lg ${expectancy >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            {expectancy >= 0 ? '+' : ''}{expectancy.toFixed(4)}
          </div>
          <div className="label-xs">Expectancy</div>
        </div>
      </div>

      {/* ── Equity Curve ── */}
      {equityCurve.length > 0 && (
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityCurve}>
              <defs>
                <linearGradient id="eqGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="idx"
                stroke="rgba(255,255,255,0.15)"
                tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
              />
              <YAxis
                stroke="rgba(255,255,255,0.15)"
                tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.3)' }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgba(15, 23, 42, 0.9)',
                  backdropFilter: 'blur(12px)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '8px',
                  fontSize: '11px',
                  color: 'rgba(255,255,255,0.8)',
                }}
              />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke="#34d399"
                fill="url(#eqGradient)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
});
