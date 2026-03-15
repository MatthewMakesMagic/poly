/**
 * Factory API Integration Tests
 *
 * Tests all /api/factory/* mock endpoints to verify:
 * - Correct response shapes matching the architecture doc
 * - Pagination, filtering, and sorting
 * - Leaderboard deduplication and ranking
 * - Lineage tree traversal
 * - Coverage aggregation
 * - Comparison with sample size warnings (FR32)
 *
 * Uses the setupMockApi() fetch interceptor with fixture data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupMockApi, teardownMockApi } from '../mocks/setup-mock-api.js';

describe('Factory API — Mock Endpoints', () => {
  beforeEach(() => setupMockApi());
  afterEach(() => teardownMockApi());

  // ===========================================================================
  // Story 6.1: Factory Runs List
  // ===========================================================================
  describe('GET /api/factory/runs', () => {
    it('returns all runs sorted by started_at descending (newest first)', async () => {
      const res = await fetch('/api/factory/runs');
      expect(res.ok).toBe(true);

      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.runs).toBeDefined();
      expect(body.data.runs.length).toBeGreaterThanOrEqual(5);
      expect(body.meta.total).toBeGreaterThanOrEqual(5);

      // Verify sorted by started_at descending
      const dates = body.data.runs.map(r => new Date(r.started_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]).toBeLessThanOrEqual(dates[i - 1]);
      }
    });

    it('each run includes required fields from the architecture spec', async () => {
      const res = await fetch('/api/factory/runs');
      const body = await res.json();
      const run = body.data.runs[0];

      expect(run).toHaveProperty('run_id');
      expect(run).toHaveProperty('manifest_name');
      expect(run).toHaveProperty('status');
      expect(run).toHaveProperty('started_at');
      expect(run).toHaveProperty('total_runs');
      expect(run).toHaveProperty('completed_runs');
    });

    it('filters by status when ?status=completed is provided', async () => {
      const res = await fetch('/api/factory/runs?status=completed');
      const body = await res.json();

      expect(body.ok).toBe(true);
      for (const run of body.data.runs) {
        expect(run.status).toBe('completed');
      }
      // Should not include the "running" or "failed" runs
      expect(body.data.runs.every(r => r.status === 'completed')).toBe(true);
    });

    it('paginates with ?limit=2&offset=1', async () => {
      const allRes = await fetch('/api/factory/runs');
      const allBody = await allRes.json();

      const pageRes = await fetch('/api/factory/runs?limit=2&offset=1');
      const pageBody = await pageRes.json();

      expect(pageBody.meta.limit).toBe(2);
      expect(pageBody.meta.offset).toBe(1);
      expect(pageBody.data.runs.length).toBe(2);
      // The first item of page should match the second item of all
      expect(pageBody.data.runs[0].run_id).toBe(allBody.data.runs[1].run_id);
    });
  });

  // ===========================================================================
  // Story 6.2: Run Detail and Results
  // ===========================================================================
  describe('GET /api/factory/runs/:id', () => {
    it('returns a single run with all metadata', async () => {
      const res = await fetch('/api/factory/runs/1');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.run).toBeDefined();
      expect(body.data.run.run_id).toBe(1);
      expect(body.data.run.manifest_name).toBe('sweep-deficit-asymmetry');
      expect(body.data.run.summary).toBeDefined();
      expect(body.data.run.summary.bestSharpe).toBe(1.82);
    });

    it('returns 404 for non-existent run', async () => {
      const res = await fetch('/api/factory/runs/999');
      const body = await res.json();

      expect(body.ok).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  describe('GET /api/factory/runs/:id/results', () => {
    it('returns all results for run_id=1 with correct fields', async () => {
      const res = await fetch('/api/factory/runs/1/results');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.results.length).toBeGreaterThanOrEqual(4);

      const result = body.data.results[0];
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('strategy_name');
      expect(result).toHaveProperty('strategy_source');
      expect(result).toHaveProperty('symbol');
      expect(result).toHaveProperty('config');
      expect(result).toHaveProperty('sample_size');
      expect(result).toHaveProperty('metrics');
      expect(result).toHaveProperty('elapsed_ms');
    });

    it('filters by ?symbol=btc', async () => {
      const res = await fetch('/api/factory/runs/1/results?symbol=btc');
      const body = await res.json();

      for (const result of body.data.results) {
        expect(result.symbol.toLowerCase()).toBe('btc');
      }
    });

    it('filters by ?minTrades=100 excluding low-trade results', async () => {
      const res = await fetch('/api/factory/runs/1/results?minTrades=100');
      const body = await res.json();

      for (const result of body.data.results) {
        expect(result.metrics.trades).toBeGreaterThanOrEqual(100);
      }
    });

    it('sorts by ?sort=sharpe&order=desc (default)', async () => {
      const res = await fetch('/api/factory/runs/1/results?sort=sharpe&order=desc');
      const body = await res.json();

      const sharpes = body.data.results.map(r => r.metrics.sharpe);
      for (let i = 1; i < sharpes.length; i++) {
        expect(sharpes[i]).toBeLessThanOrEqual(sharpes[i - 1]);
      }
    });
  });

  // ===========================================================================
  // Story 6.3: Leaderboard
  // ===========================================================================
  describe('GET /api/factory/leaderboard', () => {
    it('returns strategies ranked by Sharpe (default), deduplicated by strategy+symbol', async () => {
      const res = await fetch('/api/factory/leaderboard');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.strategies.length).toBeGreaterThan(0);

      // Check no duplicate strategy+symbol combos
      const keys = body.data.strategies.map(s => `${s.strategy_name}|${s.symbol}`);
      const uniqueKeys = [...new Set(keys)];
      expect(keys.length).toBe(uniqueKeys.length);

      // Sorted by Sharpe descending
      const sharpes = body.data.strategies.map(s => s.metrics.sharpe);
      for (let i = 1; i < sharpes.length; i++) {
        expect(sharpes[i]).toBeLessThanOrEqual(sharpes[i - 1]);
      }
    });

    it('returns lowSample flag for entries with < 50 trades', async () => {
      const res = await fetch('/api/factory/leaderboard');
      const body = await res.json();

      for (const strat of body.data.strategies) {
        if (strat.metrics.trades < 50) {
          expect(strat.lowSample).toBe(true);
        } else {
          expect(strat.lowSample).toBe(false);
        }
      }
    });

    it('sorts by ?metric=profitFactor', async () => {
      const res = await fetch('/api/factory/leaderboard?metric=profitFactor');
      const body = await res.json();

      const pfs = body.data.strategies.map(s => s.metrics.profitFactor);
      for (let i = 1; i < pfs.length; i++) {
        expect(pfs[i]).toBeLessThanOrEqual(pfs[i - 1]);
      }
    });

    it('limits with ?limit=3', async () => {
      const res = await fetch('/api/factory/leaderboard?limit=3');
      const body = await res.json();

      expect(body.data.strategies.length).toBeLessThanOrEqual(3);
    });

    it('filters by ?minTrades=100 excluding low-sample results', async () => {
      const res = await fetch('/api/factory/leaderboard?minTrades=100');
      const body = await res.json();

      for (const strat of body.data.strategies) {
        expect(strat.metrics.trades).toBeGreaterThanOrEqual(100);
      }
    });
  });

  // ===========================================================================
  // Story 6.4: Strategy Lineage
  // ===========================================================================
  describe('GET /api/factory/strategies/:name/lineage', () => {
    it('returns the full lineage chain for deficit-asymmetry-v1 (root)', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-v1/lineage');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.lineage.length).toBeGreaterThanOrEqual(3);
      expect(body.meta.root).toBe('deficit-asymmetry-v1');

      // First entry should be the root (original)
      expect(body.data.lineage[0].strategy_name).toBe('deficit-asymmetry-v1');
      expect(body.data.lineage[0].mutation_type).toBe('original');
      expect(body.data.lineage[0].parent_name).toBeNull();
    });

    it('returns the same chain when querying a descendant (deficit-asymmetry-adaptive-v2)', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-adaptive-v2/lineage');
      const body = await res.json();

      expect(body.ok).toBe(true);
      // Should include the full chain from root
      expect(body.meta.root).toBe('deficit-asymmetry-v1');

      const names = body.data.lineage.map(l => l.strategy_name);
      expect(names).toContain('deficit-asymmetry-v1');
      expect(names).toContain('deficit-asymmetry-adaptive-v1');
      expect(names).toContain('deficit-asymmetry-adaptive-v2');
    });

    it('each entry has required lineage fields', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-v1/lineage');
      const body = await res.json();

      for (const entry of body.data.lineage) {
        expect(entry).toHaveProperty('strategy_name');
        expect(entry).toHaveProperty('parent_name');
        expect(entry).toHaveProperty('mutation_type');
        expect(entry).toHaveProperty('mutation_reasoning');
        expect(entry).toHaveProperty('created_at');
        expect(entry).toHaveProperty('created_by');
        expect(['original', 'param_perturb', 'structural', 'crossover']).toContain(entry.mutation_type);
      }
    });

    it('3-generation chain: original -> mutations -> sub-mutations', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-v1/lineage');
      const body = await res.json();
      const lineage = body.data.lineage;

      // Root has children
      const root = lineage.find(l => l.strategy_name === 'deficit-asymmetry-v1');
      expect(root.parent_name).toBeNull();

      // Gen 2: children of root
      const gen2 = lineage.filter(l => l.parent_name === 'deficit-asymmetry-v1');
      expect(gen2.length).toBeGreaterThanOrEqual(2);

      // Gen 3: children of gen2 entries
      const gen2Names = gen2.map(l => l.strategy_name);
      const gen3 = lineage.filter(l => gen2Names.includes(l.parent_name));
      expect(gen3.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/factory/strategies/:name/results', () => {
    it('returns all results for deficit-asymmetry-v1', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-v1/results');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.results.length).toBeGreaterThanOrEqual(3);
      for (const r of body.data.results) {
        expect(r.strategy_name).toBe('deficit-asymmetry-v1');
      }
    });

    it('filters by ?symbol=btc', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-v1/results?symbol=btc');
      const body = await res.json();

      for (const r of body.data.results) {
        expect(r.symbol.toLowerCase()).toBe('btc');
      }
    });
  });

  // ===========================================================================
  // Story 6.5: Coverage and Compare
  // ===========================================================================
  describe('GET /api/factory/coverage', () => {
    it('returns per-symbol aggregates', async () => {
      const res = await fetch('/api/factory/coverage');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.coverage.length).toBeGreaterThanOrEqual(2);

      const btc = body.data.coverage.find(c => c.symbol === 'btc');
      expect(btc).toBeDefined();
      expect(btc.totalResults).toBeGreaterThan(0);
      expect(btc.uniqueStrategies).toBeGreaterThan(0);
      expect(btc.dateRange).toHaveProperty('from');
      expect(btc.dateRange).toHaveProperty('to');
      expect(btc.avgSampleSize).toBeGreaterThan(0);
    });
  });

  describe('GET /api/factory/compare', () => {
    it('returns comparison rows for given IDs', async () => {
      const res = await fetch('/api/factory/compare?ids=1,2,3');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.comparison.length).toBe(3);
      expect(body.data.comparison[0].id).toBe(1);
      expect(body.data.comparison[1].id).toBe(2);
      expect(body.data.comparison[2].id).toBe(3);
    });

    it('produces sample size warning when sizes differ by > 2x (FR32)', async () => {
      // IDs 1 (sample_size=200) and 5 (sample_size=80) — 200 > 80*2 = 160
      const res = await fetch('/api/factory/compare?ids=1,5');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.warnings.length).toBeGreaterThan(0);
      expect(body.data.warnings[0]).toContain('Sample sizes vary significantly');
    });

    it('no warning when sample sizes are similar', async () => {
      // IDs 1 (200) and 2 (200) — same size
      const res = await fetch('/api/factory/compare?ids=1,2');
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.warnings.length).toBe(0);
    });

    it('returns error for missing ids parameter', async () => {
      const res = await fetch('/api/factory/compare');
      const body = await res.json();

      expect(body.ok).toBe(false);
      expect(body.error).toContain('ids');
    });
  });

  // ===========================================================================
  // Story 6.6: Fixture Data Validation
  // ===========================================================================
  describe('Fixture Data Shape Validation', () => {
    it('metrics JSONB matches architecture schema (sharpe, sortino, regime, confidenceIntervals)', async () => {
      const res = await fetch('/api/factory/leaderboard');
      const body = await res.json();

      // Find a high-sample result that should have full metrics
      const fullResult = body.data.strategies.find(s => s.metrics.trades >= 100);
      expect(fullResult).toBeDefined();

      const m = fullResult.metrics;
      expect(m).toHaveProperty('sharpe');
      expect(m).toHaveProperty('sortino');
      expect(m).toHaveProperty('profitFactor');
      expect(m).toHaveProperty('maxDrawdown');
      expect(m).toHaveProperty('winRate');
      expect(m).toHaveProperty('trades');
      expect(m).toHaveProperty('expectancy');
      expect(m).toHaveProperty('edgePerTrade');
      expect(m).toHaveProperty('totalPnl');
      expect(m).toHaveProperty('confidenceIntervals');
      expect(m.confidenceIntervals).toHaveProperty('sharpe');
      expect(m.confidenceIntervals.sharpe).toHaveProperty('lower');
      expect(m.confidenceIntervals.sharpe).toHaveProperty('upper');
      expect(m.confidenceIntervals.sharpe).toHaveProperty('level');
    });

    it('result with full regime data has timeOfDay and dayOfWeek arrays', async () => {
      const res = await fetch('/api/factory/runs/1/results');
      const body = await res.json();

      // deficit-asymmetry-v1 btc (id=1) has full regime data
      const fullRegime = body.data.results.find(
        r => r.id === 1 && r.strategy_name === 'deficit-asymmetry-v1' && r.symbol === 'btc'
      );
      expect(fullRegime).toBeDefined();
      expect(fullRegime.metrics.regime).toBeDefined();
      expect(fullRegime.metrics.regime.firstHalf).toHaveProperty('sharpe');
      expect(fullRegime.metrics.regime.secondHalf).toHaveProperty('sharpe');
      expect(fullRegime.metrics.regime.timeOfDay.length).toBeGreaterThan(0);
      expect(fullRegime.metrics.regime.dayOfWeek.length).toBeGreaterThan(0);

      const tod = fullRegime.metrics.regime.timeOfDay[0];
      expect(tod).toHaveProperty('bucket');
      expect(tod).toHaveProperty('trades');
      expect(tod).toHaveProperty('winRate');
      expect(tod).toHaveProperty('pnl');

      const dow = fullRegime.metrics.regime.dayOfWeek[0];
      expect(dow).toHaveProperty('day');
      expect(dow).toHaveProperty('trades');
      expect(dow).toHaveProperty('sharpe');
    });

    it('fixture runs include a mix of completed, running, and failed statuses', async () => {
      const res = await fetch('/api/factory/runs');
      const body = await res.json();

      const statuses = body.data.runs.map(r => r.status);
      expect(statuses).toContain('completed');
      expect(statuses).toContain('running');
      expect(statuses).toContain('failed');
    });

    it('fixture lineage includes all 4 mutation types', async () => {
      const res = await fetch('/api/factory/strategies/deficit-asymmetry-v1/lineage');
      const body = await res.json();

      const types = body.data.lineage.map(l => l.mutation_type);
      expect(types).toContain('original');
      expect(types).toContain('param_perturb');
      expect(types).toContain('structural');
      expect(types).toContain('crossover');
    });
  });
});
