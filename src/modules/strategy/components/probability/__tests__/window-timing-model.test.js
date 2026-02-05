/**
 * Window Timing Model Tests
 *
 * Comprehensive tests for Black-Scholes N(d2) probability calculations,
 * volatility calculation, calibration tracking, and standard interface.
 *
 * V3 Stage 4: Uses mocked persistence (PostgreSQL) instead of real SQLite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger before any imports that use it
vi.mock('../../../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  init: vi.fn(),
  shutdown: vi.fn(),
}));

// V3 Stage 4: Mock persistence with in-memory store
const tables = {
  probability_predictions: [],
  oracle_updates: [],
};
let nextId = 1;

vi.mock('../../../../../persistence/index.js', () => ({
  default: {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    exec: vi.fn(async () => {}),
    run: vi.fn(async (sql, params = []) => {
      if (sql.includes('INSERT INTO probability_predictions')) {
        const id = nextId++;
        const row = {
          id,
          timestamp: params[0],
          symbol: params[1],
          window_id: params[2],
          predicted_p_up: params[3],
          bucket: params[4],
          oracle_price_at_prediction: params[5],
          strike: params[6],
          time_to_expiry_ms: params[7],
          sigma_used: params[8],
          vol_surprise: params[9] || 0,
          actual_outcome: null,
          prediction_correct: null,
          settled_at: null,
        };
        tables.probability_predictions.push(row);
        return { changes: 1, lastInsertRowid: id };
      }
      if (sql.includes('UPDATE probability_predictions')) {
        const windowId = params[2] !== undefined ? undefined : params[0]; // Handle different param orderings
        let updated = 0;
        for (const row of tables.probability_predictions) {
          // Match by the WHERE clause - find row with matching window_id
          if (sql.includes('WHERE window_id')) {
            const whereWindowId = params[params.length - 1];
            if (row.window_id === whereWindowId) {
              row.actual_outcome = params[0];
              row.prediction_correct = params[1];
              row.settled_at = params[2];
              updated++;
            }
          }
        }
        return { changes: updated };
      }
      if (sql.includes('INSERT INTO oracle_updates')) {
        const id = nextId++;
        tables.oracle_updates.push({
          id,
          timestamp: params[0],
          symbol: params[1],
          price: params[2],
        });
        return { changes: 1, lastInsertRowid: id };
      }
      return { changes: 0 };
    }),
    get: vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM probability_predictions') && sql.includes('window_id')) {
        return tables.probability_predictions.find(r => r.window_id === params[0]) || undefined;
      }
      if (sql.includes('COUNT(*)') && sql.includes('probability_predictions')) {
        return { count: tables.probability_predictions.length };
      }
      return undefined;
    }),
    all: vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM oracle_updates')) {
        const symbol = params[0];
        return tables.oracle_updates
          .filter(r => r.symbol === symbol)
          .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }
      if (sql.includes('FROM probability_predictions') && sql.includes('GROUP BY')) {
        // Bucket stats query
        const settled = tables.probability_predictions.filter(r => r.actual_outcome !== null);
        const buckets = {};
        for (const row of settled) {
          if (!buckets[row.bucket]) {
            buckets[row.bucket] = { bucket: row.bucket, count: 0, hits: 0 };
          }
          buckets[row.bucket].count++;
          if (row.prediction_correct === 1) {
            buckets[row.bucket].hits++;
          }
        }
        return Object.values(buckets).map(b => ({
          ...b,
          hit_rate: b.count > 0 ? b.hits / b.count : 0,
        }));
      }
      return [];
    }),
    getState: vi.fn(() => ({ initialized: true })),
  },
}));

// Import modules AFTER mocks are set up
import * as windowTimingModel from '../window-timing-model.js';

describe('Window Timing Model', () => {
  beforeEach(async () => {
    // Reset in-memory store
    tables.probability_predictions = [];
    tables.oracle_updates = [];
    nextId = 1;
  });

  afterEach(async () => {
    await windowTimingModel.shutdown();
    vi.restoreAllMocks();
  });

  describe('Metadata', () => {
    it('exports correct metadata', () => {
      expect(windowTimingModel.metadata.name).toBe('window-timing-model');
      expect(windowTimingModel.metadata.version).toBe(1);
      expect(windowTimingModel.metadata.type).toBe('probability');
      expect(windowTimingModel.metadata.description).toContain('Black-Scholes');
    });
  });

  describe('normalCDF', () => {
    it('returns 0.5 for x = 0', () => {
      expect(windowTimingModel.normalCDF(0)).toBeCloseTo(0.5, 6);
    });

    it('returns ~0.8413 for x = 1', () => {
      expect(windowTimingModel.normalCDF(1)).toBeCloseTo(0.8413447, 4);
    });

    it('returns ~0.1587 for x = -1', () => {
      expect(windowTimingModel.normalCDF(-1)).toBeCloseTo(0.1586553, 4);
    });

    it('returns ~0.9772 for x = 2', () => {
      expect(windowTimingModel.normalCDF(2)).toBeCloseTo(0.9772499, 4);
    });

    it('returns ~0.0228 for x = -2', () => {
      expect(windowTimingModel.normalCDF(-2)).toBeCloseTo(0.0227501, 4);
    });

    it('returns ~0.9987 for x = 3', () => {
      expect(windowTimingModel.normalCDF(3)).toBeCloseTo(0.9986501, 3);
    });

    it('approaches 1 for large positive x', () => {
      expect(windowTimingModel.normalCDF(5)).toBeGreaterThan(0.9999);
    });

    it('approaches 0 for large negative x', () => {
      expect(windowTimingModel.normalCDF(-5)).toBeLessThan(0.0001);
    });

    it('returns NaN for NaN input', () => {
      expect(Number.isNaN(windowTimingModel.normalCDF(NaN))).toBe(true);
    });

    it('returns 1 for positive Infinity', () => {
      expect(windowTimingModel.normalCDF(Infinity)).toBe(1.0);
    });

    it('returns 0 for negative Infinity', () => {
      expect(windowTimingModel.normalCDF(-Infinity)).toBe(0.0);
    });
  });

  describe('calculateD2', () => {
    it('returns 0 when S = K and T > 0 with sigma > 0', () => {
      const d2 = windowTimingModel.calculateD2(100, 100, 0.01, 0.3, 0);
      expect(d2).toBeCloseTo(-0.015, 2);
    });

    it('returns positive d2 when S > K', () => {
      const d2 = windowTimingModel.calculateD2(110, 100, 0.1, 0.3, 0);
      expect(d2).toBeGreaterThan(0);
    });

    it('returns negative d2 when S < K', () => {
      const d2 = windowTimingModel.calculateD2(90, 100, 0.1, 0.3, 0);
      expect(d2).toBeLessThan(0);
    });

    it('returns Infinity when T <= 0 and S > K', () => {
      expect(windowTimingModel.calculateD2(110, 100, 0, 0.3)).toBe(Infinity);
      expect(windowTimingModel.calculateD2(110, 100, -1, 0.3)).toBe(Infinity);
    });

    it('returns -Infinity when T <= 0 and S < K', () => {
      expect(windowTimingModel.calculateD2(90, 100, 0, 0.3)).toBe(-Infinity);
      expect(windowTimingModel.calculateD2(90, 100, -1, 0.3)).toBe(-Infinity);
    });

    it('returns 0 when T <= 0 and S = K', () => {
      expect(windowTimingModel.calculateD2(100, 100, 0, 0.3)).toBe(0);
    });

    it('returns Infinity when sigma <= 0 and S > K', () => {
      expect(windowTimingModel.calculateD2(110, 100, 0.1, 0)).toBe(Infinity);
      expect(windowTimingModel.calculateD2(110, 100, 0.1, -0.1)).toBe(Infinity);
    });

    it('returns -Infinity when sigma <= 0 and S < K', () => {
      expect(windowTimingModel.calculateD2(90, 100, 0.1, 0)).toBe(-Infinity);
    });
  });

  describe('assignBucket', () => {
    it('assigns to correct buckets', () => {
      expect(windowTimingModel.assignBucket(0.05)).toBe('0-10%');
      expect(windowTimingModel.assignBucket(0.15)).toBe('10-20%');
      expect(windowTimingModel.assignBucket(0.25)).toBe('20-30%');
      expect(windowTimingModel.assignBucket(0.35)).toBe('30-40%');
      expect(windowTimingModel.assignBucket(0.45)).toBe('40-50%');
      expect(windowTimingModel.assignBucket(0.55)).toBe('50-60%');
      expect(windowTimingModel.assignBucket(0.65)).toBe('60-70%');
      expect(windowTimingModel.assignBucket(0.75)).toBe('70-80%');
      expect(windowTimingModel.assignBucket(0.85)).toBe('80-90%');
      expect(windowTimingModel.assignBucket(0.95)).toBe('90-100%');
    });

    it('handles boundary cases', () => {
      expect(windowTimingModel.assignBucket(0)).toBe('0-10%');
      expect(windowTimingModel.assignBucket(0.1)).toBe('10-20%');
      expect(windowTimingModel.assignBucket(0.5)).toBe('50-60%');
      expect(windowTimingModel.assignBucket(0.9)).toBe('90-100%');
      expect(windowTimingModel.assignBucket(1.0)).toBe('90-100%');
    });

    it('handles values outside [0, 1]', () => {
      expect(windowTimingModel.assignBucket(-0.1)).toBe('0-10%');
      expect(windowTimingModel.assignBucket(1.1)).toBe('90-100%');
    });
  });

  describe('init', () => {
    it('initializes with default config', async () => {
      await windowTimingModel.init({});

      const state = windowTimingModel.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.volatility.longTermLookbackMs).toBe(6 * 60 * 60 * 1000);
      expect(state.config.volatility.shortTermLookbackMs).toBe(15 * 60 * 1000);
      expect(state.config.calibration.alertThreshold).toBe(0.15);
    });

    it('initializes with custom config', async () => {
      await windowTimingModel.init({
        windowTimingModel: {
          volatility: {
            longTermLookbackMs: 12 * 60 * 60 * 1000,
            fallbackVol: 0.6,
          },
          calibration: {
            alertThreshold: 0.2,
          },
        },
      });

      const state = windowTimingModel.getState();
      expect(state.config.volatility.longTermLookbackMs).toBe(12 * 60 * 60 * 1000);
      expect(state.config.volatility.fallbackVol).toBe(0.6);
      expect(state.config.calibration.alertThreshold).toBe(0.2);
    });

    it('is idempotent', async () => {
      await windowTimingModel.init({});
      await windowTimingModel.init({});
      await windowTimingModel.init({});

      const state = windowTimingModel.getState();
      expect(state.initialized).toBe(true);
    });
  });

  describe('getState', () => {
    it('returns uninitialized state before init', () => {
      const state = windowTimingModel.getState();
      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });

    it('returns full state after init', async () => {
      await windowTimingModel.init({});

      const state = windowTimingModel.getState();
      expect(state.initialized).toBe(true);
      expect(state.volatility).toHaveProperty('btc');
      expect(state.volatility).toHaveProperty('eth');
      expect(state.volatility).toHaveProperty('sol');
      expect(state.volatility).toHaveProperty('xrp');
      expect(state.calibration).toBeDefined();
    });
  });

  describe('shutdown', () => {
    it('resets state after shutdown', async () => {
      await windowTimingModel.init({});
      await windowTimingModel.shutdown();

      const state = windowTimingModel.getState();
      expect(state.initialized).toBe(false);
    });

    it('is safe to call multiple times', async () => {
      await windowTimingModel.init({});
      await windowTimingModel.shutdown();
      await windowTimingModel.shutdown();

      const state = windowTimingModel.getState();
      expect(state.initialized).toBe(false);
    });

    it('is safe to call without init', async () => {
      await expect(windowTimingModel.shutdown()).resolves.not.toThrow();
    });
  });

  describe('calculateProbability', () => {
    beforeEach(async () => {
      await windowTimingModel.init({
        windowTimingModel: {
          volatility: {
            fallbackVol: 0.5,
          },
        },
      });
    });

    it('throws if not initialized', async () => {
      await windowTimingModel.shutdown();

      expect(() => windowTimingModel.calculateProbability(100, 100, 60000, 'btc'))
        .toThrow('not initialized');
    });

    it('throws for invalid oracle price', async () => {
      expect(() => windowTimingModel.calculateProbability(-100, 100, 60000, 'btc'))
        .toThrow('Invalid oracle price');
      expect(() => windowTimingModel.calculateProbability(0, 100, 60000, 'btc'))
        .toThrow('Invalid oracle price');
    });

    it('throws for invalid strike', async () => {
      expect(() => windowTimingModel.calculateProbability(100, -100, 60000, 'btc'))
        .toThrow('Invalid strike');
      expect(() => windowTimingModel.calculateProbability(100, 0, 60000, 'btc'))
        .toThrow('Invalid strike');
    });

    it('returns P(UP) = 0.5 when S = K and T > 0 (approximately)', async () => {
      const result = windowTimingModel.calculateProbability(100, 100, 60000, 'btc');
      expect(result.p_up).toBeCloseTo(0.5, 1);
      expect(result.p_down).toBeCloseTo(0.5, 1);
    });

    it('returns P(UP) > 0.5 when S > K', async () => {
      const result = windowTimingModel.calculateProbability(110, 100, 3600000, 'btc');
      expect(result.p_up).toBeGreaterThan(0.5);
    });

    it('returns P(UP) < 0.5 when S < K', async () => {
      const result = windowTimingModel.calculateProbability(90, 100, 3600000, 'btc');
      expect(result.p_up).toBeLessThan(0.5);
    });

    it('returns deterministic result at expiry (T = 0)', async () => {
      let result = windowTimingModel.calculateProbability(110, 100, 0, 'btc');
      expect(result.p_up).toBe(1.0);
      expect(result.p_down).toBe(0.0);

      result = windowTimingModel.calculateProbability(90, 100, 0, 'btc');
      expect(result.p_up).toBe(0.0);
      expect(result.p_down).toBe(1.0);

      result = windowTimingModel.calculateProbability(100, 100, 0, 'btc');
      expect(result.p_up).toBe(0.5);
      expect(result.p_down).toBe(0.5);
    });

    it('returns deterministic result for negative T', async () => {
      const result = windowTimingModel.calculateProbability(110, 100, -1000, 'btc');
      expect(result.p_up).toBe(1.0);
    });

    it('throws for invalid symbol', async () => {
      expect(() => windowTimingModel.calculateProbability(100, 100, 60000, 'invalid'))
        .toThrow('Invalid symbol');
    });

    it('throws for NaN oracle price', async () => {
      expect(() => windowTimingModel.calculateProbability(NaN, 100, 60000, 'btc'))
        .toThrow('Invalid oracle price');
    });

    it('throws for Infinity strike', async () => {
      expect(() => windowTimingModel.calculateProbability(100, Infinity, 60000, 'btc'))
        .toThrow('Invalid strike');
    });

    it('throws for NaN time to expiry', async () => {
      expect(() => windowTimingModel.calculateProbability(100, 100, NaN, 'btc'))
        .toThrow('Invalid time to expiry');
    });

    it('includes inputs in result', async () => {
      const result = windowTimingModel.calculateProbability(95000, 94500, 300000, 'btc');

      expect(result.inputs.S).toBe(95000);
      expect(result.inputs.K).toBe(94500);
      expect(result.inputs.T_ms).toBe(300000);
      expect(result.inputs.T_years).toBeGreaterThan(0);
      expect(result.sigma_used).toBeGreaterThan(0);
    });
  });

  describe('calculateRealizedVolatility', () => {
    beforeEach(async () => {
      await windowTimingModel.init({});
    });

    it('throws if not initialized', async () => {
      await windowTimingModel.shutdown();

      await expect(windowTimingModel.calculateRealizedVolatility('btc'))
        .rejects.toThrow('not initialized');
    });

    it('throws for invalid symbol', async () => {
      await expect(windowTimingModel.calculateRealizedVolatility('invalid'))
        .rejects.toThrow('Invalid symbol');
    });

    it('returns null when no data', async () => {
      const vol = await windowTimingModel.calculateRealizedVolatility('btc');
      expect(vol).toBeNull();
    });
  });

  describe('getVolatility', () => {
    beforeEach(async () => {
      await windowTimingModel.init({
        windowTimingModel: {
          volatility: {
            fallbackVol: 0.4,
          },
        },
      });
    });

    it('throws if not initialized', async () => {
      await windowTimingModel.shutdown();

      expect(() => windowTimingModel.getVolatility('btc'))
        .toThrow('not initialized');
    });

    it('throws for invalid symbol', async () => {
      expect(() => windowTimingModel.getVolatility('invalid'))
        .toThrow('Invalid symbol');
    });

    it('returns fallback when no data', async () => {
      const vol = windowTimingModel.getVolatility('btc');
      expect(vol).toBe(0.4);
    });
  });

  describe('detectVolatilitySurprise', () => {
    beforeEach(async () => {
      await windowTimingModel.init({
        windowTimingModel: {
          volatility: {
            surpriseThresholdHigh: 1.5,
            surpriseThresholdLow: 0.67,
          },
        },
      });
    });

    it('returns no surprise when no data', async () => {
      const result = windowTimingModel.detectVolatilitySurprise('btc');
      expect(result.isSurprise).toBe(false);
      expect(result.ratio).toBeNull();
    });
  });

  describe('Calibration Tracking', () => {
    beforeEach(async () => {
      await windowTimingModel.init({});
    });

    describe('logPrediction', () => {
      it('throws if not initialized', async () => {
        await windowTimingModel.shutdown();

        expect(() => windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-1',
          p_up: 0.75,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        })).toThrow('not initialized');
      });

      it('throws for invalid p_up (NaN)', async () => {
        expect(() => windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-nan',
          p_up: NaN,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        })).toThrow('Invalid p_up');
      });

      it('throws for p_up outside [0, 1]', async () => {
        expect(() => windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-neg',
          p_up: -0.1,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        })).toThrow('Invalid p_up');

        expect(() => windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-over',
          p_up: 1.5,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        })).toThrow('Invalid p_up');
      });

      it('throws for empty windowId', async () => {
        expect(() => windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: '',
          p_up: 0.75,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        })).toThrow('Invalid windowId');
      });

      it('throws for windowId too long', async () => {
        expect(() => windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'x'.repeat(256),
          p_up: 0.75,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        })).toThrow('Invalid windowId');
      });
    });

    describe('recordOutcome', () => {
      it('throws for invalid outcome', async () => {
        expect(() => windowTimingModel.recordOutcome('test-1', 'invalid'))
          .toThrow("Invalid outcome");
      });
    });
  });

  describe('evaluate (standard component interface)', () => {
    beforeEach(async () => {
      await windowTimingModel.init({
        windowTimingModel: {
          volatility: {
            fallbackVol: 0.5,
          },
        },
      });
    });

    it('returns probability and signal', async () => {
      const result = windowTimingModel.evaluate({
        spotPrice: 95000,
        targetPrice: 94500,
        timeToExpiry: 300000,
        symbol: 'btc',
      }, {});

      expect(result.probability).toBeDefined();
      expect(result.signal).toBeDefined();
      expect(['entry', 'exit', 'hold']).toContain(result.signal);
      expect(result.details).toBeDefined();
      expect(result.details.p_up).toBeDefined();
      expect(result.details.sigma_used).toBeDefined();
    });

    it('returns entry signal for high probability', async () => {
      const result = windowTimingModel.evaluate({
        spotPrice: 100,
        targetPrice: 50,
        timeToExpiry: 3600000,
        symbol: 'btc',
      }, {});

      expect(result.probability).toBeGreaterThan(0.7);
      expect(result.signal).toBe('entry');
    });

    it('returns exit signal for low probability', async () => {
      const result = windowTimingModel.evaluate({
        spotPrice: 50,
        targetPrice: 100,
        timeToExpiry: 3600000,
        symbol: 'btc',
      }, {});

      expect(result.probability).toBeLessThan(0.3);
      expect(result.signal).toBe('exit');
    });

    it('returns hold signal for neutral probability', async () => {
      const result = windowTimingModel.evaluate({
        spotPrice: 100,
        targetPrice: 100,
        timeToExpiry: 60000,
        symbol: 'btc',
      }, {});

      expect(result.probability).toBeGreaterThan(0.3);
      expect(result.probability).toBeLessThan(0.7);
      expect(result.signal).toBe('hold');
    });
  });

  describe('validateConfig', () => {
    it('returns valid for empty config', () => {
      const result = windowTimingModel.validateConfig({});
      expect(result.valid).toBe(true);
    });

    it('validates volatility config', () => {
      const invalid = windowTimingModel.validateConfig({
        volatility: {
          shortTermLookbackMs: -1,
        },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toContain('volatility.shortTermLookbackMs must be a positive number');
    });

    it('validates calibration config', () => {
      const invalid = windowTimingModel.validateConfig({
        calibration: {
          alertThreshold: 1.5,
        },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toContain('calibration.alertThreshold must be a number between 0 and 1');
    });

    it('validates multiple fields', () => {
      const invalid = windowTimingModel.validateConfig({
        volatility: {
          fallbackVol: -0.1,
        },
        calibration: {
          minSampleSize: 0,
        },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toHaveLength(2);
    });
  });
});
