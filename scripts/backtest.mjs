#!/usr/bin/env node

/**
 * Backtest CLI
 *
 * Run backtests from the command line.
 *
 * Usage:
 *   npm run backtest -- --strategy=threshold --start=2026-01-25 --end=2026-02-01
 *
 * Options:
 *   --strategy    Strategy name or 'threshold' for default (required)
 *   --start       Start date ISO format (required)
 *   --end         End date ISO format (required)
 *   --symbols     Comma-separated symbols: BTC,ETH (default: all)
 *   --output      Output file path (default: stdout)
 *   --format      Output format: json or csv (default: json)
 *   --verbose     Include individual trades in output
 *   --capital     Initial capital (default: 1000)
 *   --slippage    Slippage percentage (default: 0.001)
 *   --help        Show help
 */

import { writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { open, close } from '../src/persistence/database.js';
import { runMigrations } from '../src/persistence/migrations/index.js';
import {
  runBacktest,
  createThresholdStrategy,
  createComposedStrategy,
  generateReport,
  printSummary,
  getTickDateRange,
  getAvailableSymbols,
} from '../src/backtest/index.js';
import { discoverComponents } from '../src/modules/strategy/logic.js';
import { setCatalog, getCatalog } from '../src/modules/strategy/state.js';
import { loadAllStrategies, getLoadedStrategy } from '../src/modules/strategy/loader.js';

// Load environment variables
loadEnv();

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    strategy: null,
    start: null,
    end: null,
    symbols: null,
    output: null,
    format: 'json',
    verbose: false,
    capital: 1000,
    slippage: 0.001,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
      continue;
    }

    const match = arg.match(/^--(\w+)=(.+)$/);
    if (match) {
      const [, key, value] = match;

      switch (key) {
        case 'strategy':
          options.strategy = value;
          break;
        case 'start':
          options.start = value;
          break;
        case 'end':
          options.end = value;
          break;
        case 'symbols':
          options.symbols = value.split(',').map(s => s.trim().toUpperCase());
          break;
        case 'output':
          options.output = value;
          break;
        case 'format':
          options.format = value.toLowerCase();
          break;
        case 'capital':
          options.capital = parseFloat(value);
          break;
        case 'slippage':
          options.slippage = parseFloat(value);
          break;
      }
    }
  }

  return options;
}

/**
 * Show help text
 */
function showHelp() {
  console.log(`
Backtest CLI - Replay historical data through strategies

Usage:
  npm run backtest -- --strategy=<name> --start=<date> --end=<date> [options]

Required:
  --strategy=<name>   Strategy name: 'threshold', or custom (see below)
  --start=<date>      Start date (ISO format: 2026-01-25 or 2026-01-25T00:00:00Z)
  --end=<date>        End date (ISO format)

Options:
  --symbols=<list>    Comma-separated symbols (default: all available)
  --output=<path>     Write output to file instead of stdout
  --format=<fmt>      Output format: json or csv (default: json)
  --verbose           Include individual trades in output
  --capital=<num>     Initial capital (default: 1000)
  --slippage=<num>    Slippage percentage (default: 0.001 = 0.1%)
  --help              Show this help

Built-in Strategies:
  threshold           Simple spread threshold strategy
                      Enter when |spread| > 0.1%, exit on reversal or stop/take

Composed Strategies (from config/strategies/):
  "Oracle Edge Only"  Trade based on oracle staleness and divergence
  "Probability Model Only"  Black-Scholes N(d2) probability model
  "Lag-Based"         Cross-correlation lag between feeds
  "Hybrid"            Weighted combination of all signals

Examples:
  # Basic backtest
  npm run backtest -- --strategy=threshold --start=2026-01-25 --end=2026-02-01

  # Filter to specific symbols and save CSV
  npm run backtest -- --strategy=threshold --start=2026-01-25 --end=2026-02-01 \\
    --symbols=BTC,ETH --format=csv --output=results.csv

  # Verbose output with all trades
  npm run backtest -- --strategy=threshold --start=2026-01-25 --end=2026-02-01 --verbose
`);
}

/**
 * Create strategy from name
 */
