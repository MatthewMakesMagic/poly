/**
 * Window Timing Model Tests
 *
 * Comprehensive tests for Black-Scholes N(d2) probability calculations,
 * volatility calculation, calibration tracking, and standard interface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { unlinkSync, existsSync } from 'fs';

// Import modules
import * as windowTimingModel from '../window-timing-model.js';
import * as logger from '../../../../logger/index.js';
import persistence from '../../../../../persistence/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = join(__dirname, 'test-window-timing-model.db');

describe('Window Timing Model', () => {
  beforeEach(async () => {
    // Initialize logger
    await logger.init({
      logging: { level: 'error', console: false, directory: '/tmp/test-logs' },
    });

    // Initialize persistence with test database
    await persistence.init({
      database: { path: TEST_DB_PATH },
    });

    // Create the probability_predictions table for tests
    persistence.exec(`
      CREATE TABLE IF NOT EXISTS probability_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        symbol TEXT NOT NULL,
        window_id TEXT NOT NULL,
        predicted_p_up REAL NOT NULL,
        bucket TEXT NOT NULL,
        oracle_price_at_prediction REAL,
        strike REAL,
        time_to_expiry_ms INTEGER,
        sigma_used REAL,
        vol_surprise INTEGER DEFAULT 0,
        actual_outcome TEXT,
        prediction_correct INTEGER,
        settled_at TEXT
      )
    `);

    // Create indexes
    persistence.exec('CREATE INDEX IF NOT EXISTS idx_prob_pred_timestamp ON probability_predictions(timestamp)');
    persistence.exec('CREATE INDEX IF NOT EXISTS idx_prob_pred_symbol ON probability_predictions(symbol)');
    persistence.exec('CREATE INDEX IF NOT EXISTS idx_prob_pred_bucket ON probability_predictions(bucket)');
    persistence.exec('CREATE INDEX IF NOT EXISTS idx_prob_pred_window ON probability_predictions(window_id)');
  });

  afterEach(async () => {
    await windowTimingModel.shutdown();
    await persistence.shutdown();
    await logger.shutdown();

    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      try {
        unlinkSync(TEST_DB_PATH);
      } catch {
        // Ignore cleanup errors
      }
    }

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
      // When S = K and r = 0, d2 = (-σ²/2 * T) / (σ√T) = -σ√T / 2
      // For small T and moderate σ, this is close to 0
      const d2 = windowTimingModel.calculateD2(100, 100, 0.01, 0.3, 0);
      // d2 = (0 + (0 - 0.09/2) * 0.01) / (0.3 * 0.1) = -0.00045 / 0.03 = -0.015
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
      // When S = K, d2 ≈ -σ√T/2 which is small for short T
      // So P(UP) ≈ 0.5
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
      // S > K -> P(UP) = 1
      let result = windowTimingModel.calculateProbability(110, 100, 0, 'btc');
      expect(result.p_up).toBe(1.0);
      expect(result.p_down).toBe(0.0);

      // S < K -> P(UP) = 0
      result = windowTimingModel.calculateProbability(90, 100, 0, 'btc');
      expect(result.p_up).toBe(0.0);
      expect(result.p_down).toBe(1.0);

      // S = K -> P(UP) = 0.5
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

      // Create oracle_updates table (simulating migration)
      persistence.exec(`
        CREATE TABLE IF NOT EXISTS oracle_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          previous_price REAL,
          deviation_from_previous_pct REAL,
          time_since_previous_ms INTEGER
        )
      `);
    });

    it('throws if not initialized', async () => {
      await windowTimingModel.shutdown();

      expect(() => windowTimingModel.calculateRealizedVolatility('btc'))
        .toThrow('not initialized');
    });

    it('throws for invalid symbol', async () => {
      expect(() => windowTimingModel.calculateRealizedVolatility('invalid'))
        .toThrow('Invalid symbol');
    });

    it('returns null when no data', async () => {
      const vol = windowTimingModel.calculateRealizedVolatility('btc');
      expect(vol).toBeNull();
    });

    it('returns null with only one data point', async () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price) VALUES (?, ?, ?)`,
        [new Date().toISOString(), 'btc', 50000]
      );

      const vol = windowTimingModel.calculateRealizedVolatility('btc');
      expect(vol).toBeNull();
    });

    it('calculates volatility from price history', async () => {
      const baseTime = new Date();

      // Insert 10 price updates with small random variations
      for (let i = 0; i < 10; i++) {
        const time = new Date(baseTime.getTime() - (10 - i) * 60000);
        const price = 50000 * (1 + (Math.random() - 0.5) * 0.01);
        persistence.run(
          `INSERT INTO oracle_updates (timestamp, symbol, price) VALUES (?, ?, ?)`,
          [time.toISOString(), 'btc', price]
        );
      }

      const vol = windowTimingModel.calculateRealizedVolatility('btc', 60 * 60 * 1000);
      expect(vol).not.toBeNull();
      expect(vol).toBeGreaterThan(0);
    });

    it('returns near-zero vol for constant prices', async () => {
      const baseTime = new Date();

      // Insert 10 identical price updates
      for (let i = 0; i < 10; i++) {
        const time = new Date(baseTime.getTime() - (10 - i) * 60000);
        persistence.run(
          `INSERT INTO oracle_updates (timestamp, symbol, price) VALUES (?, ?, ?)`,
          [time.toISOString(), 'btc', 50000]
        );
      }

      const vol = windowTimingModel.calculateRealizedVolatility('btc', 60 * 60 * 1000);
      expect(vol).toBe(0);
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

      // Create oracle_updates table
      persistence.exec(`
        CREATE TABLE IF NOT EXISTS oracle_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          previous_price REAL,
          deviation_from_previous_pct REAL,
          time_since_previous_ms INTEGER
        )
      `);
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

      // Create oracle_updates table
      persistence.exec(`
        CREATE TABLE IF NOT EXISTS oracle_updates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          previous_price REAL,
          deviation_from_previous_pct REAL,
          time_since_previous_ms INTEGER
        )
      `);
    });

    it('returns no surprise when no data', async () => {
      const result = windowTimingModel.detectVolatilitySurprise('btc');
      expect(result.isSurprise).toBe(false);
      expect(result.ratio).toBeNull();
    });

    it('detects volatility spike when short-term vol >> long-term vol', async () => {
      const baseTime = new Date();

      // Insert stable prices for long-term (6 hours)
      for (let i = 0; i < 50; i++) {
        const time = new Date(baseTime.getTime() - (360 - i * 7) * 60000); // 6 hours ago, every 7 min
        const price = 50000 * (1 + (Math.random() - 0.5) * 0.001); // 0.1% variation
        persistence.run(
          `INSERT INTO oracle_updates (timestamp, symbol, price) VALUES (?, ?, ?)`,
          [time.toISOString(), 'eth', price]
        );
      }

      // Insert volatile prices for short-term (15 min)
      for (let i = 0; i < 15; i++) {
        const time = new Date(baseTime.getTime() - (15 - i) * 60000); // last 15 min, every 1 min
        const price = 50000 * (1 + (Math.random() - 0.5) * 0.05); // 5% variation
        persistence.run(
          `INSERT INTO oracle_updates (timestamp, symbol, price) VALUES (?, ?, ?)`,
          [time.toISOString(), 'eth', price]
        );
      }

      const result = windowTimingModel.detectVolatilitySurprise('eth');
      // With 5% short-term variation vs 0.1% long-term, ratio should be > 1.5
      expect(result.ratio).toBeGreaterThan(1);
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

      it('logs prediction to database', async () => {
        const id = windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-1',
          p_up: 0.75,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        });

        expect(id).toBeDefined();

        const prediction = persistence.get(
          'SELECT * FROM probability_predictions WHERE window_id = ?',
          ['test-1']
        );

        expect(prediction).toBeDefined();
        expect(prediction.symbol).toBe('btc');
        expect(prediction.predicted_p_up).toBe(0.75);
        expect(prediction.bucket).toBe('70-80%');
        expect(prediction.actual_outcome).toBeNull();
      });

      it('correctly assigns bucket', async () => {
        windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-55',
          p_up: 0.55,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        });

        const prediction = persistence.get(
          'SELECT bucket FROM probability_predictions WHERE window_id = ?',
          ['test-55']
        );

        expect(prediction.bucket).toBe('50-60%');
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

      it('records outcome and determines correctness', async () => {
        // Log a prediction with p_up = 0.75 (predicted UP)
        windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-correct',
          p_up: 0.75,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        });

        // Record outcome as 'up' - should be correct
        windowTimingModel.recordOutcome('test-correct', 'up');

        const prediction = persistence.get(
          'SELECT * FROM probability_predictions WHERE window_id = ?',
          ['test-correct']
        );

        expect(prediction.actual_outcome).toBe('up');
        expect(prediction.prediction_correct).toBe(1);
        expect(prediction.settled_at).toBeDefined();
      });

      it('marks incorrect prediction', async () => {
        // Log a prediction with p_up = 0.75 (predicted UP)
        windowTimingModel.logPrediction({
          symbol: 'btc',
          windowId: 'test-wrong',
          p_up: 0.75,
          oraclePrice: 50000,
          strike: 49500,
          timeToExpiryMs: 300000,
          sigma: 0.5,
        });

        // Record outcome as 'down' - should be incorrect
        windowTimingModel.recordOutcome('test-wrong', 'down');

        const prediction = persistence.get(
          'SELECT * FROM probability_predictions WHERE window_id = ?',
          ['test-wrong']
        );

        expect(prediction.actual_outcome).toBe('down');
        expect(prediction.prediction_correct).toBe(0);
      });

      it('returns no update for non-existent window', async () => {
        const result = windowTimingModel.recordOutcome('non-existent', 'up');
        expect(result.updated).toBe(0);
      });
    });

    describe('getCalibration', () => {
      it('returns empty stats when no predictions', async () => {
        const calibration = windowTimingModel.getCalibration();

        expect(calibration.total_predictions).toBe(0);
        expect(Object.keys(calibration.buckets)).toHaveLength(0);
      });

      it('calculates bucket statistics', async () => {
        // Log and settle multiple predictions
        for (let i = 0; i < 5; i++) {
          windowTimingModel.logPrediction({
            symbol: 'btc',
            windowId: `cal-test-${i}`,
            p_up: 0.75, // 70-80% bucket
            oraclePrice: 50000,
            strike: 49500,
            timeToExpiryMs: 300000,
            sigma: 0.5,
          });

          // 3 correct, 2 incorrect
          windowTimingModel.recordOutcome(`cal-test-${i}`, i < 3 ? 'up' : 'down');
        }

        const calibration = windowTimingModel.getCalibration();

        expect(calibration.total_predictions).toBe(5);
        expect(calibration.buckets['70-80%']).toBeDefined();
        expect(calibration.buckets['70-80%'].count).toBe(5);
        expect(calibration.buckets['70-80%'].hits).toBe(3);
        expect(calibration.buckets['70-80%'].hit_rate).toBe(0.6);
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
      // Very high S relative to K should give high p_up
      const result = windowTimingModel.evaluate({
        spotPrice: 100,
        targetPrice: 50, // S >> K
        timeToExpiry: 3600000,
        symbol: 'btc',
      }, {});

      expect(result.probability).toBeGreaterThan(0.7);
      expect(result.signal).toBe('entry');
    });

    it('returns exit signal for low probability', async () => {
      // Very low S relative to K should give low p_up
      const result = windowTimingModel.evaluate({
        spotPrice: 50,
        targetPrice: 100, // S << K
        timeToExpiry: 3600000,
        symbol: 'btc',
      }, {});

      expect(result.probability).toBeLessThan(0.3);
      expect(result.signal).toBe('exit');
    });

    it('returns hold signal for neutral probability', async () => {
      // S = K should give p_up ≈ 0.5
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
          alertThreshold: 1.5, // Must be 0-1
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
