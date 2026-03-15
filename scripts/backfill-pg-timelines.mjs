#!/usr/bin/env node
/**
 * Backfill PG Timeline Cache
 *
 * Builds and inserts timelines into pg_timelines for all historical windows
 * not yet cached. Uses concurrent processing for the <30 minute target.
 *
 * Usage:
 *   node scripts/backfill-pg-timelines.mjs --symbol=btc
 *   node scripts/backfill-pg-timelines.mjs --symbol=btc --start-date=2026-01-01 --end-date=2026-03-15
 *   node scripts/backfill-pg-timelines.mjs --symbol=all --concurrency=10
 */

import { parseArgs } from 'node:util';
import config from '../config/index.js';
import persistence from '../src/persistence/index.js';
import { buildTimelines } from '../src/factory/timeline-builder.js';
import { ensurePgTimelineTable, getPgCacheSummary } from '../src/factory/pg-timeline-store.js';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', default: '' },
    'start-date': { type: 'string', default: '' },
    'end-date': { type: 'string', default: '' },
    concurrency: { type: 'string', default: '10' },
  },
  strict: false,
});

async function main() {
  try {
    if (!values.symbol) {
      console.error('Usage: node scripts/backfill-pg-timelines.mjs --symbol=btc [--start-date=...] [--end-date=...]');
      process.exit(1);
    }

    // Initialize PostgreSQL connection
    await persistence.init(config);
    await ensurePgTimelineTable();

    console.log('\n=== PG Timeline Backfill ===');
    console.log(`Symbol: ${values.symbol}`);
    console.log(`Target: pg`);
    console.log('');

    // Show current cache state
    const summary = await getPgCacheSummary();
    if (summary.length > 0) {
      console.log('Current PG cache:');
      for (const row of summary) {
        console.log(`  ${row.symbol}: ${row.total_windows} windows (${row.earliest} to ${row.latest})`);
      }
      console.log('');
    }

    // Run the build with PG target
    // If start-date is provided, disable incremental mode to build from that date
    const hasStartDate = !!values['start-date'];
    const report = await buildTimelines({
      symbol: values.symbol,
      rebuild: hasStartDate,
      incremental: !hasStartDate,
      startDate: values['start-date'] || undefined,
      endDate: values['end-date'] || undefined,
      target: 'pg',
      onProgress: ({ symbol: sym, processed, total, inserted, skipped }) => {
        if (processed % 50 === 0 || processed === total) {
          process.stdout.write(
            `\r  [${sym}] ${processed}/${total} processed, ${inserted} inserted, ${skipped} skipped`
          );
        }
      },
    });

    console.log('\n\n=== Backfill Complete ===');
    if (report.symbols) {
      for (const [sym, r] of Object.entries(report.symbols)) {
        console.log(`  ${sym}: ${r.inserted} inserted, ${r.skippedNoGroundTruth + r.skippedNoEvents} skipped, ${r.errors.length} errors, ${(r.elapsedMs / 1000).toFixed(1)}s`);
      }
    } else {
      console.log(`  ${report.symbol}: ${report.inserted} inserted, ${report.skippedNoGroundTruth + report.skippedNoEvents} skipped, ${report.errors.length} errors, ${(report.elapsedMs / 1000).toFixed(1)}s`);
    }

    // Show updated cache state
    const updatedSummary = await getPgCacheSummary();
    if (updatedSummary.length > 0) {
      console.log('\nUpdated PG cache:');
      for (const row of updatedSummary) {
        console.log(`  ${row.symbol}: ${row.total_windows} windows (${row.earliest} to ${row.latest})`);
      }
    }
    console.log('');

  } catch (err) {
    console.error('\n[backfill] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    try {
      await persistence.shutdown();
    } catch { /* ignore */ }
  }
}

main();
