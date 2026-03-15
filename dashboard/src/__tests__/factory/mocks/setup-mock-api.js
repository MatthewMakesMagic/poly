/**
 * MSW-style mock API setup for factory endpoints.
 *
 * Provides a setupMockApi() function that intercepts all /api/factory/*
 * fetch calls and returns fixture data. Uses global fetch mocking
 * (compatible with vitest) rather than MSW's service worker, since
 * the dashboard tests run in jsdom, not a real browser.
 *
 * Usage in tests:
 *   import { setupMockApi, teardownMockApi } from './mocks/setup-mock-api.js';
 *   beforeEach(() => setupMockApi());
 *   afterEach(() => teardownMockApi());
 */

import factoryRuns from '../fixtures/factory-runs.json';
import factoryResults from '../fixtures/factory-results.json';
import strategyLineage from '../fixtures/strategy-lineage.json';

/** @type {typeof globalThis.fetch | null} */
let originalFetch = null;

/**
 * Setup mock fetch that intercepts /api/factory/* calls.
 * Returns fixture data with the same response shape as the real API.
 */
export function setupMockApi() {
  originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;

    // Only intercept /api/factory/* — pass through everything else
    if (!url.startsWith('/api/factory')) {
      if (originalFetch) return originalFetch(input, init);
      throw new Error(`No mock for ${url}`);
    }

    const [path, queryString] = url.split('?');
    const params = parseParams(queryString);

    // Route to handler
    const response = routeRequest(path, params);
    return mockResponse(response.status, response.body);
  };
}

/**
 * Tear down mock fetch, restoring the original.
 */
export function teardownMockApi() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
}

/**
 * Route a mock request to the appropriate handler.
 */
function routeRequest(path, params) {
  // GET /api/factory/runs
  if (path === '/api/factory/runs') {
    return handleRunsList(params);
  }

  // GET /api/factory/leaderboard
  if (path === '/api/factory/leaderboard') {
    return handleLeaderboard(params);
  }

  // GET /api/factory/coverage
  if (path === '/api/factory/coverage') {
    return handleCoverage();
  }

  // GET /api/factory/compare
  if (path === '/api/factory/compare') {
    return handleCompare(params);
  }

  // GET /api/factory/strategies/:name/lineage
  const lineageMatch = path.match(/^\/api\/factory\/strategies\/([^/]+)\/lineage$/);
  if (lineageMatch) {
    return handleStrategyLineage(decodeURIComponent(lineageMatch[1]));
  }

  // GET /api/factory/strategies/:name/results
  const stratResultsMatch = path.match(/^\/api\/factory\/strategies\/([^/]+)\/results$/);
  if (stratResultsMatch) {
    return handleStrategyResults(decodeURIComponent(stratResultsMatch[1]), params);
  }

  // GET /api/factory/runs/:id/results
  const runResultsMatch = path.match(/^\/api\/factory\/runs\/(\d+)\/results$/);
  if (runResultsMatch) {
    return handleRunResults(parseInt(runResultsMatch[1]), params);
  }

  // GET /api/factory/runs/:id
  const runDetailMatch = path.match(/^\/api\/factory\/runs\/(\d+)$/);
  if (runDetailMatch) {
    return handleRunDetail(parseInt(runDetailMatch[1]));
  }

  return { status: 404, body: { ok: false, error: 'Not found' } };
}

// =============================================================================
// MOCK HANDLERS
// =============================================================================

function handleRunsList(params) {
  let runs = [...factoryRuns];
  const limit = Math.min(parseInt(params.limit) || 50, 200);
  const offset = parseInt(params.offset) || 0;

  if (params.status) {
    runs = runs.filter(r => r.status === params.status);
  }

  // Sort by started_at descending
  runs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  const total = runs.length;
  runs = runs.slice(offset, offset + limit);

  return {
    status: 200,
    body: { ok: true, data: { runs }, meta: { total, limit, offset } },
  };
}

function handleRunDetail(runId) {
  const run = factoryRuns.find(r => r.run_id === runId);
  if (!run) {
    return { status: 404, body: { ok: false, error: 'Run not found' } };
  }
  return { status: 200, body: { ok: true, data: { run } } };
}

function handleRunResults(runId, params) {
  let results = factoryResults.filter(r => r.run_id === runId);

  if (params.symbol) {
    results = results.filter(r => r.symbol.toLowerCase() === params.symbol.toLowerCase());
  }
  if (params.minTrades) {
    const min = parseInt(params.minTrades);
    results = results.filter(r => (r.metrics?.trades || 0) >= min);
  }

  // Sort
  const sortKey = params.sort || 'sharpe';
  const descending = params.order !== 'asc';
  results.sort((a, b) => {
    const aVal = a.metrics?.[sortKey] || 0;
    const bVal = b.metrics?.[sortKey] || 0;
    return descending ? (bVal - aVal) : (aVal - bVal);
  });

  return {
    status: 200,
    body: { ok: true, data: { results }, meta: { total: results.length } },
  };
}

