#!/usr/bin/env node

/**
 * Fast Backtest Runner — Pipeline Parallel
 *
 * Architecture:
 *   1. Main thread loads data per-window from SQLite (sequential IO)
 *   2. Builds timelines and batches them
 *   3. Dispatches batches to worker threads (round-robin)
 *   4. Workers evaluate strategies in parallel (CPU-bound)
 *   5. Main thread collects and aggregates results
 *
 * This pipelines IO (main thread) and compute (workers) for best throughput.
 *
 * Usage:
 *   node scripts/run-backtest-fast.mjs
 *   node scripts/run-backtest-fast.mjs --strategy=edge-c-asymmetry
 *   node scripts/run-backtest-fast.mjs --symbol=btc --limit=50
 *   node scripts/run-backtest-fast.mjs --workers=4
 *   node scripts/run-backtest-fast.mjs --sequential
 */

import { readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { cpus } from 'os';
import { Worker } from 'worker_threads';
import { createRequire } from 'module';
import { gzipSync, gunzipSync } from 'zlib';
import {
  loadWindowTickData,
  loadWindowsWithGroundTruth,
  getTickDateRange,
  close as closeSqlite,
} from '../src/backtest/data-loader-sqlite.js';
import { precomputeTimestamps } from '../src/backtest/fast-engine.js';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';
import { calculateMetrics, calculateBinaryMetrics } from '../src/backtest/metrics.js';

// ─── CLI Args ───

const STRATEGY_FILTER = process.argv.find(a => a.startsWith('--strategy='))?.split('=')[1] || null;
const SYMBOL_FILTER = process.argv.find(a => a.startsWith('--symbol='))?.split('=')[1]?.toLowerCase() || null;
const WINDOW_LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const OUTPUT_PATH = process.argv.find(a => a.startsWith('--output='))?.split('=')[1] || null;
const SEQUENTIAL = process.argv.includes('--sequential');
const NUM_WORKERS = parseInt(
  process.argv.find(a => a.startsWith('--workers='))?.split('=')[1] || String(Math.min(cpus().length, 8)),
  10
);
const SYMBOLS = ['btc', 'eth', 'sol', 'xrp'];
const WINDOW_DURATION_MS = 15 * 60 * 1000;
const INITIAL_CAPITAL = 10000;
const SPREAD_BUFFER = 0.005;
const TRADING_FEE = 0;
const BATCH_SIZE = 30; // windows per batch to workers
const NO_CACHE = process.argv.includes('--no-cache');
const REBUILD_CACHE = process.argv.includes('--rebuild-cache');
const CACHE_PATH = resolve(process.cwd(), 'data', 'timeline-cache.sqlite');

// ─── Timeline Cache ───

let cacheDb = null;

function getCacheDb() {
  if (cacheDb) return cacheDb;
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  cacheDb = new Database(CACHE_PATH);
  cacheDb.pragma('journal_mode = WAL');
  cacheDb.pragma('cache_size = -64000'); // 64MB
  cacheDb.exec(`CREATE TABLE IF NOT EXISTS timeline_cache (
    window_key TEXT PRIMARY KEY,
    timeline BLOB NOT NULL
  )`);
  return cacheDb;
}

function closeCacheDb() {
  if (cacheDb) { cacheDb.close(); cacheDb = null; }
}

function windowCacheKey(win) {
  const ct = win.window_close_time instanceof Date
    ? win.window_close_time.toISOString()
    : win.window_close_time;
  return `${(win.symbol || 'btc').toLowerCase()}:${ct}`;
}

function getCachedTimeline(win) {
  if (NO_CACHE) return null;
  const db = getCacheDb();
  const row = db.prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?').get(windowCacheKey(win));
  if (!row) return null;
  return JSON.parse(gunzipSync(row.timeline).toString());
}

function setCachedTimeline(win, timeline) {
  if (NO_CACHE) return;
  const db = getCacheDb();
  const blob = gzipSync(JSON.stringify(timeline));
  db.prepare('INSERT OR REPLACE INTO timeline_cache (window_key, timeline) VALUES (?, ?)').run(windowCacheKey(win), blob);
}

function getCacheStats() {
  if (NO_CACHE) return { total: 0 };
  const db = getCacheDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM timeline_cache').get();
  return { total: row.c };
}

// ─── Helpers ───

function round(v, d) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.round(v * 10 ** d) / 10 ** d;
}

