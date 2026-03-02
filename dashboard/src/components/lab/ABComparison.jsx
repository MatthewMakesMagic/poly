import React, { useState, useMemo } from 'react';
import { runBacktest } from '../../lib/backtestEngine.js';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const STRATEGIES = ['consensus', 'contrarian', 'threshold'];
const ENTRY_OFFSETS = [60, 30, 10, 5, 1];

const inputClass =
  'bg-white/5 text-white/70 text-xs px-3 py-2 rounded-lg border border-white/10 focus:outline-none focus:border-accent-violet/50 focus:ring-1 focus:ring-accent-violet/20 transition-all duration-300';
const selectClass = `${inputClass} appearance-none`;

const tooltipStyle = {
  backgroundColor: 'rgba(15,23,42,0.9)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '8px',
  fontSize: '11px',
  color: 'rgba(255,255,255,0.8)',
};

const tickStyle = { fontSize: 9, fill: 'rgba(255,255,255,0.3)' };
const axisStroke = 'rgba(255,255,255,0.15)';

const DEFAULT_A = {
  strategy: 'consensus',
  entryOffset: 60,
  confidenceMin: 0,
  confidenceMax: 1,
  clobThreshold: 0.5,
  symbols: [],
  dateFrom: '',
  dateTo: '',
};

const DEFAULT_B = {
  strategy: 'contrarian',
  entryOffset: 60,
  confidenceMin: 0,
  confidenceMax: 1,
  clobThreshold: 0.5,
  symbols: [],
  dateFrom: '',
  dateTo: '',
};

/* ── Chi-squared significance test ── */
function chiSquaredTest(winsA, lossesA, winsB, lossesB) {
  const totalA = winsA + lossesA;
  const totalB = winsB + lossesB;
  const total = totalA + totalB;

  if (total === 0 || totalA === 0 || totalB === 0) {
    return { chi2: 0, pValue: 1, label: 'NS', significant: false };
  }

  const totalWins = winsA + winsB;
  const totalLosses = lossesA + lossesB;

  // Expected values for 2x2 contingency table
  const eWA = (totalA * totalWins) / total;
  const eLA = (totalA * totalLosses) / total;
  const eWB = (totalB * totalWins) / total;
  const eLB = (totalB * totalLosses) / total;

  // Avoid division by zero
  if (eWA === 0 || eLA === 0 || eWB === 0 || eLB === 0) {
    return { chi2: 0, pValue: 1, label: 'NS', significant: false };
  }

  const chi2 =
    Math.pow(winsA - eWA, 2) / eWA +
    Math.pow(lossesA - eLA, 2) / eLA +
    Math.pow(winsB - eWB, 2) / eWB +
    Math.pow(lossesB - eLB, 2) / eLB;

  let pValue, label, significant;
  if (chi2 > 6.64) {
    pValue = 0.01;
    label = 'p < 0.01';
    significant = true;
  } else if (chi2 > 3.84) {
    pValue = 0.05;
    label = 'p < 0.05';
    significant = true;
  } else {
    pValue = 1;
    label = 'NS';
    significant = false;
  }

  return { chi2, pValue, label, significant };
}

