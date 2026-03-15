#!/usr/bin/env node
/**
 * Build Timelines CLI
 *
 * Pre-computes per-window timeline caches from PostgreSQL → SQLite.
 *
 * Usage:
 *   node scripts/build-timelines.mjs --symbol=btc          # Build BTC timelines (incremental)
 *   node scripts/build-timelines.mjs --symbol=all           # Build all symbols
 *   node scripts/build-timelines.mjs --symbol=btc --rebuild # Full rebuild for BTC
 *   node scripts/build-timelines.mjs --report               # Show coverage report
 *   node scripts/build-timelines.mjs --report --symbol=btc  # Report for BTC only
 */

import { parseArgs } from 'node:util';
import config from '../config/index.js';
import persistence from '../src/persistence/index.js';
import { runBuild, runReport } from '../src/factory/cli/build-timelines.js';
import { closeDb } from '../src/factory/timeline-store.js';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: '' },
    rebuild: { type: 'boolean', default: false },
    report: { type: 'boolean', default: false },
  },
  strict: false,
});

async function main() {
  try {
    if (values.report) {
      // Report mode: no PG needed, just read SQLite
      runReport({ symbol: values.symbol || undefined });
      closeDb();
      return;
    }

    if (!values.symbol) {
      console.error('Usage: node scripts/build-timelines.mjs --symbol=btc [--rebuild] [--report]');
      console.error('  --symbol=btc    Build timelines for BTC');
      console.error('  --symbol=all    Build timelines for all symbols');
      console.error('  --rebuild       Force full rebuild');
      console.error('  --report        Show coverage report');
      process.exit(1);
    }

    // Initialize PostgreSQL connection
    await persistence.init(config);

    // Run the build
    await runBuild({
      symbol: values.symbol,
      rebuild: values.rebuild,
    });
  } catch (err) {
    console.error('\n[build-timelines] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    closeDb();
    try {
      await persistence.shutdown();
    } catch { /* ignore */ }
  }
}

main();