// ─── Source Tagging ───

function tagSources(data) {
  for (const tick of data.rtdsTicks) {
    const topic = tick.topic;
    if (topic === 'crypto_prices_chainlink') tick.source = 'chainlink';
    else if (topic === 'crypto_prices') tick.source = 'polyRef';
    else tick.source = `rtds_${topic}`;
  }
  for (const snap of data.clobSnapshots) {
    snap.source = snap.symbol?.toLowerCase().includes('down') ? 'clobDown' : 'clobUp';
  }
  for (const tick of data.exchangeTicks) {
    tick.source = `exchange_${tick.exchange}`;
  }
  if (data.coingeckoTicks) {
    for (const tick of data.coingeckoTicks) {
      tick.source = 'coingecko';
    }
  }
  if (data.l2BookTicks) {
    for (const tick of data.l2BookTicks) {
      tick.source = tick.direction === 'down' ? 'l2Down' : 'l2Up';
    }
  }
}

// ─── N-way merge by _ms ───

function mergeTimeline(rtds, clob, exchange, coingecko, l2) {
  // Merge all arrays by _ms using a simple approach:
  // First merge rtds+clob, then merge that with exchange, then with coingecko, then l2
  let merged = merge2(rtds, clob);
  merged = merge2(merged, exchange);
  if (coingecko && coingecko.length > 0) {
    merged = merge2(merged, coingecko);
  }
  if (l2 && l2.length > 0) {
    merged = merge2(merged, l2);
  }
  return merged;
}

function merge2(a, b) {
  const total = a.length + b.length;
  const result = new Array(total);
  let i = 0, j = 0, out = 0;
  while (i < a.length && j < b.length) {
    if (a[i]._ms <= b[j]._ms) result[out++] = a[i++];
    else result[out++] = b[j++];
  }
  while (i < a.length) result[out++] = a[i++];
  while (j < b.length) result[out++] = b[j++];
  return result;
}

// ─── Results Aggregation ───

