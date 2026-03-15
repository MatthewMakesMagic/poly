#!/usr/bin/env node

/**
 * Batch Runner CLI (Story 3.6)
 *
 * Usage:
 *   node scripts/batch-run.mjs --manifest=deficit-exploration.json
 *   node scripts/batch-run.mjs --manifest=deficit-exploration.json --json
 *   node scripts/batch-run.mjs --manifest=deficit-exploration.json --persist
 *
 * Manifest format (JSON):
 * {
 *   "name": "deficit-exploration",
 *   "defaults": { "sample": 200, "seed": 42, "config": { "capital": 100 } },
 *   "runs": [
 *     { "strategy": "edge-c-asymmetry", "symbol": "btc" },
 *     { "strategy": "edge-c-asymmetry", "symbol": "eth", "sample": 150 },
 *     { "strategy": "deficit-strategy-v1.yaml", "symbol": "btc,eth" }
 *   ]
 * }
 *
 * Options:
 *   --manifest=<path>   Path to JSON manifest (required)
 *   --json              Output raw JSON
 *   --persist           Persist results to PostgreSQL
 *   --concurrency=<N>   Max parallel runs (default: 4)
 *   --output=<path>     Write results to file
 *   --help              Show help
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { runBatch } from '../src/factory/batch-runner.js';
import { getDb, closeDb } from '../src/factory/timeline-store.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    manifest: null,
    json: false,
    persist: false,
    concurrency: 4,
    output: null,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--persist') { opts.persist = true; continue; }

    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (match) {
      const [, key, value] = match;
      switch (key) {
        case 'manifest': opts.manifest = value; break;
        case 'concurrency': opts.concurrency = parseInt(value, 10); break;
        case 'output': opts.output = value; break;
      }
    }
  }

  return opts;
}

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** d) / 10 ** d;
}

function pad(str, len, align = 'left') {
  const s = String(str);
  return align === 'right' ? s.padStart(len) : s.padEnd(len);
}

function renderBatchTable(batchResult) {
  console.log('\n' + '='.repeat(100));
  console.log(`BATCH: ${batchResult.batchName} | ${batchResult.totalRuns} runs | ${batchResult.completed} OK, ${batchResult.failed} FAILED | ${batchResult.wallClockMs}ms`);
  console.log('='.repeat(100));

  if (batchResult.ranking.length === 0) {
    console.log('  No successful results.');
    return;
  }

  const header = [
    pad('#', 4, 'right'),
    pad('Strategy', 28),
    pad('Symbol', 6),
    pad('Sharpe', 8, 'right'),
    pad('PF', 7, 'right'),
    pad('WinRate', 8, 'right'),
    pad('Trades', 7, 'right'),
    pad('PnL', 10, 'right'),
    pad('Time', 8, 'right'),
  ].join(' | ');

  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (let i = 0; i < batchResult.ranking.length; i++) {
    const r = batchResult.ranking[i];
    console.log([
      pad(i + 1, 4, 'right'),
      pad(r.strategy.slice(0, 28), 28),
      pad(r.symbol.toUpperCase(), 6),
      pad(round(r.bestSharpe, 2), 8, 'right'),
      pad(round(r.bestPF, 2), 7, 'right'),
      pad((round(r.bestWinRate * 100, 1) + '%'), 8, 'right'),
      pad(r.trades, 7, 'right'),
      pad('$' + round(r.totalPnl, 2), 10, 'right'),
      pad(r.wallClockMs + 'ms', 8, 'right'),
    ].join(' | '));
  }

  // Show failures
  const failures = batchResult.results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    console.log('\nFailed runs:');
    for (const f of failures) {
      console.log(`  ${f.strategy} x ${f.symbol}: ${f.error}`);
    }
  }

  console.log('');
}

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
Batch Runner CLI

Usage:
  node scripts/batch-run.mjs --manifest=<path> [options]

Options:
  --manifest=<path>   JSON manifest file (required)
  --json              Raw JSON output
  --persist           Persist to PostgreSQL
  --concurrency=<N>   Max parallel runs (default: 4)
  --output=<path>     Write results to file
`);
    process.exit(0);
  }

  if (!opts.manifest) {
    console.error('Error: --manifest is required. Use --help for usage.');
    process.exit(1);
  }

  try {
    // Init SQLite (read-only)
    getDb({ readonly: true });

    // Load manifest
    const manifestPath = resolve(process.cwd(), opts.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.concurrency = opts.concurrency;

    // Init persistence if needed
    if (opts.persist) {
      const { readFileSync: readFs } = await import('fs');
      const { resolve: resolvePath } = await import('path');
      if (!process.env.DATABASE_URL) {
        try {
          const envContent = readFs(resolvePath(process.cwd(), '.env.local'), 'utf8');
          const match = envContent.match(/^DATABASE_URL=(.+)$/m);
          if (match) process.env.DATABASE_URL = match[1];
        } catch { /* ignore */ }
      }

      if (process.env.DATABASE_URL) {
        const persistence = (await import('../src/persistence/index.js')).default;
        await persistence.init({
          database: {
            url: process.env.DATABASE_URL,
            pool: { min: 1, max: 5, connectionTimeoutMs: 15000 },
            circuitBreakerPool: { min: 1, max: 2, connectionTimeoutMs: 5000 },
            queryTimeoutMs: 60000,
            retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
          },
        });
      }
    }

    // Expand multi-symbol runs
    const expandedRuns = [];
    for (const run of manifest.runs) {
      if (run.symbol && run.symbol.includes(',')) {
        const symbols = run.symbol.split(',').map(s => s.trim());
        for (const sym of symbols) {
          expandedRuns.push({ ...run, symbol: sym });
        }
      } else {
        expandedRuns.push(run);
      }
    }
    manifest.runs = expandedRuns;

    if (!opts.json) {
      console.log(`Batch: ${manifest.name || 'unnamed'}`);
      console.log(`Runs: ${manifest.runs.length}`);
      console.log(`Concurrency: ${opts.concurrency}`);
      console.log('');
    }

    const batchResult = await runBatch(manifest, {
      persist: opts.persist,
      onProgress: !opts.json
        ? (done, total) => process.stdout.write(`\r  Progress: ${done}/${total}`)
        : undefined,
    });

    if (!opts.json) {
      process.stdout.write('\r');
    }

    // Output
    if (opts.json) {
      console.log(JSON.stringify(batchResult, null, 2));
    } else {
      renderBatchTable(batchResult);
    }

    if (opts.output) {
      writeFileSync(opts.output, JSON.stringify(batchResult, null, 2));
      console.log(`Results written to: ${opts.output}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  } finally {
    closeDb();
  }
}

main();
