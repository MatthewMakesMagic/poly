/**
 * Build Timelines CLI Logic
 *
 * Core logic for the build-timelines command.
 * Importable for programmatic use — the scripts/build-timelines.mjs entry point
 * parses CLI args and calls these functions.
 *
 * Supports:
 *   --symbol=btc    Build timelines for a specific symbol
 *   --symbol=all    Build timelines for all available symbols
 *   --rebuild       Force full rebuild (drops existing cache for the symbol)
 *   --report        Show coverage and quality report
 */

import { buildTimelines } from '../timeline-builder.js';
import { getDb, closeDb, getCacheSummary, getWindowsForSymbol } from '../timeline-store.js';

/**
 * Run the build command.
 *
 * @param {Object} options
 * @param {string} options.symbol - "btc", "eth", "all"
 * @param {boolean} [options.rebuild=false]
 * @returns {Promise<Object>} Build report
 */
export async function runBuild(options) {
  const { symbol, rebuild = false, target = 'sqlite' } = options;

  console.log(`\n=== Timeline Builder ===`);
  console.log(`Symbol: ${symbol}`);
  console.log(`Mode: ${rebuild ? 'REBUILD (full)' : 'incremental'}`);
  console.log(`Target: ${target}`);
  console.log('');

  const report = await buildTimelines({
    symbol,
    rebuild,
    incremental: !rebuild,
    target,
    onProgress: ({ symbol: sym, processed, total, inserted, skipped }) => {
      if (processed % 100 === 0 || processed === total) {
        process.stdout.write(
          `\r  [${sym}] ${processed}/${total} processed, ${inserted} inserted, ${skipped} skipped`
        );
      }
    },
  });

  console.log('\n');
  printBuildReport(report);

  return report;
}

/**
 * Print build report to console.
 */
function printBuildReport(report) {
  if (report.symbols) {
    // Multi-symbol report
    console.log('=== Build Summary (All Symbols) ===\n');
    for (const [sym, r] of Object.entries(report.symbols)) {
      console.log(`  ${sym}:`);
      console.log(`    Windows in PG: ${r.totalWindowsInPg}`);
      console.log(`    Already cached: ${r.alreadyCached}`);
      console.log(`    Inserted: ${r.inserted}`);
      console.log(`    Skipped (no truth): ${r.skippedNoGroundTruth}`);
      console.log(`    Skipped (no events): ${r.skippedNoEvents}`);
      console.log(`    Elapsed: ${(r.elapsedMs / 1000).toFixed(1)}s`);
      if (r.errors.length > 0) {
        console.log(`    Errors: ${r.errors.length}`);
      }
      console.log('');
    }
  } else {
    // Single symbol report
    console.log('=== Build Summary ===\n');
    console.log(`  Symbol: ${report.symbol}`);
    console.log(`  Windows in PG: ${report.totalWindowsInPg}`);
    console.log(`  Already cached: ${report.alreadyCached}`);
    console.log(`  Inserted: ${report.inserted}`);
    console.log(`  Skipped (no truth): ${report.skippedNoGroundTruth}`);
    console.log(`  Skipped (no events): ${report.skippedNoEvents}`);
    console.log(`  Elapsed: ${(report.elapsedMs / 1000).toFixed(1)}s`);
    if (report.errors.length > 0) {
      console.log(`  Errors: ${report.errors.length}`);
      for (const e of report.errors) {
        console.log(`    - ${e.windowId}: ${e.error}`);
      }
    }
    console.log('');
  }
}

/**
 * Run the coverage report command.
 *
 * @param {Object} [options]
 * @param {string} [options.symbol] - Filter to a specific symbol
 */
export function runReport(options = {}) {
  const { symbol } = options;

  console.log('\n=== Timeline Coverage Report ===\n');

  const summary = getCacheSummary();

  if (summary.length === 0) {
    console.log('  No timelines cached. Run `node scripts/build-timelines.mjs --symbol=btc` first.\n');
    return;
  }

  const filteredSummary = symbol
    ? summary.filter(s => s.symbol === symbol)
    : summary;

  if (filteredSummary.length === 0) {
    console.log(`  No timelines found for symbol "${symbol}".\n`);
    return;
  }

  // Per-symbol summary table
  console.log(
    padRight('Symbol', 8) +
    padRight('Windows', 10) +
    padRight('Earliest', 26) +
    padRight('Latest', 26) +
    padRight('Avg Events', 12) +
    padRight('L2 Avail %', 12) +
    padRight('Flagged', 10)
  );
  console.log('-'.repeat(104));

  for (const row of filteredSummary) {
    // Get detailed quality analysis
    const windowsMeta = getWindowsForSymbol(row.symbol);
    const { l2Pct, flagCounts, flaggedWindows } = analyzeQuality(windowsMeta);

    console.log(
      padRight(row.symbol, 8) +
      padRight(String(row.total_windows), 10) +
      padRight(row.earliest || 'N/A', 26) +
      padRight(row.latest || 'N/A', 26) +
      padRight(Math.round(row.avg_event_count).toString(), 12) +
      padRight(`${l2Pct.toFixed(1)}%`, 12) +
      padRight(String(flaggedWindows.length), 10)
    );
  }

  console.log('');

  // Flagged windows detail
  for (const row of filteredSummary) {
    const windowsMeta = getWindowsForSymbol(row.symbol);
    const { flagCounts, flaggedWindows } = analyzeQuality(windowsMeta);

    if (flaggedWindows.length === 0) continue;

    console.log(`\n  Flagged Windows for ${row.symbol}:`);
    console.log(`  ${'─'.repeat(80)}`);

    // Count by type
    console.log(`  Flag counts: ${Object.entries(flagCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log('');

    // Show individual flagged windows (limit to 20)
    const shown = flaggedWindows.slice(0, 20);
    for (const fw of shown) {
      console.log(`    ${fw.window_id}: ${fw.reasons.join(', ')}`);
    }
    if (flaggedWindows.length > 20) {
      console.log(`    ... and ${flaggedWindows.length - 20} more`);
    }
  }

  console.log('');
}

/**
 * Analyze quality metadata for a set of windows.
 */
function analyzeQuality(windowsMeta) {
  let withL2 = 0;
  const flagCounts = {};
  const flaggedWindows = [];

  for (const w of windowsMeta) {
    if (!w.data_quality) continue;

    let quality;
    try {
      quality = JSON.parse(w.data_quality);
    } catch {
      continue;
    }

    if (quality.l2_count > 0) withL2++;

    if (quality.flags && quality.flags.length > 0) {
      const reasons = [];
      for (const flag of quality.flags) {
        flagCounts[flag.type] = (flagCounts[flag.type] || 0) + 1;
        reasons.push(`${flag.type}: ${flag.message}`);
      }
      flaggedWindows.push({ window_id: w.window_id, reasons });
    }
  }

  const l2Pct = windowsMeta.length > 0 ? (withL2 / windowsMeta.length) * 100 : 0;

  return { l2Pct, flagCounts, flaggedWindows };
}

/**
 * Simple string padding utility for table rendering.
 */
function padRight(str, len) {
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}