async function createStrategy(name, options) {
  // Check for built-in strategies
  switch (name?.toLowerCase()) {
    case 'threshold':
      return createThresholdStrategy({
        entryThreshold: 0.001,
        exitThreshold: 0,
        stopLossPct: 0.05,
        takeProfitPct: 0.02,
      });
  }

  // Try to load from config/strategies/
  const catalog = await discoverComponents();
  setCatalog(catalog);
  loadAllStrategies();

  const strategyDef = getLoadedStrategy(name);
  if (strategyDef) {
    console.log(`  Loading composed strategy: ${name}`);
    return createComposedStrategy(strategyDef, getCatalog());
  }

  // List available strategies
  throw new Error(`Unknown strategy: ${name}. Use --help to see available strategies.`);
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  return dateStr.split('T')[0];
}

/**
 * Main function
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Validate required arguments
  if (!options.strategy) {
    console.error('Error: --strategy is required');
    console.error('Use --help to see available options');
    process.exit(1);
  }

  if (!options.start || !options.end) {
    console.error('Error: --start and --end dates are required');
    console.error('Use --help to see available options');
    process.exit(1);
  }

  // Normalize dates
  const startDate = options.start.includes('T') ? options.start : `${options.start}T00:00:00Z`;
  const endDate = options.end.includes('T') ? options.end : `${options.end}T23:59:59Z`;

  try {
    // Initialize database
    const dbPath = process.env.DATABASE_PATH || './data/poly.db';
    console.log(`Opening database: ${dbPath}`);
    open(dbPath);
    await runMigrations();

    // Check available data
    const dateRange = getTickDateRange();
    const availableSymbols = getAvailableSymbols();

    if (!dateRange.earliest) {
      console.error('Error: No tick data in database');
      console.error('Run live trading first to collect data, then run backtest');
      process.exit(1);
    }

    console.log(`\nData available: ${formatDate(dateRange.earliest)} to ${formatDate(dateRange.latest)}`);
    console.log(`Symbols: ${availableSymbols.join(', ') || 'none'}`);
    console.log('');

    // Warn if requested range is outside available data
    if (startDate < dateRange.earliest) {
      console.warn(`Warning: Start date ${formatDate(startDate)} is before earliest data ${formatDate(dateRange.earliest)}`);
    }
    if (endDate > dateRange.latest) {
      console.warn(`Warning: End date ${formatDate(endDate)} is after latest data ${formatDate(dateRange.latest)}`);
    }

    // Filter symbols to available ones
    let symbols = options.symbols;
    if (symbols) {
      symbols = symbols.filter(s => availableSymbols.includes(s));
      if (symbols.length === 0) {
        console.error(`Error: No requested symbols found in data. Available: ${availableSymbols.join(', ')}`);
        process.exit(1);
      }
    }

    // Create strategy
    const strategy = await createStrategy(options.strategy, options);

    console.log(`Running backtest...`);
    console.log(`  Strategy: ${options.strategy}`);
    console.log(`  Period: ${formatDate(startDate)} to ${formatDate(endDate)}`);
    console.log(`  Symbols: ${symbols ? symbols.join(', ') : 'all'}`);
    console.log(`  Capital: $${options.capital}`);
    console.log(`  Slippage: ${(options.slippage * 100).toFixed(2)}%`);
    console.log('');

    // Progress tracking
    let lastProgressPct = 0;
    const progressCallback = (processed, total) => {
      const pct = Math.floor((processed / total) * 100);
      if (pct > lastProgressPct) {
        process.stdout.write(`\r  Progress: ${pct}%`);
        lastProgressPct = pct;
      }
    };

    // Run backtest
    const result = await runBacktest({
      startDate,
      endDate,
      symbols,
      strategy,
      strategyName: options.strategy,
      initialCapital: options.capital,
      slippagePct: options.slippage,
      onProgress: progressCallback,
      progressIntervalTicks: 1000,
    });

    process.stdout.write('\r'); // Clear progress line

    // Add strategy name to result config for report
    result.config.strategyName = options.strategy;

    // Generate output
    if (options.output) {
      const report = generateReport(result, {
        format: options.format,
        includeTrades: options.verbose,
        includeEquityCurve: options.verbose,
      });

      writeFileSync(options.output, report);
      console.log(`\nResults written to: ${options.output}`);
    } else {
      // Print summary to console
      printSummary(result);

      // If verbose, also print JSON
      if (options.verbose) {
        const report = generateReport(result, {
          format: options.format,
          includeTrades: true,
        });
        console.log('\n--- Full Report ---');
        console.log(report);
      }
    }

  } catch (error) {
    console.error(`\nError: ${error.message}`);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    close();
  }
}

// Run
main();
