/**
 * Factory API Module
 *
 * REST endpoints for the Quant Factory dashboard views.
 * Queries factory_runs, factory_results, and strategy_lineage tables.
 *
 * Designed to be called from handleDashboardRequest() in dashboard-api.mjs.
 * All endpoints gracefully handle missing tables (return empty data, not errors).
 *
 * Endpoints:
 *   GET /api/factory/runs                         — paginated run history
 *   GET /api/factory/runs/:id                     — single run detail
 *   GET /api/factory/runs/:id/results             — results for a run
 *   GET /api/factory/leaderboard                  — top strategies by metric
 *   GET /api/factory/strategies/:name/lineage     — mutation history chain
 *   GET /api/factory/strategies/:name/results     — results for a strategy
 *   GET /api/factory/coverage                     — data coverage per symbol
 *   GET /api/factory/compare                      — side-by-side comparison
 *
 * @module scripts/factory-api
 */

import persistence from '../src/persistence/index.js';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'url';
import { runFactoryBacktestPg, runFactoryBacktestPgCache } from '../src/factory/cli/backtest-factory.js';
import { buildTimelines } from '../src/factory/timeline-builder.js';
import { ensurePgTimelineTable, getPgCacheSummary } from '../src/factory/pg-timeline-store.js';
import { readPgTimelines, listPgWindows } from '../src/factory/pg-timeline-cache.js';
import { sampleWindows } from '../src/factory/sampler.js';

/**
 * Handle factory API requests.
 * Returns true if the request was handled, false otherwise.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function handleFactoryRequest(req, res) {
  const fullUrl = req.url || '';
  const url = fullUrl.split('?')[0];

  // Only handle /api/factory/* routes
  if (!url.startsWith('/api/factory')) return false;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // --- POST /api/factory/backtest ---
  if (url === '/api/factory/backtest' && req.method === 'POST') {
    return await handleBacktestRun(req, res);
  }

  // --- POST /api/factory/analyze ---
  if (url === '/api/factory/analyze' && req.method === 'POST') {
    return await handleAnalyze(req, res);
  }

  // --- POST /api/factory/backfill ---
  if (url === '/api/factory/backfill' && req.method === 'POST') {
    return await handleBackfill(req, res);
  }

  // --- GET /api/factory/backfill-status ---
  if (url === '/api/factory/backfill-status' && req.method === 'GET') {
    return await handleBackfillStatus(req, res);
  }

  // --- GET /api/factory/cache-status ---
  if (url === '/api/factory/cache-status' && req.method === 'GET') {
    try {
      await ensurePgTimelineTable();
      const summary = await getPgCacheSummary();
      json(res, 200, { ok: true, data: summary });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (req.method !== 'GET') {
    json(res, 405, { ok: false, error: 'Method not allowed' });
    return true;
  }

  const params = parseQueryParams(fullUrl);

  try {
    // --- GET /api/factory/leaderboard ---
    if (url === '/api/factory/leaderboard') {
      return await handleLeaderboard(res, params);
    }

    // --- GET /api/factory/runs ---
    if (url === '/api/factory/runs') {
      return await handleRunsList(res, params);
    }

    // --- GET /api/factory/coverage ---
    if (url === '/api/factory/coverage') {
      return await handleCoverage(res);
    }

    // --- GET /api/factory/compare ---
    if (url === '/api/factory/compare') {
      return await handleCompare(res, params);
    }

    // --- GET /api/factory/strategies/:name/lineage ---
    const lineageMatch = url.match(/^\/api\/factory\/strategies\/([^/]+)\/lineage$/);
    if (lineageMatch) {
      return await handleStrategyLineage(res, decodeURIComponent(lineageMatch[1]));
    }

    // --- GET /api/factory/strategies/:name/results ---
    const stratResultsMatch = url.match(/^\/api\/factory\/strategies\/([^/]+)\/results$/);
    if (stratResultsMatch) {
      return await handleStrategyResults(res, decodeURIComponent(stratResultsMatch[1]), params);
    }

    // --- GET /api/factory/runs/:id/results ---
    const runResultsMatch = url.match(/^\/api\/factory\/runs\/(\d+)\/results$/);
    if (runResultsMatch) {
      return await handleRunResults(res, parseInt(runResultsMatch[1]), params);
    }

    // --- GET /api/factory/runs/:id ---
    const runDetailMatch = url.match(/^\/api\/factory\/runs\/(\d+)$/);
    if (runDetailMatch) {
      return await handleRunDetail(res, parseInt(runDetailMatch[1]));
    }

    // No matching factory route
    json(res, 404, { ok: false, error: 'Factory endpoint not found' });
    return true;

  } catch (err) {
    // Check if this is a "table does not exist" error
    if (isTableMissingError(err)) {
      json(res, 200, { ok: true, data: emptyDataForUrl(url), meta: { total: 0, tablesMissing: true } });
      return true;
    }
    json(res, 500, { ok: false, error: err.message });
    return true;
  }
}

// =============================================================================
// ENDPOINT HANDLERS
// =============================================================================

/**
 * GET /api/factory/runs — paginated list of factory runs
 */
