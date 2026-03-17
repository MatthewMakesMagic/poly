#!/usr/bin/env node

/**
 * Factory Backtest CLI (Story 3.2)
 *
 * Usage:
 *   node scripts/backtest-factory.mjs --strategy=deficit-asymmetry-v1.yaml --symbol=btc --sample=200 --seed=42
 *   node scripts/backtest-factory.mjs --strategy=edge-c-asymmetry --symbol=btc,eth --json
 *
 * Options:
 *   --strategy=<name>   Strategy file (YAML or JS) from src/factory/strategies/ or src/backtest/strategies/
 *   --symbol=<s>        Symbol(s), comma-separated (default: btc)
 *   --sample=<N>        Sample size (default: 200)
 *   --seed=<N>          PRNG seed (default: 42)
 *   --capital=<N>       Initial capital per window (default: 100)
 *   --spread=<N>        Spread buffer (default: 0.005)
 *   --fee=<N>           Trading fee (default: 0)
 *   --fee-mode=<m>      Fee mode: taker, maker, zero (default: taker)
 *   --source=<s>        Data source: pg, cache, or pg-cache (default: cache, pg on Railway, pg-cache auto-detected)
 *   --json              Output raw JSON (for piping)
 *   --no-baseline       Skip baseline comparison
 *   --output=<path>     Write results to file
 *   --help              Show help
 */

import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { runFactoryBacktest, runFactoryBacktestPg, runFactoryBacktestPgCache } from '../src/factory/cli/backtest-factory.js';
import { getDb, closeDb } from '../src/factory/timeline-store.js';
import { renderResultsTable, renderComparisonTable } from '../src/factory/cli/output-formatter.js';

// ─── Arg Parsing ───

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    strategy: null,
    symbol: 'btc',
    sample: 200,
    seed: 42,
    capital: 100,
    spread: 0.005,
    fee: 0,
    feeMode: null,
    source: process.env.RAILWAY_ENVIRONMENT ? 'pg' : 'cache',
    sourceExplicit: false,
    json: false,
    baseline: true,
    holdout: false,
    holdoutRatio: 0.3,
    output: null,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--no-baseline') { opts.baseline = false; continue; }
    if (arg === '--holdout') { opts.holdout = true; continue; }

    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (match) {
      const [, key, value] = match;
      switch (key) {
        case 'strategy': opts.strategy = value; break;
        case 'symbol': opts.symbol = value.toLowerCase(); break;
        case 'sample': opts.sample = parseInt(value, 10); break;
        case 'seed': opts.seed = parseInt(value, 10); break;
        case 'capital': opts.capital = parseFloat(value); break;
        case 'spread': opts.spread = parseFloat(value); break;
        case 'fee': opts.fee = parseFloat(value); break;
        case 'output': opts.output = value; break;
        case 'fee-mode': opts.feeMode = value; break;
        case 'source': opts.source = value.toLowerCase(); opts.sourceExplicit = true; break;
        case 'holdout-ratio': opts.holdoutRatio = parseFloat(value); break;
      }
    }
  }

  return opts;
}

// ─── Strategy Loader ───

async function loadStrategy(name) {
  // Try YAML first (src/factory/strategies/)
  const yamlPath = resolve(process.cwd(), `src/factory/strategies/${name}`);
  const yamlPathWithExt = name.endsWith('.yaml') || name.endsWith('.yml')
    ? yamlPath
    : `${yamlPath}.yaml`;

  if (existsSync(yamlPathWithExt)) {
    // Dynamically import compose engine
    const { composeFromYaml } = await import('../src/factory/compose.js');
    const yamlContent = readFileSync(yamlPathWithExt, 'utf8');
    return composeFromYaml(yamlContent);
  }

  // Try JS in factory/strategies/
  const factoryJsPath = resolve(process.cwd(), `src/factory/strategies/${name}`);
  const factoryJsWithExt = name.endsWith('.js') ? factoryJsPath : `${factoryJsPath}.js`;
  if (existsSync(factoryJsWithExt)) {
    const mod = await import(pathToFileURL(factoryJsWithExt).href);
    return normalizeJsStrategy(mod, name);
  }

  // Try JS in backtest/strategies/
  const backtestJsPath = resolve(process.cwd(), `src/backtest/strategies/${name}`);
  const backtestJsWithExt = name.endsWith('.js') ? backtestJsPath : `${backtestJsPath}.js`;
  if (existsSync(backtestJsWithExt)) {
    const mod = await import(pathToFileURL(backtestJsWithExt).href);
    return normalizeJsStrategy(mod, name);
  }

  throw new Error(
    `Strategy '${name}' not found. Searched:\n` +
    `  - ${yamlPathWithExt}\n` +
    `  - ${factoryJsWithExt}\n` +
    `  - ${backtestJsWithExt}`
  );
}