function aggregateResults(windowResults, meta) {
  const { strategy, strategyConfig, initialCapital, elapsedMs, windowCount } = meta;

  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalEventsProcessed = 0;
  const allTrades = [];
  const perWindowSummaries = [];

  const sorted = [...windowResults].sort((a, b) =>
    new Date(a.windowCloseTime).getTime() - new Date(b.windowCloseTime).getTime()
  );

  let runningCapital = initialCapital;
  const equityCurve = [initialCapital];
  let peakCapital = initialCapital;
  let maxDrawdown = 0;

  for (const wr of sorted) {
    totalPnl += wr.pnl;
    totalTrades += wr.tradesInWindow;
    totalEventsProcessed += wr.eventsProcessed;

    for (const t of wr.trades) {
      allTrades.push(t);
      if (t.pnl > 0) totalWins++;
    }

    perWindowSummaries.push({
      windowCloseTime: wr.windowCloseTime,
      symbol: wr.symbol,
      strike: wr.strike,
      chainlinkClose: wr.chainlinkClose,
      resolvedDirection: wr.resolvedDirection,
      pnl: wr.pnl,
      tradesInWindow: wr.tradesInWindow,
    });

    runningCapital += wr.pnl;
    equityCurve.push(runningCapital);
    if (runningCapital > peakCapital) peakCapital = runningCapital;
    if (peakCapital > 0) {
      const dd = (peakCapital - runningCapital) / peakCapital;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const returnPct = initialCapital > 0 ? totalPnl / initialCapital : 0;

  const winTrades = allTrades.filter(t => t.pnl > 0);
  const lossTrades = allTrades.filter(t => t.pnl <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length : 0;

  return {
    config: {
      strategyName: strategy.name || strategy,
      strategyConfig,
      initialCapital,
      startDate: sorted.length > 0 ? sorted[0].windowCloseTime : null,
      endDate: sorted.length > 0 ? sorted[sorted.length - 1].windowCloseTime : null,
    },
    summary: {
      totalTrades, winRate, totalPnl, returnPct, maxDrawdown,
      finalCapital: runningCapital, avgWin, avgLoss,
      eventsProcessed: totalEventsProcessed,
      windowsProcessed: windowCount,
      elapsedMs,
    },
    trades: allTrades,
    equityCurve,
    windowResults: perWindowSummaries,
  };
}

// ─── Strategy Discovery ───

function matchesStrategyFilter(name, filter) {
  const parts = filter.split(',');
  return parts.some(p => {
    p = p.trim();
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1));
    return name === p;
  });
}

async function discoverStrategies() {
  const dir = resolve(process.cwd(), 'src/backtest/strategies');
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  const strategies = [];

  for (const file of files) {
    const name = basename(file, '.js');
    if (STRATEGY_FILTER && !matchesStrategyFilter(name, STRATEGY_FILTER)) continue;
    try {
      const mod = await import(pathToFileURL(resolve(dir, file)).href);
      if (typeof mod.evaluate !== 'function') continue;
      strategies.push({
        name: mod.name || name,
        description: mod.description || '',
        evaluate: mod.evaluate,
        onWindowOpen: mod.onWindowOpen || null,
        onWindowClose: mod.onWindowClose || null,
        defaults: mod.defaults || {},
        usesPassiveOrders: mod.usesPassiveOrders || false,
        onPassiveFill: mod.onPassiveFill || null,
      });
    } catch (err) {
      console.error(`  Skipping ${file}: ${err.message}`);
    }
  }

  return strategies;
}

// ─── Pipeline Parallel Mode ───

async function runPipelineParallel(bySymbol, strategies) {
  const workerPath = resolve(fileURLToPath(import.meta.url), '..', 'backtest-worker.mjs');
  const totalWindows = Object.values(bySymbol).reduce((s, w) => s + w.length, 0);
  const numWorkers = Math.min(NUM_WORKERS, totalWindows);

  console.log(`\nSpawning ${numWorkers} worker threads...`);

  // Spawn workers
  const workers = [];
  const workerReady = [];

  for (let i = 0; i < numWorkers; i++) {
    const worker = new Worker(workerPath, {
      workerData: {
        strategyFilter: STRATEGY_FILTER,
        initialCapital: INITIAL_CAPITAL,
        spreadBuffer: SPREAD_BUFFER,
        tradingFee: TRADING_FEE,
        windowDurationMs: WINDOW_DURATION_MS,
        workerId: i,
        cachePath: CACHE_PATH,
      },
    });
    workers.push(worker);
    workerReady.push(new Promise((res, rej) => {
      worker.on('message', function onReady(msg) {
        if (msg.type === 'ready') {
          worker.removeListener('message', onReady);
          res(msg);
        }
      });
      worker.on('error', rej);
    }));
  }

  await Promise.all(workerReady);
  console.log(`  All ${numWorkers} workers ready\n`);

  // Track pending batches per worker
  const pendingPerWorker = new Array(numWorkers).fill(0);
  const resultCollectors = workers.map(() => []);
  let completedWindows = 0;

  // Set up result listeners
  const workerDonePromises = workers.map((worker, idx) => {
    return new Promise((res, rej) => {
      worker.on('message', (msg) => {
        if (msg.type === 'results') {
          // Merge into collector
          for (const [stratName, windowResults] of Object.entries(msg.results)) {
            resultCollectors[idx].push({ stratName, windowResults });
          }
          completedWindows += msg.windowCount;
          pendingPerWorker[idx]--;
        } else if (msg.type === 'error') {
          rej(new Error(`Worker ${msg.workerId}: ${msg.error}`));
        }
      });
      // Resolved when we signal done and get the final results
      worker._resolve = res;
      worker.on('error', rej);
    });
  });

  // Check if cache exists for all windows
  const cacheStats = getCacheStats();
  const totalWindowsNeeded = Object.values(bySymbol).reduce((s, w) => s + w.length, 0);
  const useWorkerCache = cacheStats.total >= totalWindowsNeeded && !NO_CACHE;

  let totalLoadMs = 0;
  let cacheHits = 0;
  let currentBatch = [];
  let nextWorker = 0;

  function dispatchBatch() {
    if (currentBatch.length === 0) return;
    const workerIdx = nextWorker;
    nextWorker = (nextWorker + 1) % numWorkers;
    pendingPerWorker[workerIdx]++;
    workers[workerIdx].postMessage({ type: 'batch', windows: currentBatch });
    currentBatch = [];
  }

  for (const sym of Object.keys(bySymbol)) {
    const windows = bySymbol[sym];
    console.log(`  ${useWorkerCache ? 'Dispatching' : 'Loading'} ${sym.toUpperCase()} (${windows.length} windows)...`);

    for (let wi = 0; wi < windows.length; wi++) {
      const win = windows[wi];

      const serializedWin = {
        ...win,
        window_close_time: win.window_close_time instanceof Date
          ? win.window_close_time.toISOString()
          : win.window_close_time,
      };

      if (useWorkerCache) {
        // Workers load from cache directly — just send window metadata
        currentBatch.push(serializedWin);
        cacheHits++;
      } else {
        // No cache — load timeline in main thread and send to worker
        const tLoad = Date.now();
        const { timeline, fromCache } = await loadTimeline(win);
        totalLoadMs += Date.now() - tLoad;
        if (fromCache) cacheHits++;
        currentBatch.push({ win: serializedWin, timeline });
      }

      if (currentBatch.length >= BATCH_SIZE) {
        dispatchBatch();
      }

      if ((wi + 1) % 50 === 0 || wi === windows.length - 1) {
        const cacheLabel = cacheHits > 0 ? ` [cache: ${cacheHits}]` : '';
        process.stdout.write(`\r    ${sym.toUpperCase()}: ${wi + 1}/${windows.length} dispatched, ${completedWindows} evaluated${cacheLabel}`);
      }
    }
    console.log('');
  }

  // Dispatch remaining
  dispatchBatch();

  // Close SQLite
  closeSqlite();

  // Wait for all workers to finish pending batches
  process.stdout.write('  Waiting for workers to finish...');
  await new Promise(res => {
    const check = setInterval(() => {
      if (pendingPerWorker.every(p => p === 0)) {
        clearInterval(check);
        res();
      }
    }, 100);
  });
  console.log(` done (${completedWindows} windows evaluated)`);

  // Signal workers to exit
  for (const w of workers) {
    w.postMessage({ type: 'done' });
  }

  // Wait for workers to exit
  await Promise.all(workers.map(w => new Promise(res => w.on('exit', res))));

  // Merge all results
  const mergedResults = {};
  for (const collector of resultCollectors) {
    for (const { stratName, windowResults } of collector) {
      if (!mergedResults[stratName]) mergedResults[stratName] = [];
      mergedResults[stratName].push(...windowResults);
    }
  }

  return { mergedResults, totalLoadMs };
}

// ─── Timeline Loading (with cache) ───

async function loadTimeline(win) {
  // Check cache first
  if (!REBUILD_CACHE) {
    const cached = getCachedTimeline(win);
    if (cached) return { timeline: cached, fromCache: true };
  }

  // Load from SQLite
  const windowData = await loadWindowTickData({ window: win, windowDurationMs: WINDOW_DURATION_MS });
  precomputeTimestamps(windowData);
  tagSources(windowData);

  const timeline = mergeTimeline(
    windowData.rtdsTicks,
    windowData.clobSnapshots,
    windowData.exchangeTicks,
    windowData.coingeckoTicks || [],
    windowData.l2BookTicks || []
  );

  // Save to cache
  setCachedTimeline(win, timeline);

  return { timeline, fromCache: false };
}

// ─── Sequential Mode ───

async function runSequential(bySymbol, strategies) {
  const strategyWindowResults = {};
  for (const strategy of strategies) {
    strategyWindowResults[strategy.name] = [];
  }

  let totalLoadMs = 0;
  let totalRunMs = 0;
  let cacheHits = 0;

  for (const sym of Object.keys(bySymbol)) {
    const windows = bySymbol[sym];
    console.log(`\n--- ${sym.toUpperCase()} (${windows.length} windows) ---`);

    let symLoadMs = 0;
    let symRunMs = 0;

    for (let wi = 0; wi < windows.length; wi++) {
      const win = windows[wi];

      const tLoad = Date.now();
      const { timeline, fromCache } = await loadTimeline(win);
      symLoadMs += Date.now() - tLoad;
      if (fromCache) cacheHits++;

      const tRun = Date.now();
      for (const strategy of strategies) {
        const result = evaluateWindow({
          window: win,
          timeline,
          strategy,
          strategyConfig: strategy.defaults || {},
          initialCapital: INITIAL_CAPITAL,
          spreadBuffer: SPREAD_BUFFER,
          tradingFee: TRADING_FEE,
          windowDurationMs: WINDOW_DURATION_MS,
        });
        strategyWindowResults[strategy.name].push(result);
      }
      symRunMs += Date.now() - tRun;

      if ((wi + 1) % 100 === 0 || wi === windows.length - 1) {
        const pct = ((wi + 1) / windows.length * 100).toFixed(0);
        const cacheLabel = cacheHits > 0 ? ` [cache: ${cacheHits}]` : '';
        process.stdout.write(`\r  ${sym.toUpperCase()}: ${wi + 1}/${windows.length} windows (${pct}%) — load ${(symLoadMs / 1000).toFixed(1)}s, engine ${(symRunMs / 1000).toFixed(1)}s${cacheLabel}`);
      }
    }
    totalLoadMs += symLoadMs;
    totalRunMs += symRunMs;
    console.log('');
  }

  return { mergedResults: strategyWindowResults, totalLoadMs, totalRunMs, cacheHits };
}

// ─── Main ───

async function main() {
  const t0 = Date.now();
  const mode = SEQUENTIAL ? 'sequential' : `${NUM_WORKERS} workers`;
  console.log(`=== Fast Backtest Runner (SQLite, ${mode}) ===\n`);

  const strategies = await discoverStrategies();
  if (strategies.length === 0) {
    console.error('No strategies found.');
    process.exit(1);
  }
  console.log(`Strategies: ${strategies.map(s => s.name).join(', ')}`);

  const dateRange = await getTickDateRange();
  if (!dateRange.earliest || !dateRange.latest) {
    console.error('No tick data found in SQLite.');
    process.exit(1);
  }
  console.log(`Data range: ${String(dateRange.earliest).slice(0, 19)} to ${String(dateRange.latest).slice(0, 19)}`);

  console.log('\nLoading windows...');
  let allWindows = await loadWindowsWithGroundTruth({
    startDate: dateRange.earliest,
    endDate: dateRange.latest,
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
    if (symWindows.length > 0) bySymbol[sym] = symWindows;
  }

  const totalWindows = Object.values(bySymbol).reduce((s, w) => s + w.length, 0);
  console.log(`Total: ${totalWindows} windows${WINDOW_LIMIT ? ` (limit ${WINDOW_LIMIT}/sym)` : ''}`);
  for (const [sym, wins] of Object.entries(bySymbol)) {
    console.log(`  ${sym.toUpperCase()}: ${wins.length}`);
  }

  let mergedResults, totalLoadMs, totalRunMs;

  if (SEQUENTIAL) {
    ({ mergedResults, totalLoadMs, totalRunMs } = await runSequential(bySymbol, strategies));
  } else {
    const result = await runPipelineParallel(bySymbol, strategies);
    mergedResults = result.mergedResults;
    totalLoadMs = result.totalLoadMs;
    totalRunMs = 0; // eval time is baked into wall time for pipeline
  }

  closeSqlite();
  const totalMs = Date.now() - t0;

  // ─── Build Results Table ───

  const allTableRows = [];

  for (const strategy of strategies) {
    const allResults = mergedResults[strategy.name] || [];
    if (allResults.length === 0) continue;

    const resultsBySymbol = {};
    for (const r of allResults) {
      const sym = (r.symbol || 'unknown').toLowerCase();
      if (!resultsBySymbol[sym]) resultsBySymbol[sym] = [];
      resultsBySymbol[sym].push(r);
    }

    for (const sym of Object.keys(resultsBySymbol)) {
      const symResults = resultsBySymbol[sym];
      const result = aggregateResults(symResults, {
        strategy,
        strategyConfig: strategy.defaults || {},
        initialCapital: INITIAL_CAPITAL,
        elapsedMs: totalMs,
        windowCount: symResults.length,
      });

      const metrics = calculateMetrics(result);
      const bm = calculateBinaryMetrics(result.trades);

      allTableRows.push({
        strategy: strategy.name,
        symbol: sym.toUpperCase(),
        trades: result.summary.totalTrades,
        winRate: round(result.summary.winRate * 100, 1),
        totalPnl: round(result.summary.totalPnl, 2),
        sharpe: round(metrics.sharpeRatio, 2),
        avgEntry: round(bm.avgEntryPrice, 4),
        dollarPnl: round(bm.dollarPnlPerTrade, 4),
        roc: round(bm.returnOnCapitalPerTrade * 100, 2),
        pf: round(metrics.profitFactor, 2),
      });
    }
  }

  // ─── Summary Table ───

  console.log('\n' + '='.repeat(130));
  console.log(`STRATEGY RESULTS  (${mode}, ${(totalMs / 1000).toFixed(1)}s total)`);
  console.log('='.repeat(130));
  console.log(
    'Strategy'.padEnd(30) + ' | ' +
    'Symbol'.padEnd(6) + ' | ' +
    'Trades'.padStart(7) + ' | ' +
    'WR%'.padStart(7) + ' | ' +
    'TotalPnL$'.padStart(11) + ' | ' +
    'Sharpe'.padStart(7) + ' | ' +
    'AvgEntry'.padStart(9) + ' | ' +
    '$/Trade'.padStart(9) + ' | ' +
    'ROC%'.padStart(8) + ' | ' +
    'PF'.padStart(6)
  );
  console.log('-'.repeat(130));

  for (const strategy of strategies) {
    const rows = allTableRows.filter(r => r.strategy === strategy.name);
    for (const r of rows) {
      console.log(formatRow(r));
    }

    if (rows.length > 1) {
      const totTrades = rows.reduce((s, r) => s + r.trades, 0);
      const totPnl = rows.reduce((s, r) => s + r.totalPnl, 0);
      const totWins = rows.reduce((s, r) => s + Math.round(r.trades * r.winRate / 100), 0);
      console.log(
        `  TOTAL`.padEnd(30) + ' | ' +
        'ALL'.padEnd(6) + ' | ' +
        String(totTrades).padStart(7) + ' | ' +
        (totTrades > 0 ? round(totWins / totTrades * 100, 1) + '%' : '0%').padStart(7) + ' | ' +
        ('$' + round(totPnl, 2)).padStart(11) + ' | ' +
        ''.padStart(7) + ' | ' +
        ''.padStart(9) + ' | ' +
        (totTrades > 0 ? '$' + round(totPnl / totTrades, 4) : '$0').padStart(9) + ' | ' +
        ''.padStart(8) + ' | ' +
        ''.padStart(6)
      );
    }
    console.log('-'.repeat(130));
  }

  // ─── Throughput Stats ───

  console.log(`\nPerformance:`);
  if (!SEQUENTIAL) {
    console.log(`  Workers:    ${NUM_WORKERS}`);
  }
  if (!NO_CACHE) {
    const cs = getCacheStats();
    console.log(`  Cache:      ${cs.total} timelines cached (${CACHE_PATH})`);
  }
  console.log(`  Data load:  ${(totalLoadMs / 1000).toFixed(1)}s`);
  console.log(`  Wall time:  ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Throughput: ${(totalWindows / (totalMs / 1000)).toFixed(0)} windows/sec (${strategies.length} strategies)`);

  if (OUTPUT_PATH) {
    const outDir = resolve(process.cwd(), OUTPUT_PATH, '..');
    mkdirSync(outDir, { recursive: true });
    const jsonOut = {
      meta: { totalMs, totalLoadMs, windowCount: totalWindows, strategyCount: strategies.length, workers: SEQUENTIAL ? 1 : NUM_WORKERS },
      table: allTableRows,
    };
    writeFileSync(resolve(process.cwd(), OUTPUT_PATH), JSON.stringify(jsonOut, null, 2));
    console.log(`\nJSON saved: ${OUTPUT_PATH}`);
  }

  closeCacheDb();
  console.log('\nDone.');
}

function formatRow(r) {
  return (
    r.strategy.padEnd(30) + ' | ' +
    r.symbol.padEnd(6) + ' | ' +
    String(r.trades).padStart(7) + ' | ' +
    (r.winRate + '%').padStart(7) + ' | ' +
    ('$' + r.totalPnl).padStart(11) + ' | ' +
    String(r.sharpe).padStart(7) + ' | ' +
    String(r.avgEntry).padStart(9) + ' | ' +
    ('$' + r.dollarPnl).padStart(9) + ' | ' +
    (r.roc + '%').padStart(8) + ' | ' +
    String(r.pf).padStart(6)
  );
}

main().catch(err => {
  console.error('Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