async function handleRunsList(res, params) {
  const limit = Math.min(parseInt(params.limit) || 50, 200);
  const offset = parseInt(params.offset) || 0;

  const conditions = [];
  const values = [];
  let paramIdx = 1;

  if (params.status) {
    conditions.push(`status = $${paramIdx++}`);
    values.push(params.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countResult, rows] = await Promise.all([
    safeQuery(() => persistence.get(`SELECT COUNT(*) as total FROM factory_runs ${where}`, values)),
    safeQuery(() => persistence.all(
      `SELECT run_id, manifest_name, status, started_at, completed_at,
              wall_clock_ms, total_runs, completed_runs, summary, error_message
       FROM factory_runs ${where}
       ORDER BY started_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      values
    )),
  ]);

  json(res, 200, {
    ok: true,
    data: { runs: rows || [] },
    meta: { total: parseInt(countResult?.total || '0'), limit, offset },
  });
  return true;
}

/**
 * GET /api/factory/runs/:id — single run detail with summary
 */
async function handleRunDetail(res, runId) {
  const row = await safeQuery(() =>
    persistence.get(`SELECT * FROM factory_runs WHERE run_id = $1`, [runId])
  );

  if (!row) {
    json(res, 404, { ok: false, error: 'Run not found' });
    return true;
  }

  json(res, 200, { ok: true, data: { run: row } });
  return true;
}

/**
 * GET /api/factory/runs/:id/results — all results for a run
 */
async function handleRunResults(res, runId, params) {
  const conditions = ['run_id = $1'];
  const values = [runId];
  let paramIdx = 2;

  if (params.symbol) {
    conditions.push(`LOWER(symbol) = $${paramIdx++}`);
    values.push(params.symbol.toLowerCase());
  }

  if (params.minTrades) {
    conditions.push(`(metrics->>'trades')::int >= $${paramIdx++}`);
    values.push(parseInt(params.minTrades));
  }

  const where = conditions.join(' AND ');

  // Sorting by metric fields extracted from JSONB
  const allowedSorts = {
    sharpe: "COALESCE((metrics->>'sharpe')::float, 0)",
    sortino: "COALESCE((metrics->>'sortino')::float, 0)",
    profitFactor: "COALESCE((metrics->>'profitFactor')::float, 0)",
    winRate: "COALESCE((metrics->>'winRate')::float, 0)",
    trades: "COALESCE((metrics->>'trades')::int, 0)",
    maxDrawdown: "COALESCE((metrics->>'maxDrawdown')::float, 0)",
  };
  const sortExpr = allowedSorts[params.sort] || allowedSorts.sharpe;
  const order = params.order === 'asc' ? 'ASC' : 'DESC';

  const rows = await safeQuery(() => persistence.all(
    `SELECT id, run_id, strategy_name, strategy_source, symbol, config,
            sample_size, metrics, elapsed_ms, created_at
     FROM factory_results
     WHERE ${where}
     ORDER BY ${sortExpr} ${order}`,
    values
  ));

  json(res, 200, {
    ok: true,
    data: { results: rows || [] },
    meta: { total: (rows || []).length },
  });
  return true;
}

/**
 * GET /api/factory/leaderboard — top strategies by metric
 */
async function handleLeaderboard(res, params) {
  const limit = Math.min(parseInt(params.limit) || 25, 100);
  const minTrades = parseInt(params.minTrades) || 0;

  const allowedMetrics = {
    sharpe: "COALESCE((metrics->>'sharpe')::float, 0)",
    sortino: "COALESCE((metrics->>'sortino')::float, 0)",
    profitFactor: "COALESCE((metrics->>'profitFactor')::float, 0)",
    winRate: "COALESCE((metrics->>'winRate')::float, 0)",
  };
  const metricExpr = allowedMetrics[params.metric] || allowedMetrics.sharpe;

  // Deduplicate by strategy_name + symbol (best result per strategy per symbol)
  // Use DISTINCT ON to get the best result for each strategy+symbol combo
  const rows = await safeQuery(() => persistence.all(
    `SELECT DISTINCT ON (strategy_name, symbol)
            id, strategy_name, symbol, metrics, run_id, config, sample_size, created_at
     FROM factory_results
     ${minTrades > 0 ? `WHERE (metrics->>'trades')::int >= $1` : ''}
     ORDER BY strategy_name, symbol, ${metricExpr} DESC`,
    minTrades > 0 ? [minTrades] : []
  ));

  // Sort the deduplicated results by the chosen metric
  const results = (rows || [])
    .map(r => {
      const trades = r.metrics?.trades || 0;
      return {
        ...r,
        lowSample: trades < 50,
      };
    })
    .sort((a, b) => {
      const metricKey = params.metric || 'sharpe';
      const aVal = a.metrics?.[metricKey] || 0;
      const bVal = b.metrics?.[metricKey] || 0;
      return bVal - aVal;
    })
    .slice(0, limit);

  json(res, 200, {
    ok: true,
    data: { strategies: results },
    meta: { total: results.length, limit },
  });
  return true;
}

/**
 * GET /api/factory/strategies/:name/lineage — full lineage tree
 */
async function handleStrategyLineage(res, strategyName) {
  // Find the root of the lineage chain by walking up parent_name
  // Then find all descendants. For simplicity, fetch all lineage entries
  // and filter client-side (the table is small).

  const allLineage = await safeQuery(() => persistence.all(
    `SELECT id, strategy_name, parent_name, mutation_type, mutation_reasoning,
            created_at, created_by
     FROM strategy_lineage
     ORDER BY created_at ASC`
  ));

  if (!allLineage || allLineage.length === 0) {
    json(res, 200, {
      ok: true,
      data: { lineage: [] },
      meta: { total: 0 },
    });
    return true;
  }

  // Build the connected component containing the requested strategy
  const byName = new Map();
  for (const entry of allLineage) {
    byName.set(entry.strategy_name, entry);
  }

  // Walk up to find root
  let current = strategyName;
  const visited = new Set();
  while (current && byName.has(current) && !visited.has(current)) {
    visited.add(current);
    const entry = byName.get(current);
    if (!entry.parent_name) break;
    current = entry.parent_name;
  }
  const root = current;

  // BFS from root to find all descendants
  const chain = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = byName.get(name);
    if (entry) {
      chain.push(entry);
      // Find children
      for (const e of allLineage) {
        if (e.parent_name === name && !seen.has(e.strategy_name)) {
          queue.push(e.strategy_name);
        }
      }
    }
  }

  json(res, 200, {
    ok: true,
    data: { lineage: chain },
    meta: { total: chain.length, root },
  });
  return true;
}

/**
 * GET /api/factory/strategies/:name/results — all results for a strategy
 */
async function handleStrategyResults(res, strategyName, params) {
  const conditions = ['strategy_name = $1'];
  const values = [strategyName];
  let paramIdx = 2;

  if (params.symbol) {
    conditions.push(`LOWER(symbol) = $${paramIdx++}`);
    values.push(params.symbol.toLowerCase());
  }

  const where = conditions.join(' AND ');

  const rows = await safeQuery(() => persistence.all(
    `SELECT id, run_id, strategy_name, strategy_source, symbol, config,
            sample_size, metrics, elapsed_ms, created_at
     FROM factory_results
     WHERE ${where}
     ORDER BY created_at DESC`,
    values
  ));

  json(res, 200, {
    ok: true,
    data: { results: rows || [] },
    meta: { total: (rows || []).length },
  });
  return true;
}

/**
 * GET /api/factory/coverage — data coverage per symbol
 */
async function handleCoverage(res) {
  const rows = await safeQuery(() => persistence.all(
    `SELECT
       symbol,
       COUNT(*) as total_results,
       COUNT(DISTINCT strategy_name) as unique_strategies,
       MIN(created_at) as earliest_result,
       MAX(created_at) as latest_result,
       AVG(sample_size) as avg_sample_size
     FROM factory_results
     GROUP BY symbol
     ORDER BY symbol`
  ));

  // Try to get timeline cache metadata if available
  let timelineMeta = null;
  try {
    timelineMeta = await persistence.all(
      `SELECT
         symbol,
         COUNT(*) as total_windows,
         MIN(window_close_time) as earliest_window,
         MAX(window_close_time) as latest_window
       FROM window_close_events
       GROUP BY symbol
       ORDER BY symbol`
    );
  } catch {
    // window_close_events may not exist
  }

  const coverage = (rows || []).map(row => {
    const tlMeta = timelineMeta?.find(t => t.symbol === row.symbol);
    return {
      symbol: row.symbol,
      totalResults: parseInt(row.total_results) || 0,
      uniqueStrategies: parseInt(row.unique_strategies) || 0,
      dateRange: {
        from: row.earliest_result,
        to: row.latest_result,
      },
      avgSampleSize: Math.round(parseFloat(row.avg_sample_size) || 0),
      timeline: tlMeta ? {
        totalWindows: parseInt(tlMeta.total_windows) || 0,
        dateRange: { from: tlMeta.earliest_window, to: tlMeta.latest_window },
      } : null,
    };
  });

  json(res, 200, {
    ok: true,
    data: { coverage },
    meta: { total: coverage.length },
  });
  return true;
}

/**
 * GET /api/factory/compare?ids=1,2,3 — side-by-side comparison
 */
async function handleCompare(res, params) {
  const idsStr = params.ids || '';
  const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

  if (ids.length === 0) {
    json(res, 400, { ok: false, error: 'Missing or invalid ids parameter. Use ?ids=1,2,3' });
    return true;
  }

  if (ids.length > 20) {
    json(res, 400, { ok: false, error: 'Maximum 20 IDs for comparison' });
    return true;
  }

  // Build parameterized query for variable number of IDs
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const rows = await safeQuery(() => persistence.all(
    `SELECT id, run_id, strategy_name, strategy_source, symbol, config,
            sample_size, metrics, elapsed_ms, created_at
     FROM factory_results
     WHERE id IN (${placeholders})
     ORDER BY id`,
    ids
  ));

  // Check for sample size warnings (FR32)
  const warnings = [];
  const comparison = rows || [];
  if (comparison.length >= 2) {
    const sampleSizes = comparison.map(r => r.sample_size || 0).filter(s => s > 0);
    if (sampleSizes.length >= 2) {
      const maxSample = Math.max(...sampleSizes);
      const minSample = Math.min(...sampleSizes);
      if (maxSample > minSample * 2) {
        warnings.push(
          `Sample sizes vary significantly (${minSample} to ${maxSample}) — comparison may be unreliable`
        );
      }
    }
  }

  json(res, 200, {
    ok: true,
    data: { comparison, warnings },
    meta: { total: comparison.length },
  });
  return true;
}

// =============================================================================
// BACKTEST ENDPOINT
// =============================================================================

/**
 * POST /api/factory/backtest — run a backtest against PostgreSQL
 *
 * Body: { strategy, symbol, sample, seed, feeMode }
 *   strategy: strategy name (JS file from src/factory/strategies/ or src/backtest/strategies/)
 *   symbol: e.g. "btc" (default: "btc")
 *   sample: sample size (default: 200)
 *   seed: PRNG seed (default: 42)
 *   feeMode: "taker", "maker", "zero" (default: "taker")
 */
async function handleBacktestRun(req, res) {
  try {
    const body = await readRequestBody(req);
    const params = JSON.parse(body);

    const strategyName = params.strategy;
    if (!strategyName) {
      json(res, 400, { ok: false, error: 'Missing required field: strategy' });
      return true;
    }

    const strategy = await loadStrategyForApi(strategyName);
    const symbol = (params.symbol || 'btc').toLowerCase();
    const sample = parseInt(params.sample) || 200;
    const seed = parseInt(params.seed) || 42;
    const feeMode = params.feeMode || 'taker';
    const source = params.source || 'pg-cache'; // Default to fast cached path

    const backtestFn = source === 'pg-cache' ? runFactoryBacktestPgCache : runFactoryBacktestPg;

    const result = await backtestFn({
      strategy,
      symbol,
      sampleOptions: { count: sample, seed },
      config: { feeMode },
      includeBaseline: params.includeBaseline !== false,
    });

    json(res, 200, { ok: true, data: result });
    return true;
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
    return true;
  }
}

/**
 * Read the full request body as a string.
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/**
 * Load a strategy by name for the API endpoint.
 * Searches src/factory/strategies/ and src/backtest/strategies/.
 */
async function loadStrategyForApi(name) {
  // Try YAML first
  const yamlPath = resolve(process.cwd(), `src/factory/strategies/${name}`);
  const yamlPathWithExt = name.endsWith('.yaml') || name.endsWith('.yml')
    ? yamlPath
    : `${yamlPath}.yaml`;

  if (existsSync(yamlPathWithExt)) {
    const { composeFromYaml } = await import('../src/factory/compose.js');
    const yamlContent = readFileSync(yamlPathWithExt, 'utf8');
    return composeFromYaml(yamlContent);
  }

  // Try JS in factory/strategies/
  const factoryJsPath = resolve(process.cwd(), `src/factory/strategies/${name}`);
  const factoryJsWithExt = name.endsWith('.js') ? factoryJsPath : `${factoryJsPath}.js`;
  if (existsSync(factoryJsWithExt)) {
    const mod = await import(pathToFileURL(factoryJsWithExt).href);
    return normalizeStrategy(mod, name);
  }

  // Try JS in backtest/strategies/
  const backtestJsPath = resolve(process.cwd(), `src/backtest/strategies/${name}`);
  const backtestJsWithExt = name.endsWith('.js') ? backtestJsPath : `${backtestJsPath}.js`;
  if (existsSync(backtestJsWithExt)) {
    const mod = await import(pathToFileURL(backtestJsWithExt).href);
    return normalizeStrategy(mod, name);
  }

  throw new Error(`Strategy '${name}' not found`);
}

function normalizeStrategy(mod, name) {
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

// =============================================================================
// ANALYZE ENDPOINT
// =============================================================================

/**
 * POST /api/factory/analyze — run server-side analysis on pg_timelines data
 *
 * Body: { symbol, sample, seed, analysis }
 *   symbol: e.g. "sol" (required)
 *   sample: sample size (default: 200)
 *   seed: PRNG seed (default: 42)
 *   analysis: analysis module name (default: "final-60s")
 */
async function handleAnalyze(req, res) {
  const startTime = Date.now();
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};

    const symbol = (body.symbol || '').toLowerCase();
    if (!symbol) {
      json(res, 400, { ok: false, error: 'Missing required field: symbol' });
      return true;
    }

    const sample = parseInt(body.sample) || 200;
    const seed = parseInt(body.seed) || 42;
    const analysisName = body.analysis || 'final-60s';

    // Load the analysis module dynamically
    let analysisModule;
    try {
      analysisModule = await import(`../src/factory/analyses/${analysisName}.js`);
    } catch (err) {
      json(res, 400, { ok: false, error: `Unknown analysis module: ${analysisName} — ${err.message}` });
      return true;
    }

    if (typeof analysisModule.analyze !== 'function') {
      json(res, 400, { ok: false, error: `Analysis module '${analysisName}' does not export an analyze() function` });
      return true;
    }

    // Step 1: List all windows for this symbol (metadata only, no blobs)
    await ensurePgTimelineTable();
    const allWindows = await listPgWindows(symbol);

    if (!allWindows || allWindows.length === 0) {
      json(res, 200, {
        ok: true,
        data: { symbol, windowsAvailable: 0, error: 'No cached windows found for this symbol' },
        elapsed_ms: Date.now() - startTime,
      });
      return true;
    }

    // Normalize timestamps for sampler compatibility
    const normalized = allWindows.map(w => ({
      ...w,
      window_close_time: w.window_close_time instanceof Date
        ? w.window_close_time.toISOString()
        : w.window_close_time,
      window_open_time: w.window_open_time instanceof Date
        ? w.window_open_time.toISOString()
        : w.window_open_time,
    }));

    // Step 2: Sample windows
    const sampled = sampleWindows(normalized, { count: sample, seed });

    // Step 3: Batch-load timelines in chunks to avoid PG statement timeout
    const windowIds = sampled.map(w => w.window_id);
    const CHUNK_SIZE = 10; // ~10 windows at a time to stay under PG statement timeout
    const timelinesMap = new Map();
    for (let i = 0; i < windowIds.length; i += CHUNK_SIZE) {
      const chunk = windowIds.slice(i, i + CHUNK_SIZE);
      const chunkMap = await readPgTimelines(chunk);
      for (const [k, v] of chunkMap) timelinesMap.set(k, v);
    }

    // Step 4: Assemble windows with their timelines
    const windowsWithTimelines = [];
    for (const winMeta of sampled) {
      const cached = timelinesMap.get(winMeta.window_id);
      if (cached) {
        windowsWithTimelines.push({
          meta: cached.meta || winMeta,
          timeline: cached.timeline,
        });
      }
    }

    // Step 5: Run the analysis
    const result = analysisModule.analyze(windowsWithTimelines, { symbol });

    json(res, 200, {
      ok: true,
      data: result,
      meta: {
        windowsAvailable: allWindows.length,
        windowsSampled: sampled.length,
        windowsLoaded: windowsWithTimelines.length,
        seed,
        analysis: analysisName,
        elapsed_ms: Date.now() - startTime,
      },
    });
    return true;
  } catch (err) {
    json(res, 500, { ok: false, error: err.message, stack: err.stack });
    return true;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Execute a persistence query, returning null if the table doesn't exist.
 */
async function safeQuery(queryFn) {
  try {
    return await queryFn();
  } catch (err) {
    if (isTableMissingError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Check if an error is a "relation does not exist" PostgreSQL error.
 */
function isTableMissingError(err) {
  const msg = err?.message || '';
  return (
    msg.includes('does not exist') ||
    msg.includes('relation') ||
    err?.code === '42P01'  // PostgreSQL "undefined_table" error code
  );
}

/**
 * Return appropriate empty data structure based on URL pattern.
 */
function emptyDataForUrl(url) {
  if (url.includes('/leaderboard')) return { strategies: [] };
  if (url.includes('/lineage')) return { lineage: [] };
  if (url.includes('/coverage')) return { coverage: [] };
  if (url.includes('/compare')) return { comparison: [], warnings: [] };
  if (url.includes('/results')) return { results: [] };
  if (url.includes('/runs')) return { runs: [] };
  return {};
}

/**
 * Parse query parameters from a URL string.
 */
function parseQueryParams(rawUrl) {
  const qIdx = rawUrl?.indexOf('?');
  if (!rawUrl || qIdx === -1) return {};
  const search = rawUrl.slice(qIdx + 1);
  const params = {};
  for (const pair of search.split('&')) {
    const [key, ...rest] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return params;
}

/**
 * JSON response helper matching existing dashboard-api pattern.
 */
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// =============================================================================
// POST /api/factory/backfill — build PG timeline cache on Railway
// =============================================================================

/**
 * Ensure the backfill_log table exists for tracking backfill progress and errors.
 */
async function ensureBackfillLogTable() {
  await persistence.exec(`
    CREATE TABLE IF NOT EXISTS backfill_log (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      windows_processed INTEGER DEFAULT 0,
      windows_total INTEGER DEFAULT 0,
      windows_inserted INTEGER DEFAULT 0,
      error_detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/**
 * Insert a backfill log entry.
 */
async function logBackfill({ symbol, status, message, windows_processed, windows_total, windows_inserted, error_detail }) {
  await persistence.run(
    `INSERT INTO backfill_log (symbol, status, message, windows_processed, windows_total, windows_inserted, error_detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [symbol, status, message || null, windows_processed || 0, windows_total || 0, windows_inserted || 0, error_detail || null]
  );
}

/**
 * GET /api/factory/backfill-status — recent backfill log entries
 */
async function handleBackfillStatus(req, res) {
  try {
    await ensureBackfillLogTable();
    const rows = await persistence.all(
      `SELECT * FROM backfill_log ORDER BY created_at DESC LIMIT 50`
    );
    json(res, 200, { ok: true, data: rows });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
  return true;
}

// Sequential backfill queue — only one backfill runs at a time to avoid
// overwhelming the PG connection pool and causing OOM/crash on Railway.
const backfillQueue = [];
let backfillRunning = false;

async function processBackfillQueue() {
  if (backfillRunning || backfillQueue.length === 0) return;
  backfillRunning = true;

  while (backfillQueue.length > 0) {
    const { buildOpts, symbol } = backfillQueue.shift();
    console.log(`[backfill-queue] Starting ${symbol} (${backfillQueue.length} remaining in queue)`);
    try {
      const report = await buildTimelines(buildOpts);
      const inserted = report.symbols ? Object.values(report.symbols).reduce((s, r) => s + r.inserted, 0) : report.inserted;
      console.log(`[backfill-queue] Complete: ${symbol} — ${inserted} windows cached`);
      await logBackfill({
        symbol, status: 'complete',
        message: `Inserted ${inserted}, errors: ${report.errors?.length || 0}`,
        windows_processed: report.processed,
        windows_total: report.totalWindowsInPg,
        windows_inserted: inserted,
      }).catch(() => {});
    } catch (err) {
      console.error(`[backfill-queue] Error for ${symbol}: ${err.message}`);
      await logBackfill({ symbol, status: 'error', error_detail: err.stack || err.message }).catch(() => {});
    }
  }

  backfillRunning = false;
  console.log('[backfill-queue] Queue empty, idle');
}

async function handleBackfill(req, res) {
  try {
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const symbol = (body.symbol || 'btc').toLowerCase();
    const startDate = body.startDate || body.since || '2026-02-10';
    const rebuild = !!body.rebuild;
    const sync = !!body.sync;

    await ensurePgTimelineTable();
    await ensureBackfillLogTable();
    const before = await getPgCacheSummary();

    // Log start
    await logBackfill({ symbol, status: 'started', message: `rebuild=${rebuild} startDate=${startDate} sync=${sync}` });

    const buildOpts = {
      symbol,
      rebuild,
      incremental: !rebuild,
      startDate,
      target: 'pg',
      onProgress: ({ symbol: sym, processed, total, inserted, skipped }) => {
        if (processed % 100 === 0 || processed === total) {
          console.log(`[backfill] ${sym}: ${processed}/${total} (${inserted} inserted, ${skipped} skipped)`);
          // Log progress periodically (every 200 windows or at completion)
          if (processed % 200 === 0 || processed === total) {
            logBackfill({ symbol: sym, status: 'progress', windows_processed: processed, windows_total: total, windows_inserted: inserted }).catch(() => {});
          }
        }
      },
    };

    // Sync mode: await the result and return full report (for debugging)
    if (sync) {
      try {
        const report = await buildTimelines(buildOpts);
        await logBackfill({
          symbol, status: 'complete',
          message: `Inserted ${report.inserted}, errors: ${report.errors?.length || 0}`,
          windows_processed: report.processed,
          windows_total: report.totalWindowsInPg,
          windows_inserted: report.inserted,
        });
        json(res, 200, {
          ok: true,
          status: 'complete',
          symbol,
          report,
          cacheBefore: before.find(r => r.symbol === symbol) || { total_windows: 0 },
        });
      } catch (err) {
        await logBackfill({ symbol, status: 'error', error_detail: err.stack || err.message }).catch(() => {});
        json(res, 500, { ok: false, error: err.message, stack: err.stack });
      }
      return true;
    }

    // Async mode: add to sequential queue, respond immediately
    const queuePos = backfillQueue.length + (backfillRunning ? 1 : 0);
    json(res, 200, {
      ok: true,
      status: 'queued',
      symbol,
      startDate,
      rebuild,
      queuePosition: queuePos,
      message: `Backfill queued (position ${queuePos}). Check GET /api/factory/backfill-status for progress.`,
      cacheBefore: before.find(r => r.symbol === symbol) || { total_windows: 0 },
    });

    // Add to queue and start processing if idle
    backfillQueue.push({ buildOpts, symbol });
    processBackfillQueue(); // Non-blocking — runs sequentially

  } catch (err) {
    try {
      json(res, 500, { ok: false, error: err.message });
    } catch { /* headers may already be sent */ }
  }
  return true;
}
