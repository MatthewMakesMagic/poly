#!/usr/bin/env node
/**
 * CLI: Mutate Strategy (Story 4.5)
 *
 * Generate N mutations of an existing strategy and optionally backtest all variants.
 *
 * Usage:
 *   node scripts/mutate-strategy.mjs --strategy=edge-c-asymmetry --count=10 --type=perturb
 *   node scripts/mutate-strategy.mjs --strategy=edge-c-asymmetry --count=20 --type=mixed --backtest
 *   node scripts/mutate-strategy.mjs --strategy=edge-c-asymmetry --count=5 --type=structural
 *
 * Flags:
 *   --strategy   Strategy name (without .yaml extension) or path to YAML file
 *   --count      Number of variants to generate (default: 10)
 *   --type       Mutation type: perturb, structural, mixed (default: perturb)
 *   --backtest   Auto-backtest all generated variants via batch runner
 *   --seed       PRNG seed (default: 42)
 *   --crossover  Second strategy for crossover mutations (used with --type=mixed)
 *   --symbol     Symbol for backtesting (default: btc)
 *   --sample     Sample size for backtesting (default: 200)
 *
 * Covers: FR10, FR11, FR12, FR13, FR9 (inspectable YAML)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { loadBlocks } from '../src/factory/registry.js';
import { batchMutate } from '../src/factory/mutation.js';

// ─── Arg Parsing ───

const args = process.argv.slice(2);

function getArg(name, defaultValue = undefined) {
  const prefix = `--${name}=`;
  const arg = args.find(a => a.startsWith(prefix));
  if (arg) return arg.slice(prefix.length);

  // Boolean flag check
  if (args.includes(`--${name}`)) return true;

  return defaultValue;
}

const strategyName = getArg('strategy');
const count = parseInt(getArg('count', '10'), 10);
const type = getArg('type', 'perturb');
const doBacktest = getArg('backtest', false) !== false;
const seed = parseInt(getArg('seed', '42'), 10);
const crossoverName = getArg('crossover');
const symbol = getArg('symbol', 'btc');
const sample = parseInt(getArg('sample', '200'), 10);

if (!strategyName) {
  console.error('Error: --strategy is required');
  console.error('Usage: node scripts/mutate-strategy.mjs --strategy=edge-c-asymmetry --count=10 --type=perturb');
  process.exit(1);
}

// ─── Main ───

async function main() {
  const startTime = Date.now();

  // Initialize block registry
  await loadBlocks();

  // Load source strategy YAML
  const yamlDef = loadStrategyYaml(strategyName);
  console.log(`\nLoaded source strategy: ${strategyName}`);
  console.log(`Mutation type: ${type}`);
  console.log(`Generating ${count} variants...\n`);

  // Load crossover YAML if specified
  let crossoverYaml = null;
  if (crossoverName) {
    crossoverYaml = loadStrategyYaml(crossoverName);
    console.log(`Crossover strategy: ${crossoverName}\n`);
  }

  // Generate mutations
  const { variants, summary, errors } = await batchMutate(yamlDef, {
    count,
    type,
    seed,
    crossoverYaml,
    recordLineage: false, // Don't require DB for CLI
    createdBy: 'claude',
  });

  if (errors.length > 0) {
    console.warn('Warnings during generation:');
    for (const err of errors) {
      console.warn(`  - ${err}`);
    }
    console.warn('');
  }

  if (variants.length === 0) {
    console.error('No variants were generated. Check the warnings above.');
    process.exit(1);
  }

  // Write YAML files to strategies directory
  const strategiesDir = resolve(process.cwd(), 'src/factory/strategies');
  const written = [];

  for (const variant of variants) {
    const filePath = resolve(strategiesDir, `${variant.name}.yaml`);
    writeFileSync(filePath, variant.yamlString, 'utf8');
    written.push({ name: variant.name, path: filePath });
  }

  console.log(`Written ${written.length} variant files to src/factory/strategies/\n`);

  // Print summary table
  printSummaryTable(summary);

  // Auto-backtest if requested
  if (doBacktest) {
    console.log(`\nBacktesting ${variants.length} variants on ${symbol} (sample=${sample})...\n`);

    try {
      const { runBatch } = await import('../src/factory/batch-runner.js');

      const manifest = {
        name: `mutation-batch-${strategyName}-${type}`,
        defaults: {
          symbol,
          sample,
          seed,
        },
        runs: variants.map(v => ({
          strategy: v.name,
        })),
      };

      const batchResult = await runBatch(manifest, {
        persist: false,
        onProgress: (completed, total, result) => {
          const status = result.error ? 'FAILED' : 'OK';
          const sharpe = result.variants?.[0]?.metrics?.sharpe?.toFixed(2) || 'N/A';
          console.log(`  [${completed}/${total}] ${result.strategy || 'unknown'}: ${status} (Sharpe: ${sharpe})`);
        },
      });

      console.log('\n─── Backtest Results ───');
      console.log(`Completed: ${batchResult.completed}/${batchResult.totalRuns}`);
      console.log(`Failed: ${batchResult.failed}`);
      console.log(`Wall clock: ${batchResult.wallClockMs}ms\n`);

      if (batchResult.ranking.length > 0) {
        console.log('Top variants by Sharpe:');
        for (const r of batchResult.ranking.slice(0, 10)) {
          console.log(`  ${r.strategy}: Sharpe=${r.bestSharpe.toFixed(2)} WR=${(r.bestWinRate * 100).toFixed(1)}% PnL=$${r.totalPnl.toFixed(2)}`);
        }
      }
    } catch (err) {
      console.error(`Backtest failed: ${err.message}`);
      console.error('Variants are still written to disk for inspection (FR9).');
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`\nDone in ${elapsed}ms`);
}

// ─── Helpers ───

function loadStrategyYaml(name) {
  // Try direct path first
  if (existsSync(name)) {
    return readFileSync(name, 'utf8');
  }

  // Try strategies directory
  const strategiesDir = resolve(process.cwd(), 'src/factory/strategies');
  const candidates = [
    resolve(strategiesDir, name),
    resolve(strategiesDir, `${name}.yaml`),
    resolve(strategiesDir, `${name}.yml`),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }

  console.error(`Strategy '${name}' not found. Searched:`);
  for (const path of candidates) {
    console.error(`  - ${path}`);
  }
  process.exit(1);
}

function printSummaryTable(summary) {
  if (summary.length === 0) return;

  console.log('─── Mutation Summary ───');
  console.log('');

  // Header
  const nameWidth = Math.max(20, ...summary.map(s => s.name.length)) + 2;
  const typeWidth = 16;

  console.log(
    'Name'.padEnd(nameWidth) +
    'Type'.padEnd(typeWidth) +
    'Key Changes'
  );
  console.log('─'.repeat(nameWidth + typeWidth + 40));

  for (const row of summary) {
    const changes = row.keyChanges.length > 60
      ? row.keyChanges.substring(0, 57) + '...'
      : row.keyChanges;
    console.log(
      row.name.padEnd(nameWidth) +
      row.mutationType.padEnd(typeWidth) +
      changes
    );
  }
}

// ─── Run ───

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
