/**
 * Structured Output Formatter (Story 3.4)
 *
 * Renders backtest results as CLI tables or JSON.
 * Ranks variants by Sharpe, flags unequal sample sizes.
 *
 * Covers: FR27, FR30, FR31, FR32, NFR6
 */

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** d) / 10 ** d;
}

function pad(str, len, align = 'left') {
  const s = String(str);
  return align === 'right' ? s.padStart(len) : s.padEnd(len);
}

/**
 * Render results table for a single backtest run (one symbol).
 */
export function renderResultsTable(result) {
  const { strategy, symbol, sampleSize, totalWindows, variants, baseline, wallClockMs, paramImportance } = result;

  const sourceLabel = result.source ? ` | source: ${result.source}` : '';
  console.log('\n' + '='.repeat(100));
  console.log(`FACTORY BACKTEST: ${strategy} | ${symbol.toUpperCase()} | ${sampleSize}/${totalWindows} windows | ${wallClockMs}ms${sourceLabel}`);
  console.log('NOTE: Sharpe is RAW (unannualized). Use for relative ranking, not absolute benchmarks.');
  console.log('='.repeat(100));

  if (variants.length === 0) {
    console.log('  No results.');
    return;
  }

  // Header
  const cols = [
    { label: '#', width: 4, align: 'right' },
    { label: 'Sharpe(raw)', width: 11, align: 'right' },
    { label: 'PF', width: 7, align: 'right' },
    { label: 'WinRate', width: 8, align: 'right' },
    { label: 'Trades', width: 7, align: 'right' },
    { label: 'PnL', width: 10, align: 'right' },
    { label: 'MaxDD', width: 8, align: 'right' },
    { label: 'Sortino(raw)', width: 12, align: 'right' },
    { label: 'Edge/Tr', width: 8, align: 'right' },
    { label: 'CI95', width: 16, align: 'right' },
    { label: 'Params', width: 30, align: 'left' },
  ];

  const header = cols.map(c => pad(c.label, c.width, c.align)).join(' | ');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const m = v.metrics;
    const ci = v.sharpeCi;
    const paramStr = Object.keys(v.params).length > 0
      ? Object.entries(v.params).map(([k, val]) => `${k}=${val}`).join(', ')
      : '(defaults)';

    const row = [
      pad(i + 1, 4, 'right'),
      pad(round(m.sharpe, 2), 11, 'right'),
      pad(round(m.profitFactor, 2), 7, 'right'),
      pad((round(m.winRate * 100, 1) + '%'), 8, 'right'),
      pad(m.trades, 7, 'right'),
      pad('$' + round(m.totalPnl, 2), 10, 'right'),
      pad((round(m.maxDrawdown * 100, 1) + '%'), 8, 'right'),
      pad(round(m.sortino, 2), 12, 'right'),
      pad(round(m.edgePerTrade, 4), 8, 'right'),
      pad(`[${round(ci.ci95Lower, 2)}, ${round(ci.ci95Upper, 2)}]`, 16, 'right'),
      pad(paramStr.slice(0, 30), 30, 'left'),
    ];
    console.log(row.join(' | '));
  }

  // Baseline
  if (baseline) {
    console.log('-'.repeat(header.length));
    const row = [
      pad('B', 4, 'right'),
      pad(round(baseline.sharpe, 2), 11, 'right'),
      pad(round(baseline.profitFactor, 2), 7, 'right'),
      pad((round(baseline.winRate * 100, 1) + '%'), 8, 'right'),
      pad(baseline.trades, 7, 'right'),
      pad('$' + round(baseline.totalPnl, 2), 10, 'right'),
      pad((round(baseline.maxDrawdown * 100, 1) + '%'), 8, 'right'),
      pad(round(baseline.sortino, 2), 12, 'right'),
      pad(round(baseline.edgePerTrade, 4), 8, 'right'),
      pad('', 16, 'right'),
      pad('baseline-random', 30, 'left'),
    ];
    console.log(row.join(' | '));
  }

  // Parameter importance
  if (paramImportance) {
    console.log('\nParameter Importance (avg Sharpe per value):');
    for (const [param, values] of Object.entries(paramImportance)) {
      const parts = Object.entries(values)
        .sort(([, a], [, b]) => b.avgSharpe - a.avgSharpe)
        .map(([val, data]) => `${val}: ${round(data.avgSharpe, 2)}`);
      console.log(`  ${param}: ${parts.join(' | ')}`);
    }
  }

  console.log('');
}

/**
 * Render cross-symbol comparison table.
 */
export function renderComparisonTable(results) {
  console.log('\n' + '='.repeat(80));
  console.log('CROSS-SYMBOL COMPARISON');
  console.log('='.repeat(80));

  // Check for unequal sample sizes
  const sizes = results.map(r => r.sampleSize);
  const unequal = new Set(sizes).size > 1;
  if (unequal) {
    console.log('  WARNING: Unequal sample sizes across symbols. Comparisons may be biased.');
  }

  const header = [
    pad('Symbol', 8),
    pad('Sharpe(raw)', 11, 'right'),
    pad('PF', 7, 'right'),
    pad('WinRate', 8, 'right'),
    pad('Trades', 7, 'right'),
    pad('PnL', 10, 'right'),
    pad('Samples', 8, 'right'),
  ].join(' | ');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const best = r.variants[0]; // ranked by Sharpe
    if (!best) continue;
    const m = best.metrics;
    const row = [
      pad(r.symbol.toUpperCase(), 8),
      pad(round(m.sharpe, 2), 11, 'right'),
      pad(round(m.profitFactor, 2), 7, 'right'),
      pad((round(m.winRate * 100, 1) + '%'), 8, 'right'),
      pad(m.trades, 7, 'right'),
      pad('$' + round(m.totalPnl, 2), 10, 'right'),
      pad(r.sampleSize, 8, 'right'),
    ];
    console.log(row.join(' | '));
  }
  console.log('');
}
