#!/usr/bin/env node

/**
 * Local backtest runner: ALL strategies x ALL symbols against ground truth.
 * Reads from local SQLite (data/backtest.sqlite) — no Postgres needed.
 * Writes results to JSON files in data/results/.
 *
 * Usage:
 *   node scripts/run-backtest-local.mjs
 *   node scripts/run-backtest-local.mjs --strategy=contested-contrarian
 *   node scripts/run-backtest-local.mjs --symbol=btc --limit=50
 */

import { writeFileSync, readdirSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import { pathToFileURL } from 'url';
import {
  loadWindowsWithGroundTruth,
  loadWindowTickData,
  close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import {
  runParallelBacktest,
} from '../src/backtest/parallel-engine.js';
import { calculateMetrics, calculateBinaryMetrics } from '../src/backtest/metrics.js';

const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] || '50', 10);
const OUTPUT_PATH = process.argv.find(a => a.startsWith('--output='))?.split('=')[1] || null;
const SINGLE = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1] || null;
const WINDOW_LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const SYMBOL_FILTER = process.argv.find(a => a.startsWith('--symbol='))?.split('=')[1]?.toLowerCase() || null;
const START_DATE = process.argv.find(a => a.startsWith('--start-date='))?.split('=')[1] || null;

const CHEAP_BUCKETS = [
  { label: '<$0.10', max: 0.10 },
  { label: '$0.10-0.20', min: 0.10, max: 0.20 },
  { label: '$0.20-0.30', min: 0.20, max: 0.30 },
  { label: '$0.30-0.50', min: 0.30, max: 0.50 },
  { label: '>$0.50', min: 0.50 },
];

async function discoverStrategies() {
  const dir = resolve(process.cwd(), 'src/backtest/strategies');
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  const strategies = [];
  for (const file of files) {
    const name = basename(file, '.js');
    if (SINGLE && name !== SINGLE) continue;
    try {
      const mod = await import(pathToFileURL(resolve(dir, file)).href);
      if (typeof mod.evaluate !== 'function') continue;
      strategies.push({
        name: mod.name || name,
        description: mod.description || '',
        evaluate: mod.evaluate,
        onWindowOpen: mod.onWindowOpen || null,
        onWindowClose: mod.onWindowClose || null,
        onPassiveFill: mod.onPassiveFill || null,
        usesPassiveOrders: mod.usesPassiveOrders || false,
        defaults: mod.defaults || {},
      });
    } catch (err) {
      console.error(`  Skipping ${file}: ${err.message}`);
    }
  }
  return strategies;
}

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** d) / 10 ** d;
}

function analyzeCheapEntries(trades) {
  const buckets = [];
  for (const b of CHEAP_BUCKETS) {
    const filtered = trades.filter(t => {
      if (b.min != null && t.entryPrice < b.min) return false;
      if (b.max != null && t.entryPrice >= b.max) return false;
      return true;
    });
    if (filtered.length === 0) {
      buckets.push({ bucket: b.label, count: 0, wins: 0, winRate: 0, totalPnl: 0, avgPnl: 0, avgTokens: 0, avgEntry: 0, avgROC: 0 });
      continue;
    }
    const wins = filtered.filter(t => t.pnl > 0);
    const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);
    const avgTokens = filtered.reduce((s, t) => s + t.size, 0) / filtered.length;
    const avgEntry = filtered.reduce((s, t) => s + t.entryPrice, 0) / filtered.length;
    const avgROC = filtered.reduce((s, t) => s + (t.cost > 0 ? t.pnl / t.cost : 0), 0) / filtered.length * 100;
    buckets.push({
      bucket: b.label,
      count: filtered.length,
      wins: wins.length,
      winRate: round(wins.length / filtered.length * 100, 1),
      totalPnl: round(totalPnl, 2),
      avgPnl: round(totalPnl / filtered.length, 4),
      avgTokens: round(avgTokens, 1),
      avgEntry: round(avgEntry, 4),
      avgROC: round(avgROC, 1),
    });
  }
  return buckets;
}

