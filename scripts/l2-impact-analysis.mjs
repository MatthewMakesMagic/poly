#!/usr/bin/env node

/**
 * L2 Data Impact Analysis
 *
 * Compares L1-only vs L1+L2 strategy variants on windows from Feb 22+.
 * Uses CLOB bid_size_top/ask_size_top as L2 proxy (available in timeline).
 *
 * Tests contested-contrarian with varying L2 depth imbalance thresholds.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
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

const CONCURRENCY = 10;

async function initDb() {
  try {
    const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const match = envContent.match(/^DATABASE_URL=["']?([^"'\s]+)["']?$/m);
    if (match) process.env.DATABASE_URL = match[1];
  } catch { /* ignore */ }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  await initLogger({ logging: { level: 'error', console: true, directory: './logs' } });
  await persistence.init({
    database: {
      url: process.env.DATABASE_URL,
      pool: { min: 2, max: 15, connectionTimeoutMs: 30000 },
      circuitBreakerPool: { min: 1, max: 2, connectionTimeoutMs: 30000 },
      queryTimeoutMs: 300000,
      retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  });
}

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** d) / 10 ** d;
}

async function main() {
  console.log('=== L2 Data Impact Analysis ===\n');
  console.log('Comparing L1-only vs L1+L2 variants on Feb 22+ windows\n');
  await initDb();

  // Load windows from Feb 22+
  let windows = await loadWindowsWithGroundTruth({
    startDate: '2026-02-22T00:00:00Z',
    endDate: '2026-12-31T23:59:59Z',
  });
  windows = windows.filter(w =>
    w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open)
  );

  console.log(`Total windows (Feb 22+): ${windows.length}`);
  const bySymbol = {};
  for (const sym of ['btc', 'eth', 'sol', 'xrp']) {
    bySymbol[sym] = windows.filter(w => w.symbol?.toLowerCase() === sym);
    console.log(`  ${sym.toUpperCase()}: ${bySymbol[sym].length}`);
  }
  console.log('');

  // Load strategy variants
  const l1Strategy = await loadStrategy('contested-contrarian');
  const l2Strategy = await loadStrategy('contested-contrarian-l2');

  // Test configurations: L1 baseline vs L2 with varying depth thresholds
  const configs = [
    { name: 'L1-only (no L2)', strategy: l1Strategy, config: l1Strategy.defaults },
    { name: 'L2: imbalance >= 0.0', strategy: l2Strategy, config: { ...l2Strategy.defaults, minDepthImbalance: 0.0, useL2Confirmation: true } },
    { name: 'L2: imbalance >= 0.2', strategy: l2Strategy, config: { ...l2Strategy.defaults, minDepthImbalance: 0.2, useL2Confirmation: true } },
    { name: 'L2: imbalance >= 0.5', strategy: l2Strategy, config: { ...l2Strategy.defaults, minDepthImbalance: 0.5, useL2Confirmation: true } },
    { name: 'L2: imbalance >= 1.0', strategy: l2Strategy, config: { ...l2Strategy.defaults, minDepthImbalance: 1.0, useL2Confirmation: true } },
  ];

  const results = [];

  for (const sym of ['btc', 'eth']) {
    const symWindows = bySymbol[sym];
    if (!symWindows.length) continue;

    console.log(`\n--- ${sym.toUpperCase()} (${symWindows.length} windows) ---`);

    for (const cfg of configs) {
      process.stdout.write(`  ${cfg.name}...`);
      const t0 = Date.now();

      try {
        const result = await runParallelBacktest({
          windows: symWindows,
          config: {
            strategy: cfg.strategy,
            strategyConfig: cfg.config,
            initialCapital: 100,
            spreadBuffer: 0.005,
            tradingFee: 0,
            concurrency: CONCURRENCY,
          },
        });

        const metrics = calculateMetrics(result);
        const bm = calculateBinaryMetrics(result.trades);
        const sec = ((Date.now() - t0) / 1000).toFixed(0);

        const row = {
          symbol: sym.toUpperCase(),
          variant: cfg.name,
          trades: result.summary.totalTrades,
          winRate: round(result.summary.winRate * 100, 1),
          totalPnl: round(result.summary.totalPnl, 2),
          sharpe: round(metrics.sharpeRatio, 2),
          evTrade: round(bm.evPerTrade, 4),
          avgEntry: round(bm.avgEntryPrice, 4),
        };
        results.push(row);
        console.log(` ${row.trades} trades, ${row.winRate}% WR, $${row.totalPnl} PnL, EV=${row.evTrade} [${sec}s]`);
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
      }
    }
  }

  // Summary table
  console.log('\n' + '='.repeat(120));
  console.log('L2 IMPACT COMPARISON');
  console.log('='.repeat(120));
  console.log(
    'Symbol'.padEnd(6) + ' | ' +
    'Variant'.padEnd(25) + ' | ' +
    'Trades'.padStart(7) + ' | ' +
    'WR%'.padStart(7) + ' | ' +
    'PnL$'.padStart(10) + ' | ' +
    'Sharpe'.padStart(7) + ' | ' +
    'EV/Trd'.padStart(8) + ' | ' +
    'AvgEnt'.padStart(7)
  );
  console.log('-'.repeat(120));
  for (const r of results) {
    console.log(
      r.symbol.padEnd(6) + ' | ' +
      r.variant.padEnd(25) + ' | ' +
      String(r.trades).padStart(7) + ' | ' +
      (r.winRate + '%').padStart(7) + ' | ' +
      ('$' + r.totalPnl).padStart(10) + ' | ' +
      String(r.sharpe).padStart(7) + ' | ' +
      ('$' + r.evTrade).padStart(8) + ' | ' +
      String(r.avgEntry).padStart(7)
    );
  }
  console.log('='.repeat(120));

  // Analysis
  console.log('\n--- L2 Impact Summary ---');
  for (const sym of ['BTC', 'ETH']) {
    const symResults = results.filter(r => r.symbol === sym);
    const l1 = symResults.find(r => r.variant.includes('L1-only'));
    if (!l1) continue;
    console.log(`\n${sym}:`);
    console.log(`  L1 baseline: ${l1.trades} trades, ${l1.winRate}% WR, $${l1.totalPnl} PnL`);
    for (const r of symResults.filter(r => !r.variant.includes('L1-only'))) {
      const tradeChange = l1.trades > 0 ? ((r.trades - l1.trades) / l1.trades * 100).toFixed(0) : 'N/A';
      const wrChange = (r.winRate - l1.winRate).toFixed(1);
      console.log(`  ${r.variant}: ${r.trades} trades (${tradeChange}%), WR ${wrChange > 0 ? '+' : ''}${wrChange}pp, $${r.totalPnl} PnL`);
    }
  }

  await persistence.shutdown().catch(() => {});
}

async function loadStrategy(name) {
  const path = resolve(process.cwd(), `src/backtest/strategies/${name}.js`);
  const mod = await import(pathToFileURL(path).href);
  return {
    name: mod.name || name,
    evaluate: mod.evaluate,
    onWindowOpen: mod.onWindowOpen || null,
    onWindowClose: mod.onWindowClose || null,
    defaults: mod.defaults || {},
  };
}

main().catch(err => { console.error(err.message); process.exit(1); });
