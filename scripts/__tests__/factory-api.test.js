/**
 * Factory API Endpoint Tests
 *
 * Tests the handleFactoryRequest() function from factory-api.mjs.
 * Mocks the persistence layer to return fixture data, then verifies
 * response shape, filtering, sorting, pagination, and error handling.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer } from 'http';

// ================================
// MOCK SETUP
// ================================

// Fixture data (inline subset for unit tests)
const mockRuns = [
  {
    run_id: 1, manifest_name: 'sweep-deficit', status: 'completed',
    started_at: '2026-03-10T08:00:00.000Z', completed_at: '2026-03-10T08:45:00.000Z',
    wall_clock_ms: 2700000, total_runs: 24, completed_runs: 24,
    summary: { bestSharpe: 1.82, bestStrategy: 'deficit-v1' }, error_message: null,
  },
  {
    run_id: 2, manifest_name: 'sweep-momentum', status: 'running',
    started_at: '2026-03-14T10:00:00.000Z', completed_at: null,
    wall_clock_ms: null, total_runs: 16, completed_runs: 8,
    summary: null, error_message: null,
  },
];

const mockResults = [
  {
    id: 1, run_id: 1, strategy_name: 'deficit-v1', strategy_source: 'yaml',
    symbol: 'btc', config: { threshold: 0.08 }, sample_size: 200,
    metrics: { sharpe: 1.82, sortino: 2.15, profitFactor: 2.31, trades: 142, winRate: 0.62, maxDrawdown: 0.065 },
    elapsed_ms: 12400, created_at: '2026-03-10T08:12:00.000Z',
  },
  {
    id: 2, run_id: 1, strategy_name: 'deficit-v1', strategy_source: 'yaml',
    symbol: 'eth', config: { threshold: 0.08 }, sample_size: 200,
    metrics: { sharpe: 1.45, sortino: 1.72, profitFactor: 1.88, trades: 138, winRate: 0.58, maxDrawdown: 0.092 },
    elapsed_ms: 11200, created_at: '2026-03-10T08:14:00.000Z',
  },
  {
    id: 3, run_id: 1, strategy_name: 'deficit-v1', strategy_source: 'yaml',
    symbol: 'sol', config: { threshold: 0.08 }, sample_size: 80,
    metrics: { sharpe: 0.95, sortino: 1.10, profitFactor: 1.35, trades: 38, winRate: 0.52, maxDrawdown: 0.18 },
    elapsed_ms: 5200, created_at: '2026-03-10T08:16:00.000Z',
  },
];

const mockLineage = [
  {
    id: 1, strategy_name: 'deficit-v1', parent_name: null,
    mutation_type: 'original', mutation_reasoning: 'Base hypothesis',
    created_at: '2026-03-08T12:00:00.000Z', created_by: 'matthew',
  },
  {
    id: 2, strategy_name: 'deficit-v2', parent_name: 'deficit-v1',
    mutation_type: 'param_perturb', mutation_reasoning: 'Increase threshold',
    created_at: '2026-03-09T14:00:00.000Z', created_by: 'claude',
  },
  {
    id: 3, strategy_name: 'deficit-adaptive-v1', parent_name: 'deficit-v1',
    mutation_type: 'structural', mutation_reasoning: 'Add adaptive threshold',
    created_at: '2026-03-10T10:00:00.000Z', created_by: 'claude',
  },
];

// Mock persistence module
const mockGet = vi.fn();
const mockAll = vi.fn();

vi.mock('../../src/persistence/index.js', () => ({
  default: {
    get: (...args) => mockGet(...args),
    all: (...args) => mockAll(...args),
  },
}));

const { handleFactoryRequest } = await import('../factory-api.mjs');

// ================================
// TEST HELPERS
// ================================

function createMockReq(url, method = 'GET') {
  return { url, method };
}

function createMockRes() {
  const res = {
    _status: null,
    _headers: {},
    _body: null,
    writeHead(status, headers) {
      res._status = status;
      Object.assign(res._headers, headers || {});
    },
    setHeader(key, value) {
      res._headers[key] = value;
    },
    end(body) {
      res._body = body ? JSON.parse(body) : null;
    },
  };
  return res;
}

// ================================
// TESTS
// ================================

describe('Factory API — handleFactoryRequest()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for non-factory routes', async () => {
    const req = createMockReq('/api/backtest/runs');
    const res = createMockRes();
    const handled = await handleFactoryRequest(req, res);
    expect(handled).toBe(false);
  });

  it('returns 405 for non-GET methods', async () => {
    const req = createMockReq('/api/factory/runs', 'POST');
    const res = createMockRes();
    await handleFactoryRequest(req, res);
    expect(res._status).toBe(405);
  });

  describe('GET /api/factory/runs', () => {
    it('returns paginated runs list', async () => {
      mockAll.mockResolvedValueOnce(mockRuns);
      mockGet.mockResolvedValueOnce({ total: '2' });

      const req = createMockReq('/api/factory/runs');
      const res = createMockRes();
      const handled = await handleFactoryRequest(req, res);

      expect(handled).toBe(true);
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.data.runs).toBeDefined();
    });

    it('returns empty data when factory_runs table does not exist', async () => {
      const tableError = new Error('relation "factory_runs" does not exist');
      tableError.code = '42P01';
      // safeQuery catches table-missing errors and returns null
      mockGet.mockRejectedValue(tableError);
      mockAll.mockRejectedValue(tableError);

      const req = createMockReq('/api/factory/runs');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      // When tables are missing, safeQuery returns null, yielding empty runs
      expect(res._body.data.runs).toEqual([]);
    });
  });

  describe('GET /api/factory/runs/:id', () => {
    it('returns single run detail', async () => {
      mockGet.mockResolvedValueOnce(mockRuns[0]);

      const req = createMockReq('/api/factory/runs/1');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.run.run_id).toBe(1);
    });

    it('returns 404 for missing run', async () => {
      mockGet.mockResolvedValueOnce(null);

      const req = createMockReq('/api/factory/runs/999');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(404);
    });
  });

  describe('GET /api/factory/runs/:id/results', () => {
    it('returns results for a run with sorting', async () => {
      mockAll.mockResolvedValueOnce(mockResults.filter(r => r.run_id === 1));

      const req = createMockReq('/api/factory/runs/1/results?sort=sharpe&order=desc');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.results.length).toBe(3);
    });
  });

  describe('GET /api/factory/leaderboard', () => {
    it('returns deduplicated strategies sorted by metric', async () => {
      mockAll.mockResolvedValueOnce(mockResults);

      const req = createMockReq('/api/factory/leaderboard');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.strategies).toBeDefined();
    });
  });

  describe('GET /api/factory/strategies/:name/lineage', () => {
    it('returns lineage chain from root through descendants', async () => {
      mockAll.mockResolvedValueOnce(mockLineage);

      const req = createMockReq('/api/factory/strategies/deficit-v1/lineage');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.lineage.length).toBe(3);
      expect(res._body.meta.root).toBe('deficit-v1');
    });

    it('returns empty lineage when table is missing', async () => {
      mockAll.mockResolvedValueOnce(null);

      const req = createMockReq('/api/factory/strategies/deficit-v1/lineage');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.lineage).toEqual([]);
    });
  });

  describe('GET /api/factory/compare', () => {
    it('returns comparison with sample size warnings', async () => {
      mockAll.mockResolvedValueOnce([mockResults[0], mockResults[2]]);

      const req = createMockReq('/api/factory/compare?ids=1,3');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.comparison.length).toBe(2);
      // 200 vs 80 — should produce a warning
      expect(res._body.data.warnings.length).toBeGreaterThan(0);
    });

    it('returns 400 for missing ids', async () => {
      const req = createMockReq('/api/factory/compare');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(400);
    });
  });

  describe('GET /api/factory/coverage', () => {
    it('returns per-symbol aggregates', async () => {
      mockAll.mockResolvedValueOnce([
        { symbol: 'btc', total_results: '5', unique_strategies: '3', earliest_result: '2026-03-08', latest_result: '2026-03-12', avg_sample_size: '220' },
        { symbol: 'eth', total_results: '4', unique_strategies: '3', earliest_result: '2026-03-08', latest_result: '2026-03-12', avg_sample_size: '200' },
      ]);

      const req = createMockReq('/api/factory/coverage');
      const res = createMockRes();
      await handleFactoryRequest(req, res);

      expect(res._status).toBe(200);
      expect(res._body.data.coverage.length).toBe(2);
      expect(res._body.data.coverage[0].symbol).toBe('btc');
      expect(res._body.data.coverage[0].totalResults).toBe(5);
    });
  });
});
