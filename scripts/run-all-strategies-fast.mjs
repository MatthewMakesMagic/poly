#!/usr/bin/env node

/**
 * Fast runner: ALL strategies x ALL symbols against Gamma ground truth.
 * Uses higher concurrency and runs all 7 strategies.
 *
 * Usage:
 *   node scripts/run-all-strategies-fast.mjs
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
const SINGLE = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1] || null;
const SYMBOL_FILTER = process.argv.find(a => a.startsWith('--symbol='))?.split('=')[1] || null;

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
    throw new Error('DATABASE_URL not set');
  }
  await initLogger({ logging: { level: 'error', console: true, directory: './logs' } });
  await persistence.init({
    database: {
      url: process.env.DATABASE_URL,
      pool: { min: 2, max: 20, connectionTimeoutMs: 30000 },
      circuitBreakerPool: { min: 1, max: 2, connectionTimeoutMs: 30000 },
      queryTimeoutMs: 300000,
      retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  });
}

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
  console.log('=== All Strategies vs Gamma Ground Truth ===\n');
  await initDb();

  const strategies = await discoverStrategies();
  console.log(`Strategies: ${strategies.map(s => s.name).join(', ')}\n`);

  // Load windows
  let allWindows = await loadWindowsWithGroundTruth({
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T23:59:59Z',
  });
  allWindows = allWindows.filter(w =>
    w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open)
  );

  const symbolsToRun = SYMBOL_FILTER ? [SYMBOL_FILTER.toLowerCase()] : SYMBOLS;
  const bySymbol = {};
  for (const sym of symbolsToRun) {
    bySymbol[sym] = allWindows.filter(w => w.symbol?.toLowerCase() === sym);
  }

  console.log(`Total: ${allWindows.length} windows`);
  for (const sym of symbolsToRun) console.log(`  ${sym.toUpperCase()}: ${bySymbol[sym].length}`);
  console.log('');

  const results = [];

  for (const strategy of strategies) {
    for (const sym of symbolsToRun) {
      const windows = bySymbol[sym];
      if (!windows.length) continue;

      const t0 = Date.now();
      process.stdout.write(`${strategy.name} x ${sym.toUpperCase()} (${windows.length})...`);

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
            onProgress: (done, total) => {
              if (done % 200 === 0) process.stdout.write(` ${done}`);
            },
          },
        });

        const metrics = calculateMetrics(result);
        const bm = calculateBinaryMetrics(result.trades);
        const sec = ((Date.now() - t0) / 1000).toFixed(0);

        const row = {
          strategy: strategy.name,
          symbol: sym.toUpperCase(),
          windows: windows.length,
          trades: result.summary.totalTrades,
          winRate: round(result.summary.winRate * 100, 1),
          totalPnl: round(result.summary.totalPnl, 2),
          returnPct: round(result.summary.returnPct * 100, 2),
          sharpe: round(metrics.sharpeRatio, 2),
          maxDD: round(metrics.maxDrawdown * 100, 2),
          pf: round(metrics.profitFactor, 2),
          evTrade: round(bm.evPerTrade, 4),
          avgEntry: round(bm.avgEntryPrice, 4),
          edge: round(bm.edgeCaptured, 4),
        };
        results.push(row);
        console.log(` => ${row.trades} trades, ${row.winRate}% WR, $${row.totalPnl} PnL, Sh=${row.sharpe} [${sec}s]`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
        results.push({ strategy: strategy.name, symbol: sym.toUpperCase(), error: err.message });
      }
    }

    // ALL combined
    if (symbolsToRun.length > 1) {
      const t0 = Date.now();
      process.stdout.write(`${strategy.name} x ALL (${allWindows.length})...`);
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
            onProgress: (done, total) => {
              if (done % 500 === 0) process.stdout.write(` ${done}`);
            },
          },
        });
        const metrics = calculateMetrics(result);
        const bm = calculateBinaryMetrics(result.trades);
        const sec = ((Date.now() - t0) / 1000).toFixed(0);
        results.push({
          strategy: strategy.name,
          symbol: 'ALL',
          windows: allWindows.length,
          trades: result.summary.totalTrades,
          winRate: round(result.summary.winRate * 100, 1),
          totalPnl: round(result.summary.totalPnl, 2),
          returnPct: round(result.summary.returnPct * 100, 2),
          sharpe: round(metrics.sharpeRatio, 2),
          maxDD: round(metrics.maxDrawdown * 100, 2),
          pf: round(metrics.profitFactor, 2),
          evTrade: round(bm.evPerTrade, 4),
          avgEntry: round(bm.avgEntryPrice, 4),
          edge: round(bm.edgeCaptured, 4),
        });
        console.log(` => ${result.summary.totalTrades} trades, ${round(result.summary.winRate * 100, 1)}% WR, $${round(result.summary.totalPnl, 2)} PnL [${sec}s]`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
      }
    }
    console.log('');
  }

  // Print table
  console.log('\n' + '='.repeat(150));
  console.log('STRATEGY COMPARISON TABLE');
  console.log('='.repeat(150));
  console.log(
    'Strategy'.padEnd(30) + ' | ' +
    'Sym'.padEnd(5) + ' | ' +
    'Win'.padStart(6) + ' | ' +
    'Trd'.padStart(6) + ' | ' +
    'WR%'.padStart(6) + ' | ' +
    'PnL$'.padStart(10) + ' | ' +
    'Ret%'.padStart(8) + ' | ' +
    'Sharpe'.padStart(7) + ' | ' +
    'MaxDD%'.padStart(7) + ' | ' +
    'PF'.padStart(6) + ' | ' +
    'EV/Trd'.padStart(8) + ' | ' +
    'AvgEnt'.padStart(7) + ' | ' +
    'Edge'.padStart(7)
  );
  console.log('-'.repeat(150));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.strategy.padEnd(30)} | ${r.symbol.padEnd(5)} | ERROR: ${r.error}`);
      continue;
    }
    console.log(
      r.strategy.padEnd(30) + ' | ' +
      r.symbol.padEnd(5) + ' | ' +
      String(r.windows).padStart(6) + ' | ' +
      String(r.trades).padStart(6) + ' | ' +
      (r.winRate + '%').padStart(6) + ' | ' +
      ('$' + r.totalPnl).padStart(10) + ' | ' +
      (r.returnPct + '%').padStart(8) + ' | ' +
      String(r.sharpe).padStart(7) + ' | ' +
      (r.maxDD + '%').padStart(7) + ' | ' +
      String(r.pf).padStart(6) + ' | ' +
      ('$' + r.evTrade).padStart(8) + ' | ' +
      String(r.avgEntry).padStart(7) + ' | ' +
      String(r.edge).padStart(7)
    );
  }
  console.log('='.repeat(150));

  // Flag profitable
  console.log('\n--- Strategies Profitable Across Multiple Symbols (>55% WR, +PnL) ---');
  const sNames = [...new Set(results.filter(r => !r.error).map(r => r.strategy))];
  for (const n of sNames) {
    const rows = results.filter(r => r.strategy === n && r.symbol !== 'ALL' && !r.error && r.trades > 0);
    const good = rows.filter(r => r.winRate > 55 && r.totalPnl > 0);
    if (good.length >= 2) {
      console.log(`  *** ${n}: profitable on ${good.map(r => r.symbol).join(', ')} ***`);
    } else if (good.length === 1) {
      console.log(`  ${n}: profitable on ${good[0].symbol} only`);
    } else if (rows.length > 0) {
      console.log(`  ${n}: ${rows.reduce((s, r) => s + r.trades, 0)} trades total, not profitable`);
    } else {
      console.log(`  ${n}: no trades`);
    }
  }

  if (OUTPUT_PATH) {
    writeFileSync(resolve(process.cwd(), OUTPUT_PATH), JSON.stringify(results, null, 2));
    console.log(`\nJSON: ${OUTPUT_PATH}`);
  }

  await persistence.shutdown().catch(() => {});
}

main().catch(err => { console.error(err.message); process.exit(1); });