function handleLeaderboard(params) {
  const limit = Math.min(parseInt(params.limit) || 25, 100);
  const minTrades = parseInt(params.minTrades) || 0;
  const metricKey = params.metric || 'sharpe';

  let results = [...factoryResults];

  if (minTrades > 0) {
    results = results.filter(r => (r.metrics?.trades || 0) >= minTrades);
  }

  // Deduplicate by strategy_name + symbol (best per combo)
  const best = new Map();
  for (const r of results) {
    const key = `${r.strategy_name}|${r.symbol}`;
    const existing = best.get(key);
    if (!existing || (r.metrics?.[metricKey] || 0) > (existing.metrics?.[metricKey] || 0)) {
      best.set(key, r);
    }
  }

  const strategies = [...best.values()]
    .map(r => ({
      ...r,
      lowSample: (r.metrics?.trades || 0) < 50,
    }))
    .sort((a, b) => (b.metrics?.[metricKey] || 0) - (a.metrics?.[metricKey] || 0))
    .slice(0, limit);

  return {
    status: 200,
    body: { ok: true, data: { strategies }, meta: { total: strategies.length, limit } },
  };
}

function handleStrategyLineage(strategyName) {
  // Build lineage chain from fixtures
  const byName = new Map();
  for (const entry of strategyLineage) {
    byName.set(entry.strategy_name, entry);
  }

  // Walk up to root
  let current = strategyName;
  const visited = new Set();
  while (current && byName.has(current) && !visited.has(current)) {
    visited.add(current);
    const entry = byName.get(current);
    if (!entry.parent_name) break;
    current = entry.parent_name;
  }
  const root = current;

  // BFS from root
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
      for (const e of strategyLineage) {
        if (e.parent_name === name && !seen.has(e.strategy_name)) {
          queue.push(e.strategy_name);
        }
      }
    }
  }

  return {
    status: 200,
    body: { ok: true, data: { lineage: chain }, meta: { total: chain.length, root } },
  };
}

function handleStrategyResults(strategyName, params) {
  let results = factoryResults.filter(r => r.strategy_name === strategyName);

  if (params.symbol) {
    results = results.filter(r => r.symbol.toLowerCase() === params.symbol.toLowerCase());
  }

  results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return {
    status: 200,
    body: { ok: true, data: { results }, meta: { total: results.length } },
  };
}

function handleCoverage() {
  // Aggregate from fixture results
  const bySymbol = {};
  for (const r of factoryResults) {
    if (!bySymbol[r.symbol]) {
      bySymbol[r.symbol] = {
        symbol: r.symbol,
        totalResults: 0,
        uniqueStrategies: new Set(),
        earliest: r.created_at,
        latest: r.created_at,
        sampleSizes: [],
      };
    }
    const s = bySymbol[r.symbol];
    s.totalResults++;
    s.uniqueStrategies.add(r.strategy_name);
    s.sampleSizes.push(r.sample_size || 0);
    if (r.created_at < s.earliest) s.earliest = r.created_at;
    if (r.created_at > s.latest) s.latest = r.created_at;
  }

  const coverage = Object.values(bySymbol).map(s => ({
    symbol: s.symbol,
    totalResults: s.totalResults,
    uniqueStrategies: s.uniqueStrategies.size,
    dateRange: { from: s.earliest, to: s.latest },
    avgSampleSize: Math.round(s.sampleSizes.reduce((a, b) => a + b, 0) / s.sampleSizes.length),
    timeline: null,
  }));

  return {
    status: 200,
    body: { ok: true, data: { coverage }, meta: { total: coverage.length } },
  };
}

function handleCompare(params) {
  const ids = (params.ids || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

  if (ids.length === 0) {
    return { status: 400, body: { ok: false, error: 'Missing or invalid ids parameter' } };
  }

  const comparison = factoryResults.filter(r => ids.includes(r.id));
  const warnings = [];

  if (comparison.length >= 2) {
    const sizes = comparison.map(r => r.sample_size || 0).filter(s => s > 0);
    if (sizes.length >= 2) {
      const max = Math.max(...sizes);
      const min = Math.min(...sizes);
      if (max > min * 2) {
        warnings.push(`Sample sizes vary significantly (${min} to ${max}) — comparison may be unreliable`);
      }
    }
  }

  return {
    status: 200,
    body: { ok: true, data: { comparison, warnings }, meta: { total: comparison.length } },
  };
}

// =============================================================================
// UTILITIES
// =============================================================================

function parseParams(queryString) {
  if (!queryString) return {};
  const params = {};
  for (const pair of queryString.split('&')) {
    const [key, ...rest] = pair.split('=');
    params[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return params;
}

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
