#!/usr/bin/env node

/**
 * Fast runner: ALL strategies x ALL symbols against Gamma ground truth.
 * Loads data PER-SYMBOL to stay within memory limits (~3GB per symbol vs 12GB total).
 * RTDS ticks (shared across symbols) loaded once and reused.
 *
 * Reports:
 *   - Per-strategy per-symbol results with $2 capital-based sizing
 *   - Cheap entry analysis (entries < $0.10, < $0.20, < $0.30)
 *   - Top contrarian/cheap wins with analysis
 *
 * Usage:
 *   node --max-old-space-size=6144 scripts/run-all-strategies-fast.mjs
 *   node --max-old-space-size=6144 scripts/run-all-strategies-fast.mjs --strategy=contested-contrarian
 *   node --max-old-space-size=6144 scripts/run-all-strategies-fast.mjs --output=results/capital-based.json
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import { pathToFileURL } from 'url';
import persistence from '../src/persistence/index.js';
import { init as initLogger } from '../src/modules/logger/index.js';
import {
  loadWindowsWithGroundTruth,
  loadAllDataForSymbol,
  loadRtdsTicks,
} from '../src/backtest/data-loader.js';
import {
  runParallelBacktest,
} from '../src/backtest/parallel-engine.js';
import { calculateMetrics, calculateBinaryMetrics } from '../src/backtest/metrics.js';

const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] || '50', 10);
const OUTPUT_PATH = process.argv.find(a => a.startsWith('--output='))?.split('=')[1] || null;
const SINGLE = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1] || null;
const WINDOW_LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const SYMBOL_FILTER = process.argv.find(a => a.startsWith('--symbol='))?.split('=')[1]?.toLowerCase() || null;

const CHEAP_BUCKETS = [
  { label: '<$0.10', max: 0.10 },
  { label: '$0.10-0.20', min: 0.10, max: 0.20 },
  { label: '$0.20-0.30', min: 0.20, max: 0.30 },
  { label: '$0.30-0.50', min: 0.30, max: 0.50 },
  { label: '>$0.50', min: 0.50 },
];

async function initDb() {
  if (!process.env.DATABASE_URL) {
    try {
      const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) process.env.DATABASE_URL = match[1];
    } catch { /* ignore */ }
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  await initLogger({ logging: { level: 'error', console: true, directory: './logs' } });
  await persistence.init({
    database: {
      url: process.env.DATABASE_URL,
      pool: { min: 2, max: 10, connectionTimeoutMs: 60000 },
      circuitBreakerPool: { min: 1, max: 2, connectionTimeoutMs: 30000 },
      queryTimeoutMs: 600000,
      retry: { maxAttempts: 5, initialDelayMs: 1000, maxDelayMs: 10000 },
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
        description: mod.description || '',
        evaluate: mod.evaluate,
        onWindowOpen: mod.onWindowOpen || null,
        onWindowClose: mod.onWindowClose || null,
        onPassiveFill: mod.onPassiveFill || null,
        usesPassiveOrders: mod.usesPassiveOrders || false,
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

function analyzeCheapEntries(trades) {
  const buckets = [];
  for (const b of CHEAP_BUCKETS) {
    const filtered = trades.filter(t => {
      if (b.min != null && t.entryPrice < b.min) return false;
      if (b.max != null && t.entryPrice >= b.max) return false;
      return true;
    });
    if (filtered.length === 0) {
      buckets.push({ bucket: b.label, count: 0, wins: 0, winRate: 0, totalPnl: 0, avgPnl: 0, avgTokens: 0, avgEntry: 0, avgROC: 0 });
      continue;
    }
    const wins = filtered.filter(t => t.pnl > 0);
    const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);
    const avgTokens = filtered.reduce((s, t) => s + t.size, 0) / filtered.length;
    const avgEntry = filtered.reduce((s, t) => s + t.entryPrice, 0) / filtered.length;
    const avgROC = filtered.reduce((s, t) => s + (t.cost > 0 ? t.pnl / t.cost : 0), 0) / filtered.length * 100;
    buckets.push({
      bucket: b.label,
      count: filtered.length,
      wins: wins.length,
      winRate: round(wins.length / filtered.length * 100, 1),
      totalPnl: round(totalPnl, 2),
      avgPnl: round(totalPnl / filtered.length, 4),
      avgTokens: round(avgTokens, 1),
      avgEntry: round(avgEntry, 4),
      avgROC: round(avgROC, 1),
    });
  }
  return buckets;
}

// ─── DB Persistence Helpers ───

async function createBacktestRun(config) {
  const row = await persistence.get(
    `INSERT INTO backtest_runs (status, config, total_strategies, total_symbols, total_windows)
     VALUES ('running', $1, $2, $3, $4)
     RETURNING run_id`,
    [JSON.stringify(config), config.totalStrategies, config.totalSymbols, config.totalWindows]
  );
  return row.run_id;
}

async function persistTrades(runId, strategyName, strategyDesc, symbol, trades, windows) {
  if (!trades || trades.length === 0) return;

  // Build window_close_time lookup from windows array
  const windowTimeByEpoch = {};
  for (const w of windows) {
    const epoch = Math.floor(new Date(w.window_close_time).getTime() / 1000);
    windowTimeByEpoch[epoch] = w.window_close_time;
  }

  // Bulk insert in batches of 500
  const BATCH = 500;
  for (let i = 0; i < trades.length; i += BATCH) {
    const batch = trades.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let idx = 1;

    for (const t of batch) {
      const direction = t.token?.includes('-up') ? 'up' : t.token?.includes('-down') ? 'down' : null;
      const windowEpoch = t.windowEpoch || null;
      const windowCloseTime = windowEpoch ? (windowTimeByEpoch[windowEpoch] || null) : null;
      const won = t.pnl > 0;
      const payout = won ? t.size : 0;
      const timeToCloseMs = t.timeToCloseMs || null;

      values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9}, $${idx+10}, $${idx+11}, $${idx+12}, $${idx+13}, $${idx+14}, $${idx+15})`);
      params.push(
        runId, strategyName, strategyDesc, symbol,
        windowEpoch, windowCloseTime, direction,
        t.entryPrice, t.exitPrice || (won ? 1.0 : 0.0),
        t.size, t.cost, t.pnl, payout, won,
        t.reason || null, t.confidence || null
      );
      idx += 16;
    }

    await persistence.run(
      `INSERT INTO backtest_trades (run_id, strategy, strategy_description, symbol,
        window_epoch, window_close_time, direction,
        entry_price, exit_price, size, cost, pnl, payout, won,
        reason, confidence)
       VALUES ${values.join(',')}`,
      params
    );
  }
}

async function updateRunProgress(runId, completedPairs, totalPairs) {
  const pct = Math.round(completedPairs / totalPairs * 100 * 100) / 100;
  await persistence.run(
    `UPDATE backtest_runs SET completed_pairs = $1, progress_pct = $2 WHERE run_id = $3`,
    [completedPairs, pct, runId]
  );
}

async function completeRun(runId, summary) {
  await persistence.run(
    `UPDATE backtest_runs SET status = 'completed', completed_at = NOW(), summary = $1 WHERE run_id = $2`,
    [JSON.stringify(summary), runId]
  );
}

async function failRun(runId, error) {
  await persistence.run(
    `UPDATE backtest_runs SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE run_id = $2`,
    [error, runId]
  );
}

async function main() {
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(`Running on Railway (${process.env.RAILWAY_ENVIRONMENT})`);
  }
  console.log('=== All Strategies vs Gamma Ground Truth ($2/trade capital-based sizing) ===\n');
  const t0Global = Date.now();
  await initDb();

  const strategies = await discoverStrategies();
  console.log(`Strategies: ${strategies.map(s => s.name).join(', ')}\n`);

  // Load windows
  console.log('Loading windows with ground truth...');
  let allWindows = await loadWindowsWithGroundTruth({
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-12-31T23:59:59Z',
  });
  allWindows = allWindows.filter(w =>
    w.gamma_resolved_direction || w.onchain_resolved_direction || w.resolved_direction ||
    (w.chainlink_price_at_close && w.oracle_price_at_open)
  );

  const activeSymbols = SYMBOL_FILTER ? [SYMBOL_FILTER] : SYMBOLS;
  const bySymbol = {};
  for (const sym of activeSymbols) {
    let symWindows = allWindows.filter(w => w.symbol?.toLowerCase() === sym);
    if (WINDOW_LIMIT > 0) symWindows = symWindows.slice(0, WINDOW_LIMIT);
    bySymbol[sym] = symWindows;
  }

  console.log(`Total: ${allWindows.length} windows${WINDOW_LIMIT ? ` (limited to ${WINDOW_LIMIT} per symbol)` : ''}${SYMBOL_FILTER ? ` (symbol: ${SYMBOL_FILTER})` : ''}`);
  for (const sym of activeSymbols) console.log(`  ${sym.toUpperCase()}: ${bySymbol[sym].length}`);

  // Compute date range from SELECTED windows (not all — respects --limit and --symbol)
  let minTime = Infinity, maxTime = -Infinity;
  for (const sym of activeSymbols) {
    for (const w of bySymbol[sym]) {
      const t = new Date(w.window_close_time).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
  }
  const startDate = new Date(minTime - 10 * 60 * 1000).toISOString();
  const endDate = new Date(maxTime + 60 * 1000).toISOString();
  console.log(`Date range: ${startDate.slice(0,10)} to ${endDate.slice(0,10)}`);

  // RTDS ticks loaded per-symbol below (not all-at-once) to stay within 8GB Railway memory limit
  const sharedRtds = null;

  // ─── Create backtest run in DB ───
  const totalPairs = strategies.length * activeSymbols.filter(s => bySymbol[s]?.length > 0).length;
  let runId = null;
  try {
    runId = await createBacktestRun({
      totalStrategies: strategies.length,
      totalSymbols: SYMBOLS.length,
      totalWindows: allWindows.length,
      strategies: strategies.map(s => s.name),
      symbols: SYMBOLS,
      capitalPerTrade: 2,
      concurrency: CONCURRENCY,
    });
    console.log(`\nBacktest run created: ${runId}`);
  } catch (err) {
    console.warn(`Warning: Could not create backtest_runs row: ${err.message}`);
  }

  // ─── RUN: Per-symbol data loading + all strategies ───
  const results = [];
  const allTradesByStrategy = {};
  let completedPairs = 0;

  for (const sym of activeSymbols) {
    const windows = bySymbol[sym];
    if (!windows.length) continue;

    // Load ALL data for this symbol (RTDS + CLOB + exchange) — keeps peak memory to ~one symbol
    console.log(`\n--- Loading ${sym.toUpperCase()} data ---`);
    const memBefore = process.memoryUsage();
    console.log(`  Memory: heap=${(memBefore.heapUsed/1024/1024).toFixed(0)}MB / ${(memBefore.heapTotal/1024/1024).toFixed(0)}MB, rss=${(memBefore.rss/1024/1024).toFixed(0)}MB`);
    const t0Load = Date.now();
    const symData = await loadAllDataForSymbol({
      startDate,
      endDate,
      symbol: sym,
    });
    console.log(`  ${sym.toUpperCase()}: ${symData.rtdsTicks.length} rtds, ${symData.clobSnapshots.length} clob, ${symData.exchangeTicks.length} exchange [${((Date.now() - t0Load) / 1000).toFixed(1)}s]`);

    // Run ALL strategies on this symbol
    for (const strategy of strategies) {
      if (!allTradesByStrategy[strategy.name]) allTradesByStrategy[strategy.name] = {};

      const t0 = Date.now();
      process.stdout.write(`  ${strategy.name} x ${sym.toUpperCase()} (${windows.length} windows)...`);

      try {
        const result = await runParallelBacktest({
          windows,
          allData: symData,
          config: {
            strategy,
            strategyConfig: strategy.defaults || {},
            initialCapital: 10000,
            spreadBuffer: 0.005,
            tradingFee: 0,
            concurrency: CONCURRENCY,
          },
        });

        const metrics = calculateMetrics(result);
        const bm = calculateBinaryMetrics(result.trades);
        const sec = ((Date.now() - t0) / 1000).toFixed(1);

        allTradesByStrategy[strategy.name][sym.toUpperCase()] = result.trades;

        const row = {
          strategy: strategy.name,
          symbol: sym.toUpperCase(),
          windows: windows.length,
          trades: result.summary.totalTrades,
          winRate: round(result.summary.winRate * 100, 1),
          totalPnl: round(result.summary.totalPnl, 2),
          sharpe: round(metrics.sharpeRatio, 2),
          pf: round(metrics.profitFactor, 2),
          avgEntry: round(bm.avgEntryPrice, 4),
          dollarPnl: round(bm.dollarPnlPerTrade, 4),
          avgCost: round(bm.avgCostPerTrade, 4),
          roc: round(bm.returnOnCapitalPerTrade * 100, 2),
          avgTokens: round(bm.avgTokensPerTrade, 2),
        };
        results.push(row);
        console.log(` ${row.trades} trades, ${row.winRate}% WR, $${row.totalPnl} PnL, $${row.dollarPnl}/trade, ${row.roc}% ROC [${sec}s]`);

        // Persist trades to DB
        if (runId && result.trades.length > 0) {
          try {
            await persistTrades(runId, strategy.name, strategy.description, sym.toUpperCase(), result.trades, windows);
            completedPairs++;
            await updateRunProgress(runId, completedPairs, totalPairs);
          } catch (dbErr) {
            console.warn(`  DB persist warning: ${dbErr.message}`);
          }
        }
      } catch (err) {
        console.log(` ERROR: ${err.message}`);
        results.push({ strategy: strategy.name, symbol: sym.toUpperCase(), error: err.message });
        completedPairs++;
      }
    }

    // Free ALL symbol data before loading next symbol
    symData.rtdsTicks = null;
    symData.clobSnapshots = null;
    symData.exchangeTicks = null;
    if (global.gc) global.gc();
    const memAfter = process.memoryUsage();
    console.log(`  Memory: heap=${(memAfter.heapUsed/1024/1024).toFixed(0)}MB / ${(memAfter.heapTotal/1024/1024).toFixed(0)}MB, rss=${(memAfter.rss/1024/1024).toFixed(0)}MB`);
  }

  const totalSec = ((Date.now() - t0Global) / 1000).toFixed(0);

  // ─── Complete the backtest run in DB ───
  if (runId) {
    try {
      const totalTrades = results.reduce((s, r) => s + (r.trades || 0), 0);
      const totalPnl = results.reduce((s, r) => s + (r.totalPnl || 0), 0);
      const successResults = results.filter(r => !r.error);
      const bestStrategy = successResults.length > 0
        ? successResults.reduce((best, r) => (r.totalPnl || 0) > (best.totalPnl || 0) ? r : best, successResults[0])
        : null;
      const worstStrategy = successResults.length > 0
        ? successResults.reduce((worst, r) => (r.totalPnl || 0) < (worst.totalPnl || 0) ? r : worst, successResults[0])
        : null;

      await completeRun(runId, {
        totalTrades,
        totalPnl: round(totalPnl, 2),
        totalPairs: completedPairs,
        durationSec: parseInt(totalSec),
        bestStrategy: bestStrategy ? `${bestStrategy.strategy} x ${bestStrategy.symbol} ($${bestStrategy.totalPnl})` : null,
        worstStrategy: worstStrategy ? `${worstStrategy.strategy} x ${worstStrategy.symbol} ($${worstStrategy.totalPnl})` : null,
        results,
      });
      console.log(`\nBacktest run ${runId} completed. ${totalTrades} trades persisted.`);
    } catch (dbErr) {
      console.warn(`Warning: Could not update backtest_runs: ${dbErr.message}`);
    }
  }

  // ─── SUMMARY TABLE ───
  console.log('\n\n' + '='.repeat(150));
  console.log(`STRATEGY COMPARISON ($2/trade capital-based sizing) — completed in ${totalSec}s`);
  console.log('='.repeat(150));
  console.log(
    'Strategy'.padEnd(28) + ' | ' +
    'Sym'.padEnd(5) + ' | ' +
    'Trades'.padStart(7) + ' | ' +
    'WR%'.padStart(6) + ' | ' +
    'TotalPnL$'.padStart(11) + ' | ' +
    '$/Trade'.padStart(9) + ' | ' +
    'ROC%'.padStart(8) + ' | ' +
    'Sharpe'.padStart(7) + ' | ' +
    'AvgEntry'.padStart(9) + ' | ' +
    'Tkns'.padStart(6) + ' | ' +
    'PF'.padStart(6)
  );
  console.log('-'.repeat(150));

  // Group by symbol for cleaner output
  for (const sym of SYMBOLS) {
    const symResults = results.filter(r => r.symbol === sym.toUpperCase());
    for (const r of symResults) {
      if (r.error) {
        console.log(`${r.strategy.padEnd(28)} | ${r.symbol.padEnd(5)} | ERROR: ${r.error}`);
        continue;
      }
      console.log(
        r.strategy.padEnd(28) + ' | ' +
        r.symbol.padEnd(5) + ' | ' +
        String(r.trades).padStart(7) + ' | ' +
        (r.winRate + '%').padStart(6) + ' | ' +
        ('$' + r.totalPnl).padStart(11) + ' | ' +
        ('$' + r.dollarPnl).padStart(9) + ' | ' +
        (r.roc + '%').padStart(8) + ' | ' +
        String(r.sharpe).padStart(7) + ' | ' +
        String(r.avgEntry).padStart(9) + ' | ' +
        String(r.avgTokens).padStart(6) + ' | ' +
        String(r.pf).padStart(6)
      );
    }
    console.log('-'.repeat(150));
  }

  // ─── CHEAP ENTRY ANALYSIS PER STRATEGY ───
  console.log('\n' + '='.repeat(130));
  console.log('CHEAP ENTRY ANALYSIS — Trades by entry price bucket ($2 capital per trade)');
  console.log('At $0.08 entry: $2 buys 25 tokens, win pays $25 = $23 profit (1150% ROC)');
  console.log('At $0.15 entry: $2 buys 13.3 tokens, win pays $13.33 = $11.33 profit (567% ROC)');
  console.log('='.repeat(130));

  for (const strategy of strategies) {
    const stratTrades = allTradesByStrategy[strategy.name];
    if (!stratTrades) continue;

    console.log(`\n--- ${strategy.name} ---`);

    for (const sym of SYMBOLS) {
      const trades = stratTrades[sym.toUpperCase()];
      if (!trades || trades.length === 0) {
        console.log(`  ${sym.toUpperCase()}: no trades`);
        continue;
      }

      const buckets = analyzeCheapEntries(trades);

      console.log(`  ${sym.toUpperCase()} (${trades.length} total trades):`);
      console.log('    ' +
        'Entry Bucket'.padEnd(14) + ' | ' +
        'Count'.padStart(6) + ' | ' +
        'Wins'.padStart(6) + ' | ' +
        'WR%'.padStart(6) + ' | ' +
        'TotalPnL$'.padStart(11) + ' | ' +
        'AvgROC%'.padStart(9) + ' | ' +
        'AvgTkns'.padStart(8) + ' | ' +
        'AvgEntry'.padStart(9)
      );
      console.log('    ' + '-'.repeat(95));

      for (const b of buckets) {
        if (b.count === 0) continue;
        const flag = b.bucket.startsWith('<') && b.winRate > 60 ? ' <<< HIGH VALUE' : '';
        console.log('    ' +
          b.bucket.padEnd(14) + ' | ' +
          String(b.count).padStart(6) + ' | ' +
          String(b.wins).padStart(6) + ' | ' +
          (b.winRate + '%').padStart(6) + ' | ' +
          ('$' + b.totalPnl).padStart(11) + ' | ' +
          (b.avgROC + '%').padStart(9) + ' | ' +
          String(b.avgTokens).padStart(8) + ' | ' +
          ('$' + b.avgEntry).padStart(9) +
          flag
        );
      }
    }
  }

  // ─── TOP CHEAP TRADES ───
  console.log('\n\n' + '='.repeat(130));
  console.log('TOP 30 MOST PROFITABLE CHEAP ENTRY TRADES (entry < $0.20)');
  console.log('"Slow market maker" opportunities — CLOB still mispriced while exchange data signals direction');
  console.log('='.repeat(130));

  const allCheapTrades = [];
  for (const strategy of strategies) {
    const stratTrades = allTradesByStrategy[strategy.name];
    if (!stratTrades) continue;
    for (const sym of SYMBOLS) {
      const trades = stratTrades[sym.toUpperCase()];
      if (!trades) continue;
      for (const t of trades) {
        if (t.entryPrice < 0.20) {
          allCheapTrades.push({ ...t, strategy: strategy.name, symbol: sym.toUpperCase() });
        }
      }
    }
  }

  allCheapTrades.sort((a, b) => b.pnl - a.pnl);

  console.log(
    'Strategy'.padEnd(28) + ' | ' +
    'Sym'.padEnd(5) + ' | ' +
    'Entry$'.padStart(8) + ' | ' +
    'Tokens'.padStart(7) + ' | ' +
    'Cost$'.padStart(7) + ' | ' +
    'PnL$'.padStart(9) + ' | ' +
    'ROC%'.padStart(8) + ' | ' +
    'Won?'.padStart(5) + ' | ' +
    'Reason'
  );
  console.log('-'.repeat(130));

  for (let i = 0; i < Math.min(allCheapTrades.length, 30); i++) {
    const t = allCheapTrades[i];
    const roc = t.cost > 0 ? round(t.pnl / t.cost * 100, 0) : 0;
    console.log(
      t.strategy.padEnd(28) + ' | ' +
      t.symbol.padEnd(5) + ' | ' +
      ('$' + round(t.entryPrice, 4)).padStart(8) + ' | ' +
      round(t.size, 1).toString().padStart(7) + ' | ' +
      ('$' + round(t.cost, 2)).padStart(7) + ' | ' +
      ('$' + round(t.pnl, 2)).padStart(9) + ' | ' +
      (roc + '%').padStart(8) + ' | ' +
      (t.pnl > 0 ? 'WIN' : 'LOSS').padStart(5) + ' | ' +
      (t.reason || '').slice(0, 45)
    );
  }

  // Worst cheap losses
  if (allCheapTrades.length > 0) {
    console.log('\nWORST 10 CHEAP ENTRY LOSSES (entry < $0.20):');
    console.log('-'.repeat(130));
    const worstCheap = [...allCheapTrades].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
    for (const t of worstCheap) {
      if (t.pnl >= 0) continue;
      const roc = t.cost > 0 ? round(t.pnl / t.cost * 100, 0) : 0;
      console.log(
        t.strategy.padEnd(28) + ' | ' +
        t.symbol.padEnd(5) + ' | ' +
        ('$' + round(t.entryPrice, 4)).padStart(8) + ' | ' +
        round(t.size, 1).toString().padStart(7) + ' | ' +
        ('$' + round(t.cost, 2)).padStart(7) + ' | ' +
        ('$' + round(t.pnl, 2)).padStart(9) + ' | ' +
        (roc + '%').padStart(8) + ' | ' +
        (t.reason || '').slice(0, 50)
      );
    }
  }

  // ─── CHEAP ENTRY SUMMARY ───
  console.log('\n\n' + '='.repeat(100));
  console.log('CHEAP ENTRY SUMMARY (<$0.20 entry) — sorted by total PnL');
  console.log('='.repeat(100));

  const cheapSummary = [];
  for (const strategy of strategies) {
    const stratTrades = allTradesByStrategy[strategy.name];
    if (!stratTrades) continue;

    for (const sym of SYMBOLS) {
      const trades = stratTrades[sym.toUpperCase()];
      if (!trades) continue;
      const cheap = trades.filter(t => t.entryPrice < 0.20);
      if (cheap.length === 0) continue;
      const wins = cheap.filter(t => t.pnl > 0);
      const totalPnl = cheap.reduce((s, t) => s + t.pnl, 0);
      const avgEntry = cheap.reduce((s, t) => s + t.entryPrice, 0) / cheap.length;
      const avgTokens = cheap.reduce((s, t) => s + t.size, 0) / cheap.length;
      cheapSummary.push({
        label: `${strategy.name} x ${sym.toUpperCase()}`,
        count: cheap.length,
        wins: wins.length,
        wr: round(wins.length / cheap.length * 100, 1),
        pnl: round(totalPnl, 2),
        avgEntry: round(avgEntry, 4),
        avgTokens: round(avgTokens, 1),
      });
    }
  }

  cheapSummary.sort((a, b) => b.pnl - a.pnl);
  for (const s of cheapSummary) {
    console.log(
      `${s.label.padEnd(40)} ${String(s.count).padStart(5)} trades, ` +
      `${(s.wr + '%').padStart(6)} WR, ` +
      `$${String(s.pnl).padStart(8)} PnL, ` +
      `avg $${s.avgEntry} entry, ` +
      `${s.avgTokens} tokens/trade`
    );
  }

  // Save JSON
  if (OUTPUT_PATH) {
    mkdirSync(resolve(process.cwd(), 'results'), { recursive: true });
    const jsonOut = { results, cheapSummary, allCheapTrades: allCheapTrades.slice(0, 100) };
    writeFileSync(resolve(process.cwd(), OUTPUT_PATH), JSON.stringify(jsonOut, null, 2));
    console.log(`\nJSON: ${OUTPUT_PATH}`);
  }

  console.log(`\nDone in ${totalSec}s.`);
  await persistence.shutdown().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err.message);
  console.error(err.stack);
  // Try to mark run as failed if we have a runId
  try {
    const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    const match = envContent.match(/^DATABASE_URL=(.+)$/m);
    if (match) process.env.DATABASE_URL = match[1];
  } catch { /* ignore */ }
  process.exit(1);
});
