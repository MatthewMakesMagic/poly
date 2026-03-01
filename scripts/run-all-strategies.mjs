#!/usr/bin/env node

/**
 * Run ALL strategies against corrected Gamma ground truth.
 *
 * For each strategy x symbol, records:
 *   win rate, total P&L, trade count, Sharpe ratio, max drawdown, EV/trade
 *
 * Usage:
 *   node scripts/run-all-strategies.mjs
 *   node scripts/run-all-strategies.mjs --parallel=10
 *   node scripts/run-all-strategies.mjs --output=results/all-strategies.json
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, basename } from 'path';
import { pathToFileURL } from 'url';
import persistence from '../src/persistence/index.js';
import { init as initLogger } from '../src/modules/logger/index.js';
import {
  loadWindowsWithGroundTruth,
} from '../src/backtest/data-loader.js';
import {
  runParallelBacktest,
} from '../src/backtest/parallel-engine.js';
import { calculateMetrics, calculateBinaryMetrics } from '../src/backtest/metrics.js';

const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] || '10', 10);
const OUTPUT_PATH = process.argv.find(a => a.startsWith('--output='))?.split('=')[1] || null;

async function initDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    try {
      const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) process.env.DATABASE_URL = match[1];
    } catch { /* ignore */ }
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set. Run: export $(grep DATABASE_URL .env.local | xargs)');
  }
  await initLogger({ logging: { level: 'warn', console: true, directory: './logs' } });
  await persistence.init({
    database: {
      url: process.env.DATABASE_URL,
      pool: { min: 2, max: 10, connectionTimeoutMs: 30000 },
      circuitBreakerPool: { min: 1, max: 2, connectionTimeoutMs: 30000 },
      queryTimeoutMs: 300000,
      retry: { maxAttempts: 5, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  });
}

async function discoverStrategies() {
  const dir = resolve(process.cwd(), 'src/backtest/strategies');
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  const strategies = [];
  for (const file of files) {
    const name = basename(file, '.js');
    try {
      const mod = await import(pathToFileURL(resolve(dir, file)).href);
      if (typeof mod.evaluate !== 'function') continue;
      strategies.push({
        name: mod.name || name,
        evaluate: mod.evaluate,
        onWindowOpen: mod.onWindowOpen || null,
        onWindowClose: mod.onWindowClose || null,
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

async function main() {
  console.log('=== Run All Strategies Against Gamma Ground Truth ===\n');
  await initDb();

  // Discover strategies
  const strategies = await discoverStrategies();
  console.log(`Found ${strategies.length} strategies: ${strategies.map(s => s.name).join(', ')}\n`);

  if (strategies.length === 0) {
    console.error('No strategies found in src/backtest/strategies/');
    process.exit(1);
  }

  // Load ALL windows with ground truth once
  console.log('Loading all windows with ground truth...');
  let allWindows = await loadWindowsWithGroundTruth({
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T23:59:59Z',
  });
  allWindows = allWindows.filter(w =>
    w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open)
  );
  console.log(`  ${allWindows.length} total windows with ground truth\n`);

  // Per-symbol window counts
  const bySymbol = {};
  for (const sym of SYMBOLS) {
    bySymbol[sym] = allWindows.filter(w => w.symbol?.toLowerCase() === sym);
    console.log(`  ${sym.toUpperCase()}: ${bySymbol[sym].length} windows`);
  }
  console.log('');

  // Results collector
  const results = [];

  // Run each strategy x symbol
  for (const strategy of strategies) {
    for (const sym of SYMBOLS) {
      const windows = bySymbol[sym];
      if (windows.length === 0) {
        console.log(`  ${strategy.name} x ${sym.toUpperCase()}: 0 windows, skipping`);
        continue;
      }

      process.stdout.write(`  ${strategy.name} x ${sym.toUpperCase()} (${windows.length} windows)...`);
      const startTime = Date.now();

      try {
        const result = await runParallelBacktest({
          windows,
          config: {
            strategy,
            strategyConfig: strategy.defaults || {},
            initialCapital: 100,
            spreadBuffer: 0.005,
            tradingFee: 0,
            concurrency: CONCURRENCY,
          },
        });

        const metrics = calculateMetrics(result);
        const binaryMetrics = calculateBinaryMetrics(result.trades);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        const row = {
          strategy: strategy.name,
          symbol: sym.toUpperCase(),
          windows: windows.length,
          trades: result.summary.totalTrades,
          winRate: round(result.summary.winRate * 100, 1),
          totalPnl: round(result.summary.totalPnl, 2),
          returnPct: round(result.summary.returnPct * 100, 2),
          sharpe: round(metrics.sharpeRatio, 2),
          maxDrawdown: round(metrics.maxDrawdown * 100, 2),
          profitFactor: round(metrics.profitFactor, 2),
          evPerTrade: round(binaryMetrics.evPerTrade, 4),
          avgEntry: round(binaryMetrics.avgEntryPrice, 4),
          edgeCaptured: round(binaryMetrics.edgeCaptured, 4),
          elapsed: `${elapsed}s`,
        };

        results.push(row);
        console.log(` ${row.trades} trades, ${row.winRate}% WR, $${row.totalPnl} PnL, ${row.sharpe} Sharpe [${elapsed}s]`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
        results.push({
          strategy: strategy.name,
          symbol: sym.toUpperCase(),
          error: err.message,
        });
      }
    }

    // Also run "all" symbols combined
    process.stdout.write(`  ${strategy.name} x ALL (${allWindows.length} windows)...`);
    const startTime = Date.now();
    try {
      const result = await runParallelBacktest({
        windows: allWindows,
        config: {
          strategy,
          strategyConfig: strategy.defaults || {},
          initialCapital: 100,
          spreadBuffer: 0.005,
          tradingFee: 0,
          concurrency: CONCURRENCY,
        },
      });

      const metrics = calculateMetrics(result);
      const binaryMetrics = calculateBinaryMetrics(result.trades);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      const row = {
        strategy: strategy.name,
        symbol: 'ALL',
        windows: allWindows.length,
        trades: result.summary.totalTrades,
        winRate: round(result.summary.winRate * 100, 1),
        totalPnl: round(result.summary.totalPnl, 2),
        returnPct: round(result.summary.returnPct * 100, 2),
        sharpe: round(metrics.sharpeRatio, 2),
        maxDrawdown: round(metrics.maxDrawdown * 100, 2),
        profitFactor: round(metrics.profitFactor, 2),
        evPerTrade: round(binaryMetrics.evPerTrade, 4),
        avgEntry: round(binaryMetrics.avgEntryPrice, 4),
        edgeCaptured: round(binaryMetrics.edgeCaptured, 4),
        elapsed: `${elapsed}s`,
      };

      results.push(row);
      console.log(` ${row.trades} trades, ${row.winRate}% WR, $${row.totalPnl} PnL, ${row.sharpe} Sharpe [${elapsed}s]`);
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
    }
    console.log('');
  }

  // Print comparison table
  console.log('\n' + '='.repeat(140));
  console.log('STRATEGY COMPARISON TABLE (Gamma Ground Truth)');
  console.log('='.repeat(140));

  const header = [
    'Strategy'.padEnd(25),
    'Symbol'.padEnd(8),
    'Windows'.padStart(8),
    'Trades'.padStart(8),
    'WinRate%'.padStart(9),
    'TotalPnL'.padStart(10),
    'Return%'.padStart(9),
    'Sharpe'.padStart(8),
    'MaxDD%'.padStart(8),
    'PF'.padStart(6),
    'EV/Trade'.padStart(10),
    'AvgEntry'.padStart(9),
    'Edge'.padStart(8),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(140));

  for (const r of results) {
    if (r.error) {
      console.log(`${(r.strategy || '').padEnd(25)} | ${(r.symbol || '').padEnd(8)} | ERROR: ${r.error}`);
      continue;
    }
    const row = [
      (r.strategy || '').padEnd(25),
      (r.symbol || '').padEnd(8),
      String(r.windows).padStart(8),
      String(r.trades).padStart(8),
      `${r.winRate}%`.padStart(9),
      `$${r.totalPnl}`.padStart(10),
      `${r.returnPct}%`.padStart(9),
      String(r.sharpe).padStart(8),
      `${r.maxDrawdown}%`.padStart(8),
      String(r.profitFactor).padStart(6),
      `$${r.evPerTrade}`.padStart(10),
      String(r.avgEntry).padStart(9),
      String(r.edgeCaptured).padStart(8),
    ].join(' | ');
    console.log(row);
  }
  console.log('='.repeat(140));

  // Flag profitable strategies
  console.log('\n--- Profitable Strategies (>55% WR and positive PnL across multiple symbols) ---');
  const stratNames = [...new Set(results.filter(r => !r.error).map(r => r.strategy))];
  for (const name of stratNames) {
    const rows = results.filter(r => r.strategy === name && r.symbol !== 'ALL' && !r.error && r.trades > 0);
    const profitable = rows.filter(r => r.winRate > 55 && r.totalPnl > 0);
    if (profitable.length >= 2) {
      console.log(`  *** ${name}: profitable on ${profitable.map(r => r.symbol).join(', ')} ***`);
    } else if (profitable.length === 1) {
      console.log(`  ${name}: profitable on ${profitable[0].symbol} only`);
    } else {
      console.log(`  ${name}: not profitable on any symbol`);
    }
  }

  // Save results
  if (OUTPUT_PATH) {
    writeFileSync(resolve(process.cwd(), OUTPUT_PATH), JSON.stringify(results, null, 2));
    console.log(`\nResults written to: ${OUTPUT_PATH}`);
  }

  console.log('\nDone.');
  await persistence.shutdown().catch(() => {});
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