async function main() {
  console.log('=== Local Backtest: All Strategies vs Ground Truth ($2/trade) ===\n');
  console.log('Data source: SQLite (data/backtest.sqlite)');
  const t0Global = Date.now();

  const strategies = await discoverStrategies();
  if (strategies.length === 0) {
    console.error('No strategies found. Check src/backtest/strategies/');
    process.exit(1);
  }
  console.log(`Strategies: ${strategies.map(s => s.name).join(', ')}\n`);

  // Load windows
  console.log('Loading windows with ground truth...');
  let allWindows = await loadWindowsWithGroundTruth({
    startDate: START_DATE || '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T23:59:59Z',
  });
  allWindows = allWindows.filter(w =>
    w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open)
  );

  const activeSymbols = SYMBOL_FILTER ? [SYMBOL_FILTER] : SYMBOLS;
  const bySymbol = {};
  for (const sym of activeSymbols) {
    let symWindows = allWindows.filter(w => w.symbol?.toLowerCase() === sym);
    if (WINDOW_LIMIT > 0) symWindows = symWindows.slice(0, WINDOW_LIMIT);
    bySymbol[sym] = symWindows;
  }

  console.log(`Total: ${allWindows.length} windows${WINDOW_LIMIT ? ` (limited to ${WINDOW_LIMIT} per symbol)` : ''}${SYMBOL_FILTER ? ` (symbol: ${SYMBOL_FILTER})` : ''}`);
  for (const sym of activeSymbols) console.log(`  ${sym.toUpperCase()}: ${bySymbol[sym].length}`);

  // Compute date range from selected windows
  let minTime = Infinity, maxTime = -Infinity;
  for (const sym of activeSymbols) {
    for (const w of bySymbol[sym]) {
      const t = new Date(w.window_close_time).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
  }
  const startDate = new Date(minTime - 10 * 60 * 1000).toISOString();
  const endDate = new Date(maxTime + 60 * 1000).toISOString();
  console.log(`Date range: ${startDate.slice(0,10)} to ${endDate.slice(0,10)}\n`);

  // Run strategies per symbol
  const results = [];
  const allTradesByStrategy = {};

  for (const sym of activeSymbols) {
    const windows = bySymbol[sym];
    if (!windows.length) continue;

    console.log(`\n--- ${sym.toUpperCase()} (${windows.length} windows, per-window loading) ---`);
    const memBefore = process.memoryUsage();
    console.log(`  Memory: heap=${(memBefore.heapUsed/1024/1024).toFixed(0)}MB, rss=${(memBefore.rss/1024/1024).toFixed(0)}MB`);

    for (const strategy of strategies) {
      if (!allTradesByStrategy[strategy.name]) allTradesByStrategy[strategy.name] = {};

      const t0 = Date.now();
      let progressCount = 0;
      process.stdout.write(`  ${strategy.name} x ${sym.toUpperCase()} (${windows.length} windows)...`);

      try {
        const result = await runParallelBacktest({
          windows,
          loadWindowTickDataFn: loadWindowTickData,
          config: {
            strategy,
            strategyConfig: strategy.defaults || {},
            initialCapital: 10000,
            spreadBuffer: 0.005,
            tradingFee: 0,
            concurrency: CONCURRENCY,
            onProgress: (done, total) => {
              if (done % 100 === 0 || done === total) {
                process.stdout.write(`\r  ${strategy.name} x ${sym.toUpperCase()} ${done}/${total}...`);
              }
            },
          },
        });

        const metrics = calculateMetrics(result);
        const bm = calculateBinaryMetrics(result.trades);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);

        allTradesByStrategy[strategy.name][sym.toUpperCase()] = result.trades;

        const row = {
          strategy: strategy.name,
          symbol: sym.toUpperCase(),
          windows: windows.length,
          trades: result.summary.totalTrades,
          winRate: round(result.summary.winRate * 100, 1),
          totalPnl: round(result.summary.totalPnl, 2),
          sharpe: round(metrics.sharpeRatio, 2),
          pf: round(metrics.profitFactor, 2),
          avgEntry: round(bm.avgEntryPrice, 4),
          dollarPnl: round(bm.dollarPnlPerTrade, 4),
          avgCost: round(bm.avgCostPerTrade, 4),
          roc: round(bm.returnOnCapitalPerTrade * 100, 2),
          avgTokens: round(bm.avgTokensPerTrade, 2),
        };
        results.push(row);
        console.log(` ${row.trades} trades, ${row.winRate}% WR, $${row.totalPnl} PnL, $${row.dollarPnl}/trade, ${row.roc}% ROC [${sec}s]`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
        results.push({ strategy: strategy.name, symbol: sym.toUpperCase(), error: err.message });
      }
    }

    if (global.gc) global.gc();
  }

  const totalSec = ((Date.now() - t0Global) / 1000).toFixed(0);

  // ─── SUMMARY TABLE ───
  console.log('\n\n' + '='.repeat(150));
  console.log(`STRATEGY COMPARISON ($2/trade capital-based sizing) -- completed in ${totalSec}s`);
  console.log('='.repeat(150));
  console.log(
    'Strategy'.padEnd(28) + ' | ' +
    'Sym'.padEnd(5) + ' | ' +
    'Trades'.padStart(7) + ' | ' +
    'WR%'.padStart(6) + ' | ' +
    'TotalPnL$'.padStart(11) + ' | ' +
    '$/Trade'.padStart(9) + ' | ' +
    'ROC%'.padStart(8) + ' | ' +
    'Sharpe'.padStart(7) + ' | ' +
    'AvgEntry'.padStart(9) + ' | ' +
    'Tkns'.padStart(6) + ' | ' +
    'PF'.padStart(6)
  );
  console.log('-'.repeat(150));

  for (const sym of SYMBOLS) {
    const symResults = results.filter(r => r.symbol === sym.toUpperCase());
    for (const r of symResults) {
      if (r.error) {
        console.log(`${r.strategy.padEnd(28)} | ${r.symbol.padEnd(5)} | ERROR: ${r.error}`);
        continue;
      }
      console.log(
        r.strategy.padEnd(28) + ' | ' +
        r.symbol.padEnd(5) + ' | ' +
        String(r.trades).padStart(7) + ' | ' +
        (r.winRate + '%').padStart(6) + ' | ' +
        ('$' + r.totalPnl).padStart(11) + ' | ' +
        ('$' + r.dollarPnl).padStart(9) + ' | ' +
        (r.roc + '%').padStart(8) + ' | ' +
        String(r.sharpe).padStart(7) + ' | ' +
        String(r.avgEntry).padStart(9) + ' | ' +
        String(r.avgTokens).padStart(6) + ' | ' +
        String(r.pf).padStart(6)
      );
    }
    console.log('-'.repeat(150));
  }

  // ─── CHEAP ENTRY ANALYSIS ───
  console.log('\n' + '='.repeat(130));
  console.log('CHEAP ENTRY ANALYSIS -- Trades by entry price bucket ($2 capital per trade)');
  console.log('='.repeat(130));

  for (const strategy of strategies) {
    const stratTrades = allTradesByStrategy[strategy.name];
    if (!stratTrades) continue;
    console.log(`\n--- ${strategy.name} ---`);

    for (const sym of SYMBOLS) {
      const trades = stratTrades[sym.toUpperCase()];
      if (!trades || trades.length === 0) {
        console.log(`  ${sym.toUpperCase()}: no trades`);
        continue;
      }

      const buckets = analyzeCheapEntries(trades);
      console.log(`  ${sym.toUpperCase()} (${trades.length} total trades):`);
      console.log('    ' +
        'Entry Bucket'.padEnd(14) + ' | ' +
        'Count'.padStart(6) + ' | ' +
        'Wins'.padStart(6) + ' | ' +
        'WR%'.padStart(6) + ' | ' +
        'TotalPnL$'.padStart(11) + ' | ' +
        'AvgROC%'.padStart(9) + ' | ' +
        'AvgTkns'.padStart(8) + ' | ' +
        'AvgEntry'.padStart(9)
      );
      console.log('    ' + '-'.repeat(95));
      for (const b of buckets) {
        if (b.count === 0) continue;
        const flag = b.bucket.startsWith('<') && b.winRate > 60 ? ' <<< HIGH VALUE' : '';
        console.log('    ' +
          b.bucket.padEnd(14) + ' | ' +
          String(b.count).padStart(6) + ' | ' +
          String(b.wins).padStart(6) + ' | ' +
          (b.winRate + '%').padStart(6) + ' | ' +
          ('$' + b.totalPnl).padStart(11) + ' | ' +
          (b.avgROC + '%').padStart(9) + ' | ' +
          String(b.avgTokens).padStart(8) + ' | ' +
          ('$' + b.avgEntry).padStart(9) + flag
        );
      }
    }
  }

  // ─── CHEAP ENTRY SUMMARY ───
  const cheapSummary = [];
  for (const strategy of strategies) {
    const stratTrades = allTradesByStrategy[strategy.name];
    if (!stratTrades) continue;
    for (const sym of SYMBOLS) {
      const trades = stratTrades[sym.toUpperCase()];
      if (!trades) continue;
      const cheap = trades.filter(t => t.entryPrice < 0.20);
      if (cheap.length === 0) continue;
      const wins = cheap.filter(t => t.pnl > 0);
      const totalPnl = cheap.reduce((s, t) => s + t.pnl, 0);
      const avgEntry = cheap.reduce((s, t) => s + t.entryPrice, 0) / cheap.length;
      const avgTokens = cheap.reduce((s, t) => s + t.size, 0) / cheap.length;
      cheapSummary.push({
        label: `${strategy.name} x ${sym.toUpperCase()}`,
        count: cheap.length,
        wins: wins.length,
        wr: round(wins.length / cheap.length * 100, 1),
        pnl: round(totalPnl, 2),
        avgEntry: round(avgEntry, 4),
        avgTokens: round(avgTokens, 1),
      });
    }
  }

  if (cheapSummary.length > 0) {
    console.log('\n\n' + '='.repeat(100));
    console.log('CHEAP ENTRY SUMMARY (<$0.20 entry) -- sorted by total PnL');
    console.log('='.repeat(100));
    cheapSummary.sort((a, b) => b.pnl - a.pnl);
    for (const s of cheapSummary) {
      console.log(
        `${s.label.padEnd(40)} ${String(s.count).padStart(5)} trades, ` +
        `${(s.wr + '%').padStart(6)} WR, ` +
        `$${String(s.pnl).padStart(8)} PnL, ` +
        `avg $${s.avgEntry} entry, ` +
        `${s.avgTokens} tokens/trade`
      );
    }
  }

  // ─── Save JSON results ───
  const outputDir = resolve(process.cwd(), 'data', 'results');
  mkdirSync(outputDir, { recursive: true });

  const outputFile = OUTPUT_PATH
    ? resolve(process.cwd(), OUTPUT_PATH)
    : resolve(outputDir, `backtest-${Date.now()}.json`);

  const jsonOut = {
    timestamp: new Date().toISOString(),
    durationSec: parseInt(totalSec),
    strategies: strategies.map(s => s.name),
    symbols: activeSymbols,
    results,
    cheapSummary,
  };
  writeFileSync(outputFile, JSON.stringify(jsonOut, null, 2));
  console.log(`\nJSON saved: ${outputFile}`);

  console.log(`\nDone in ${totalSec}s.`);
  closeSqlite();
  process.exit(0);
}

main().catch(err => {
  console.error(err.message);
  console.error(err.stack);
  closeSqlite();
  process.exit(1);
});