function normalizeJsStrategy(mod, name) {
  if (typeof mod.evaluate !== 'function') {
    throw new Error(`Strategy '${name}' must export an evaluate function`);
  }
  return {
    name: mod.name || name,
    evaluate: mod.evaluate,
    onWindowOpen: mod.onWindowOpen || null,
    onWindowClose: mod.onWindowClose || null,
    defaults: mod.defaults || {},
    sweepGrid: mod.sweepGrid || {},
  };
}

// ─── Main ───

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
Factory Backtest CLI

Usage:
  node scripts/backtest-factory.mjs --strategy=<name> [options]

Required:
  --strategy=<name>   Strategy file (YAML or JS)

Options:
  --symbol=<s>        Symbol(s), comma-separated (default: btc)
  --sample=<N>        Sample size (default: 200)
  --seed=<N>          PRNG seed (default: 42)
  --capital=<N>       Initial capital per window (default: 100)
  --spread=<N>        Spread buffer (default: 0.005)
  --fee=<N>           Trading fee (default: 0)
  --fee-mode=<m>      Fee mode: taker, maker, zero (default: taker)
  --source=<s>        Data source: pg, cache, or pg-cache (default: cache, pg on Railway, pg-cache auto-detected)
  --json              Output raw JSON
  --no-baseline       Skip baseline comparison
  --output=<path>     Write results to file
`);
    process.exit(0);
  }

  if (!opts.strategy) {
    console.error('Error: --strategy is required. Use --help for usage.');
    process.exit(1);
  }

  let source = opts.source;

  try {
    if (source === 'pg' || source === 'pg-cache') {
      // PG-based sources: init persistence (PostgreSQL)
      const config = (await import('../config/index.js')).default;
      const persistence = (await import('../src/persistence/index.js')).default;
      await persistence.init(config);

      // Auto-detect pg-cache on Railway: only when source was NOT explicitly set by the user
      if (source === 'pg' && process.env.RAILWAY_ENVIRONMENT && !opts.sourceExplicit) {
        try {
          const { getPgCacheSummary, ensurePgTimelineTable } = await import('../src/factory/pg-timeline-store.js');
          await ensurePgTimelineTable();
          const summary = await getPgCacheSummary();
          const totalWindows = summary.reduce((s, r) => s + Number(r.total_windows), 0);
          if (totalWindows > 0) {
            source = 'pg-cache';
            console.log(`Data source: pg-cache (auto-detected, ${totalWindows} cached timelines)`);
          } else {
            console.log(`Data source: PostgreSQL (${process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'remote'})`);
          }
        } catch {
          console.log(`Data source: PostgreSQL (${process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'remote'})`);
        }
      } else if (source === 'pg-cache') {
        const { ensurePgTimelineTable } = await import('../src/factory/pg-timeline-store.js');
        await ensurePgTimelineTable();
        console.log('Data source: pg-cache (pre-computed BYTEA timelines)');
      } else {
        console.log(`Data source: PostgreSQL (${process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'remote'})`);
      }
    } else {
      // Cache source: init SQLite (read-only)
      getDb({ readonly: true });
      console.log('Data source: SQLite cache');
    }

    const strategy = await loadStrategy(opts.strategy);
    const symbols = opts.symbol.split(',').map(s => s.trim()).filter(Boolean);

    const backtestFn = source === 'pg-cache'
      ? runFactoryBacktestPgCache
      : source === 'pg'
        ? runFactoryBacktestPg
        : runFactoryBacktest;

    const allResults = [];

    for (const symbol of symbols) {
      const result = await backtestFn({
        strategy,
        symbol,
        sampleOptions: {
          count: opts.sample,
          seed: opts.seed,
        },
        config: {
          initialCapital: opts.capital,
          spreadBuffer: opts.spread,
          tradingFee: opts.fee,
          feeMode: opts.feeMode,
        },
        includeBaseline: opts.baseline,
        holdout: opts.holdout,
        holdoutRatio: opts.holdoutRatio,
      });

      allResults.push(result);
    }

    // Output
    if (opts.json) {
      const output = symbols.length === 1 ? allResults[0] : allResults;
      console.log(JSON.stringify(output, null, 2));
    } else {
      for (const result of allResults) {
        renderResultsTable(result);
      }
      if (allResults.length > 1) {
        renderComparisonTable(allResults);
      }
    }

    if (opts.output) {
      const output = symbols.length === 1 ? allResults[0] : allResults;
      writeFileSync(opts.output, JSON.stringify(output, null, 2));
      console.log(`\nResults written to: ${opts.output}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  } finally {
    if (source === 'cache') {
      closeDb();
    }
  }
}

main();