/* ── Filter Panel sub-component ── */
function FilterPanel({ label, filters, onChange }) {
  const update = (key, value) => onChange({ ...filters, [key]: value });

  return (
    <div>
      <div className="label-xs mb-3 text-white/60">{label}</div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {/* Strategy */}
        <div>
          <div className="label-xs mb-1">Strategy</div>
          <select
            value={filters.strategy}
            onChange={(e) => update('strategy', e.target.value)}
            className={selectClass + ' w-full'}
          >
            {STRATEGIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Entry Offset */}
        <div>
          <div className="label-xs mb-1">Entry Offset</div>
          <select
            value={filters.entryOffset}
            onChange={(e) => update('entryOffset', Number(e.target.value))}
            className={selectClass + ' w-full'}
          >
            {ENTRY_OFFSETS.map((o) => (
              <option key={o} value={o}>{o}s</option>
            ))}
          </select>
        </div>

        {/* Confidence Min */}
        <div>
          <div className="label-xs mb-1">
            Confidence Min {Number(filters.confidenceMin).toFixed(2)}
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={filters.confidenceMin}
            onChange={(e) => update('confidenceMin', Number(e.target.value))}
            className="w-full accent-accent-violet"
          />
        </div>

        {/* CLOB Threshold — only when strategy === 'threshold' */}
        {filters.strategy === 'threshold' && (
          <div>
            <div className="label-xs mb-1">
              CLOB Threshold {Number(filters.clobThreshold).toFixed(2)}
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={filters.clobThreshold}
              onChange={(e) => update('clobThreshold', Number(e.target.value))}
              className="w-full accent-accent-violet"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Results Summary sub-component ── */
function ResultsSummary({ label, results }) {
  const { totalTrades, winRate, totalPnl, expectancy } = results;

  return (
    <div>
      <div className="label-xs mb-2 text-white/40">{label} Results</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="value-lg">{totalTrades}</div>
          <div className="label-xs">Trades</div>
        </div>
        <div>
          <div className="value-lg">{(winRate * 100).toFixed(1)}%</div>
          <div className="label-xs">Win Rate</div>
        </div>
        <div>
          <div className={`value-lg ${totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
          </div>
          <div className="label-xs">P&L</div>
        </div>
        <div>
          <div className={`value-lg ${expectancy >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            {expectancy >= 0 ? '+' : ''}{expectancy.toFixed(4)}
          </div>
          <div className="label-xs">Expectancy</div>
        </div>
      </div>
    </div>
  );
}

/* ── Main Component ── */
export default React.memo(function ABComparison({ windows }) {
  const [filtersA, setFiltersA] = useState(DEFAULT_A);
  const [filtersB, setFiltersB] = useState(DEFAULT_B);

  const resultsA = useMemo(
    () => runBacktest(windows, filtersA),
    [windows, filtersA],
  );

  const resultsB = useMemo(
    () => runBacktest(windows, filtersB),
    [windows, filtersB],
  );

  // Build merged equity curve data aligned on trade index
  const mergedCurve = useMemo(() => {
    const curveA = resultsA.equityCurve;
    const curveB = resultsB.equityCurve;
    const maxLen = Math.max(curveA.length, curveB.length);
    const data = [];

    for (let i = 0; i < maxLen; i++) {
      data.push({
        idx: i + 1,
        pnlA: i < curveA.length ? curveA[i].pnl : (curveA.length > 0 ? curveA[curveA.length - 1].pnl : 0),
        pnlB: i < curveB.length ? curveB[i].pnl : (curveB.length > 0 ? curveB[curveB.length - 1].pnl : 0),
      });
    }

    return data;
  }, [resultsA, resultsB]);

  // Chi-squared significance test
  const significance = useMemo(
    () => chiSquaredTest(resultsA.wins, resultsA.losses, resultsB.wins, resultsB.losses),
    [resultsA, resultsB],
  );

  return (
    <div className="space-y-4">
      {/* ── Side-by-side Filter Panels ── */}
      <div className="grid grid-cols-2 gap-4">
        <div className="glass p-5">
          <div className="section-title mb-4">Strategy A</div>
          <FilterPanel label="A" filters={filtersA} onChange={setFiltersA} />
          <ResultsSummary label="A" results={resultsA} />
        </div>

        <div className="glass p-5">
          <div className="section-title mb-4">Strategy B</div>
          <FilterPanel label="B" filters={filtersB} onChange={setFiltersB} />
          <ResultsSummary label="B" results={resultsB} />
        </div>
      </div>

      {/* ── Overlaid Equity Curve ── */}
      {mergedCurve.length > 0 && (
        <div className="glass p-5">
          <div className="section-title mb-4">Equity Curves</div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={mergedCurve} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                <defs>
                  <linearGradient id="abGradientA" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="idx"
                  stroke={axisStroke}
                  tick={tickStyle}
                />
                <YAxis
                  stroke={axisStroke}
                  tick={tickStyle}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend
                  wrapperStyle={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)' }}
                />
                <Area
                  type="monotone"
                  dataKey="pnlA"
                  name="Strategy A"
                  stroke="#a78bfa"
                  fill="url(#abGradientA)"
                  strokeWidth={1.5}
                />
                <Line
                  type="monotone"
                  dataKey="pnlB"
                  name="Strategy B"
                  stroke="#34d399"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Statistical Significance ── */}
      <div className="glass p-5">
        <div className="section-title mb-4">Statistical Significance</div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="value-lg">{significance.chi2.toFixed(3)}</div>
            <div className="label-xs">Chi-squared</div>
          </div>
          <div>
            <div className={`value-lg ${
              significance.pValue <= 0.01
                ? 'text-accent-green'
                : significance.pValue <= 0.05
                  ? 'text-yellow-400'
                  : 'text-white/40'
            }`}>
              {significance.label}
            </div>
            <div className="label-xs">P-value</div>
          </div>
          <div>
            <div className={`value-lg ${
              significance.significant ? 'text-accent-green' : 'text-white/40'
            }`}>
              {significance.significant ? 'Significant' : 'Not Significant'}
            </div>
            <div className="label-xs">Result</div>
          </div>
        </div>

        <div className="mt-4 text-[10px] text-white/30">
          Chi-squared test on win/loss counts (1 df). p &lt; 0.05 = significant difference between strategies.
        </div>
      </div>
    </div>
  );
});
