/**
 * Backtest Worker Thread
 *
 * Loads timelines from cache SQLite (read-only, no contention).
 * Main thread sends only window metadata, not full timelines.
 *
 * Protocol:
 *   Main → Worker: { type: 'batch', windows: [win, ...] }
 *   Main → Worker: { type: 'done' }
 *   Worker → Main: { type: 'results', results: { [stratName]: windowResult[] } }
 */

import { workerData, parentPort } from 'worker_threads';
import { resolve, basename } from 'path';
import { readdirSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import { createRequire } from 'module';
import { gunzipSync } from 'zlib';
import { evaluateWindow } from '../src/backtest/parallel-engine.js';

const {
  strategyFilter,
  initialCapital,
  spreadBuffer,
  tradingFee,
  windowDurationMs,
  workerId,
  cachePath,
} = workerData;

// ─── Cache Reader ───

let cacheDb = null;

function getCacheDb() {
  if (cacheDb) return cacheDb;
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  cacheDb = new Database(cachePath, { readonly: true });
  cacheDb.pragma('journal_mode = WAL');
  cacheDb.pragma('cache_size = -32000'); // 32MB per worker
  return cacheDb;
}

function loadCachedTimeline(win) {
  const ct = typeof win.window_close_time === 'string'
    ? win.window_close_time
    : win.window_close_time.toISOString();
  const key = `${(win.symbol || 'btc').toLowerCase()}:${ct}`;
  const row = getCacheDb().prepare('SELECT timeline FROM timeline_cache WHERE window_key = ?').get(key);
  if (!row) return null;
  return JSON.parse(gunzipSync(row.timeline).toString());
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
    if (strategyFilter && !matchesStrategyFilter(name, strategyFilter)) continue;
    try {
      const mod = await import(pathToFileURL(resolve(dir, file)).href);
      if (typeof mod.evaluate !== 'function') continue;
      strategies.push({
        name: mod.name || name,
        evaluate: mod.evaluate,
        onWindowOpen: mod.onWindowOpen || null,
        onWindowClose: mod.onWindowClose || null,
        defaults: mod.defaults || {},
        usesPassiveOrders: mod.usesPassiveOrders || false,
        onPassiveFill: mod.onPassiveFill || null,
      });
    } catch (err) {
      // Skip broken strategies
    }
  }

  return strategies;
}

// ─── Main Worker Logic ───

async function run() {
  const strategies = await discoverStrategies();

  if (strategies.length === 0) {
    parentPort.postMessage({ type: 'ready', workerId, strategyCount: 0 });
    return;
  }

  // Signal ready
  parentPort.postMessage({ type: 'ready', workerId, strategyCount: strategies.length });

  // Process messages from main thread
  parentPort.on('message', (msg) => {
    if (msg.type === 'batch') {
      const results = {};
      for (const strategy of strategies) {
        results[strategy.name] = [];
      }

      for (const item of msg.windows) {
        // Handle both formats: just window metadata or {win, timeline}
        const win = item.win || item;
        const timeline = item.timeline || loadCachedTimeline(win);

        // Reconstruct Date objects
        if (typeof win.window_close_time === 'string') {
          win.window_close_time = new Date(win.window_close_time);
        }

        if (!timeline) continue;

        for (const strategy of strategies) {
          const result = evaluateWindow({
            window: win,
            timeline,
            strategy,
            strategyConfig: strategy.defaults || {},
            initialCapital,
            spreadBuffer,
            tradingFee,
            windowDurationMs,
          });

          results[strategy.name].push(result);
        }
      }

      parentPort.postMessage({
        type: 'results',
        workerId,
        results,
        windowCount: msg.windows.length,
      });
    } else if (msg.type === 'done') {
      if (cacheDb) cacheDb.close();
      process.exit(0);
    }
  });
}

run().catch(err => {
  parentPort.postMessage({ type: 'error', workerId, error: err.message });
});
