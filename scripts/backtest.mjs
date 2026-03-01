#!/usr/bin/env node

/**
 * Backtest CLI — Parallel Engine
 *
 * Loads data once, evaluates windows in parallel.
 *
 * Usage:
 *   node scripts/backtest.mjs --strategy=edge-c-asymmetry --start=2026-02-11 --end=2026-03-01
 *   node scripts/backtest.mjs --strategy=edge-c-asymmetry --symbol=btc --parallel=50
 *   node scripts/backtest.mjs --strategy=edge-c-asymmetry --sweep
 *
 * Options:
 *   --strategy=<name>   Strategy module name (required)
 *   --start=<date>      Start date (default: earliest data)
 *   --end=<date>        End date (default: latest data)
 *   --symbol=<s>        Symbol filter: btc, eth, sol, xrp, or all (default: all)
 *   --parallel=<N>      Concurrency level (default: 50)
 *   --capital=<N>       Initial capital per window (default: 100)
 *   --spread=<N>        Spread buffer (default: 0.005)
 *   --fee=<N>           Trading fee (default: 0)
 *   --output=<path>     Write JSON report to file
 *   --sweep             Enable parameter sweep mode
 *   --verbose           Include per-trade detail
 *   --sequential        Use old sequential engine
 *   --help              Show help
 */

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { resolve } from 'path';
import persistence from '../src/persistence/index.js';
import { init as initLogger } from '../src/modules/logger/index.js';
import {
  loadWindowsWithGroundTruth,
  getTickDateRange,
} from '../src/backtest/data-loader.js';
import {
  runParallelBacktest,
  runParallelSweep,
} from '../src/backtest/parallel-engine.js';
import {
  generateReport,
  generateComparisonReport,
  printSummary,
} from '../src/backtest/reporter.js';

// ─── Arg Parsing ───

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    strategy: null,
    start: null,
    end: null,
    symbol: 'all',
    parallel: 50,
    capital: 100,
    spread: 0.005,
    fee: 0,
    output: null,
    sweep: false,
    verbose: false,
    sequential: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--sweep') { options.sweep = true; continue; }
    if (arg === '--verbose' || arg === '-v') { options.verbose = true; continue; }
    if (arg === '--sequential') { options.sequential = true; continue; }

    const match = arg.match(/^--([a-z]+)=(.+)$/);
    if (match) {
      const [, key, value] = match;
      switch (key) {
        case 'strategy': options.strategy = value; break;
        case 'start': options.start = value; break;
        case 'end': options.end = value; break;
        case 'symbol': options.symbol = value.toLowerCase(); break;
        case 'parallel': options.parallel = parseInt(value, 10); break;
        case 'capital': options.capital = parseFloat(value); break;
        case 'spread': options.spread = parseFloat(value); break;
        case 'fee': options.fee = parseFloat(value); break;
        case 'output': options.output = value; break;
      }
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Parallel Backtest CLI

Usage:
  node scripts/backtest.mjs --strategy=<name> [options]

Required:
  --strategy=<name>   Strategy module name from src/backtest/strategies/

Options:
  --start=<date>      Start date (ISO or YYYY-MM-DD, default: earliest data)
  --end=<date>        End date (ISO or YYYY-MM-DD, default: latest data)
  --symbol=<s>        btc | eth | sol | xrp | all (default: all)
  --parallel=<N>      Concurrency level (default: 50)
  --capital=<N>       Initial capital per window (default: 100)
  --spread=<N>        Spread buffer for execution (default: 0.005)
  --fee=<N>           Trading fee per trade (default: 0)
  --output=<path>     Write JSON report to file
  --sweep             Enable parameter sweep mode
  --verbose           Include per-trade detail in output
  --sequential        Use old sequential engine (legacy)
  --help              Show this help

Examples:
  # Run edge-c-asymmetry on all BTC windows
  node scripts/backtest.mjs --strategy=edge-c-asymmetry --symbol=btc

  # Run with 100 parallel workers
  node scripts/backtest.mjs --strategy=edge-c-asymmetry --parallel=100

  # Parameter sweep
  node scripts/backtest.mjs --strategy=edge-c-asymmetry --symbol=btc --sweep
`);
}

// ─── Strategy Loader ───

async function loadStrategy(name) {
  // Try to load from src/backtest/strategies/<name>.js
  const strategyPath = resolve(process.cwd(), `src/backtest/strategies/${name}.js`);
  try {
    const mod = await import(pathToFileURL(strategyPath).href);
    if (typeof mod.evaluate !== 'function') {
      throw new Error(`Strategy module ${name} must export an evaluate function`);
    }
    return {
      name: mod.name || name,
      evaluate: mod.evaluate,
      onWindowOpen: mod.onWindowOpen || null,
      onWindowClose: mod.onWindowClose || null,
      defaults: mod.defaults || {},
      sweepGrid: mod.sweepGrid || null,
    };
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND') {
      throw new Error(`Strategy not found: ${strategyPath}\nAvailable strategies are in src/backtest/strategies/`);
    }
    throw err;
  }
}

// ─── Database Init ───

async function initDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    // Try loading from .env.local
    const { readFileSync } = await import('fs');
    try {
      const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) {
        process.env.DATABASE_URL = match[1];
      }
    } catch {
      // ignore
    }
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

// ─── Main ───

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.strategy) {
    console.error('Error: --strategy is required. Use --help for usage.');
    process.exit(1);
  }

  try {
    // Init
    await initDb();

    // Load strategy
    const strategy = await loadStrategy(options.strategy);
    console.log(`Strategy: ${strategy.name}`);

    // Determine date range
    const dateRange = await getTickDateRange();
    const toIsoStr = (val) => val instanceof Date ? val.toISOString() : String(val || '');
    const startDate = options.start
      ? (options.start.includes('T') ? options.start : `${options.start}T00:00:00Z`)
      : toIsoStr(dateRange.earliest);
    const endDate = options.end
      ? (options.end.includes('T') ? options.end : `${options.end}T23:59:59Z`)
      : toIsoStr(dateRange.latest);

    if (!startDate || !endDate) {
      console.error('Error: No data available and no date range specified.');
      process.exit(1);
    }

    // Symbol filter
    const symbolFilter = options.symbol !== 'all' ? [options.symbol] : undefined;

    console.log(`Period: ${String(startDate).split('T')[0]} to ${String(endDate).split('T')[0]}`);
    console.log(`Symbols: ${symbolFilter ? symbolFilter.join(', ') : 'all'}`);
    console.log(`Concurrency: ${options.parallel}`);
    console.log('');

    // Load windows
    console.log('Loading windows...');
    const windowLoadStart = Date.now();
    let windows = await loadWindowsWithGroundTruth({
      startDate,
      endDate,
      symbols: symbolFilter,
    });

    // Filter out windows without ground truth
    const beforeFilter = windows.length;
    windows = windows.filter(w =>
      w.resolved_direction || w.onchain_resolved_direction || w.gamma_resolved_direction ||
      (w.chainlink_price_at_close && w.oracle_price_at_open)
    );

    console.log(`  ${windows.length} windows loaded (${beforeFilter - windows.length} skipped, no ground truth) [${Date.now() - windowLoadStart}ms]`);

    if (windows.length === 0) {
      console.error('Error: No windows with ground truth in the specified range.');
      process.exit(1);
    }

    console.log('Data loading: per-window (DB query per window)');
    console.log('');

    // Run backtest
    if (options.sweep) {
      // Parameter sweep
      const paramGrid = strategy.sweepGrid || strategy.defaults;
      if (!paramGrid || Object.keys(paramGrid).length === 0) {
        console.error('Error: Strategy does not define sweepGrid or defaults for sweep mode.');
        process.exit(1);
      }

      // Convert defaults to arrays for grid
      const grid = {};
      for (const [key, value] of Object.entries(paramGrid)) {
        grid[key] = Array.isArray(value) ? value : [value];
      }

      console.log(`Sweep mode: ${Object.keys(grid).length} parameters`);
      for (const [k, v] of Object.entries(grid)) {
        console.log(`  ${k}: [${v.join(', ')}]`);
      }
      console.log('');

      const sweepResults = await runParallelSweep({
        windows,
        baseConfig: {
          strategy,
          strategyConfig: strategy.defaults || {},
          initialCapital: options.capital,
          spreadBuffer: options.spread,
          tradingFee: options.fee,
        },
        paramGrid: grid,
        concurrency: options.parallel,
        onSweepProgress: (done, total) => {
          process.stdout.write(`\r  Config ${done}/${total}`);
        },
      });

      process.stdout.write('\r');
      console.log('');

      const comparison = generateComparisonReport(sweepResults);
      console.log('\n=== SWEEP RESULTS ===\n');
      console.log(`Best config (by EV/trade):`);
      if (comparison.best) {
        console.log(`  Params: ${JSON.stringify(comparison.best.params)}`);
        console.log(`  EV/trade: ${comparison.best.ev_per_trade}`);
        console.log(`  Win rate: ${(comparison.best.win_rate * 100).toFixed(1)}%`);
        console.log(`  Total PnL: $${comparison.best.total_pnl}`);
        console.log(`  Trades: ${comparison.best.total_trades}`);
      }

      if (options.output) {
        writeFileSync(options.output, JSON.stringify(comparison, null, 2));
        console.log(`\nSweep results written to: ${options.output}`);
      }
    } else {
      // Single config run
      let lastPct = 0;
      const result = await runParallelBacktest({
        windows,
        config: {
          strategy,
          strategyConfig: strategy.defaults || {},
          initialCapital: options.capital,
          spreadBuffer: options.spread,
          tradingFee: options.fee,
          concurrency: options.parallel,
          onProgress: (done, total) => {
            const pct = Math.floor((done / total) * 100);
            if (pct > lastPct) {
              process.stdout.write(`\r  Windows: ${done}/${total} (${pct}%)`);
              lastPct = pct;
            }
          },
        },
      });

      process.stdout.write('\r');

      // Print summary
      printSummary(result);
      console.log(`  Elapsed: ${(result.summary.elapsedMs / 1000).toFixed(1)}s`);

      if (options.output) {
        const report = generateReport(result, {
          format: 'json',
          includeTrades: options.verbose,
          includeEquityCurve: options.verbose,
        });
        writeFileSync(options.output, report);
        console.log(`\nResults written to: ${options.output}`);
      }
    }
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await persistence.shutdown().catch(() => {});
  }
}

main();
