/**
 * Oracle Predictor Calibration Tests
 *
 * Tests for prediction logging, outcome recording, and calibration tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as oraclePredictor from '../index.js';
import { OraclePredictorError, OraclePredictorErrorCodes } from '../types.js';
import persistence from '../../../persistence/index.js';

// Mock dependencies
vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../persistence/index.js', () => ({
  default: {
    all: vi.fn(() => []),
    get: vi.fn(() => null),
    run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  },
}));

vi.mock('../../oracle-tracker/index.js', () => ({
  getState: vi.fn(() => ({
    initialized: true,
    tracking: {
      btc: { last_price: 95000, last_update_at: new Date().toISOString(), updates_recorded: 100 },
      eth: { last_price: 3200, last_update_at: new Date().toISOString(), updates_recorded: 100 },
      sol: { last_price: 150, last_update_at: new Date().toISOString(), updates_recorded: 100 },
      xrp: { last_price: 2.50, last_update_at: new Date().toISOString(), updates_recorded: 100 },
    },
  })),
}));

describe('oracle-predictor calibration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try {
      await oraclePredictor.shutdown();
    } catch {
      // Ignore
    }
    await oraclePredictor.init();
  });

  afterEach(async () => {
    try {
      await oraclePredictor.shutdown();
    } catch {
      // Ignore
    }
  });

  describe('logPrediction', () => {
    it('should log a valid prediction', () => {
      const result = oraclePredictor.logPrediction({
        symbol: 'btc',
        windowId: 'test-window-123',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 0.45,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      });

      expect(result).toBe(1);
      expect(persistence.run).toHaveBeenCalled();
    });

    it('should throw for invalid symbol', () => {
      expect(() => oraclePredictor.logPrediction({
        symbol: 'invalid',
        windowId: 'test-window',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 0.45,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      })).toThrow(OraclePredictorError);
    });

    it('should throw for invalid probability (> 1)', () => {
      expect(() => oraclePredictor.logPrediction({
        symbol: 'btc',
        windowId: 'test-window',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 1.5,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      })).toThrow(OraclePredictorError);
    });

    it('should throw for invalid probability (< 0)', () => {
      expect(() => oraclePredictor.logPrediction({
        symbol: 'btc',
        windowId: 'test-window',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: -0.1,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      })).toThrow(OraclePredictorError);
    });

    it('should throw for NaN probability', () => {
      expect(() => oraclePredictor.logPrediction({
        symbol: 'btc',
        windowId: 'test-window',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: NaN,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      })).toThrow(OraclePredictorError);
    });

    it('should allow logging without windowId', () => {
      const result = oraclePredictor.logPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 0.45,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      });

      expect(result).toBe(1);
    });

    it('should assign calibration bucket correctly', () => {
      oraclePredictor.logPrediction({
        symbol: 'btc',
        windowId: 'test-window',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 0.75, // Should be 70-80% bucket
        confidence: { low: 0.65, high: 0.85 },
        bucket: '10-30s:small',
      });

      // Verify the run call includes correct bucket
      const runCall = persistence.run.mock.calls[0];
      const params = runCall[1];
      // bucket is at index 9 in the params array
      expect(params[9]).toBe('70-80%');
    });

    it('should throw PERSISTENCE_ERROR when database insert fails', () => {
      persistence.run.mockImplementationOnce(() => {
        throw new Error('Database write failed');
      });

      expect(() => oraclePredictor.logPrediction({
        symbol: 'btc',
        windowId: 'test-window',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 0.45,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      })).toThrow(OraclePredictorError);

      try {
        persistence.run.mockImplementationOnce(() => {
          throw new Error('Database write failed');
        });
        oraclePredictor.logPrediction({
          symbol: 'btc',
          windowId: 'test-window-2',
          timeToExpiryMs: 30000,
          timeSinceLastUpdateMs: 15000,
          currentDeviationPct: 0.002,
          predictedPUpdate: 0.45,
          confidence: { low: 0.35, high: 0.55 },
          bucket: '10-30s:small',
        });
      } catch (err) {
        expect(err.code).toBe(OraclePredictorErrorCodes.PERSISTENCE_ERROR);
      }
    });
  });

  describe('recordOutcome', () => {
    it('should record outcome when prediction exists', () => {
      persistence.get.mockReturnValueOnce({
        id: 1,
        predicted_p_update: 0.6,
      });

      const result = oraclePredictor.recordOutcome('test-window-123', true);

      expect(result.updated).toBe(1);
      expect(result.predictionCorrect).toBe(true);
      expect(persistence.run).toHaveBeenCalled();
    });

    it('should return updated=0 when prediction not found', () => {
      persistence.get.mockReturnValueOnce(null);

      const result = oraclePredictor.recordOutcome('nonexistent-window', true);

      expect(result.updated).toBe(0);
      expect(result.predictionCorrect).toBeNull();
    });

    it('should throw for empty windowId', () => {
      expect(() => oraclePredictor.recordOutcome('', true))
        .toThrow(OraclePredictorError);
    });

    it('should throw for non-boolean updateOccurred', () => {
      expect(() => oraclePredictor.recordOutcome('test-window', 'yes'))
        .toThrow(OraclePredictorError);
    });

    it('should determine prediction correctness - high probability, update occurred', () => {
      persistence.get.mockReturnValueOnce({
        id: 1,
        predicted_p_update: 0.7, // > 0.5, predicted update likely
      });

      const result = oraclePredictor.recordOutcome('test-window', true);
      expect(result.predictionCorrect).toBe(true);
    });

    it('should determine prediction correctness - high probability, no update', () => {
      persistence.get.mockReturnValueOnce({
        id: 1,
        predicted_p_update: 0.7, // > 0.5, predicted update likely
      });

      const result = oraclePredictor.recordOutcome('test-window', false);
      expect(result.predictionCorrect).toBe(false);
    });

    it('should determine prediction correctness - low probability, update occurred', () => {
      persistence.get.mockReturnValueOnce({
        id: 1,
        predicted_p_update: 0.3, // < 0.5, predicted update unlikely
      });

      const result = oraclePredictor.recordOutcome('test-window', true);
      expect(result.predictionCorrect).toBe(false);
    });

    it('should determine prediction correctness - low probability, no update', () => {
      persistence.get.mockReturnValueOnce({
        id: 1,
        predicted_p_update: 0.3, // < 0.5, predicted update unlikely
      });

      const result = oraclePredictor.recordOutcome('test-window', false);
      expect(result.predictionCorrect).toBe(true);
    });
  });

  describe('getCalibration', () => {
    it('should return calibration stats', () => {
      persistence.get
        .mockReturnValueOnce({ count: 100 })  // total predictions
        .mockReturnValueOnce({ count: 50 });  // settled predictions
      persistence.all.mockReturnValueOnce([
        { bucket: '40-50%', count: 20, updates_occurred: 9, avg_predicted: 0.45 },
        { bucket: '50-60%', count: 15, updates_occurred: 8, avg_predicted: 0.55 },
      ]);

      const result = oraclePredictor.getCalibration();

      expect(result.total_predictions).toBe(100);
      expect(result.settled_predictions).toBe(50);
      expect(result.buckets['40-50%']).toBeDefined();
      expect(result.buckets['50-60%']).toBeDefined();
    });

    it('should calculate actual rate correctly', () => {
      persistence.get
        .mockReturnValueOnce({ count: 100 })
        .mockReturnValueOnce({ count: 50 });
      persistence.all.mockReturnValueOnce([
        { bucket: '50-60%', count: 20, updates_occurred: 11, avg_predicted: 0.55 },
      ]);

      const result = oraclePredictor.getCalibration();
      const bucket = result.buckets['50-60%'];

      expect(bucket.actual_rate).toBeCloseTo(11 / 20, 2);
    });

    it('should calculate calibration error', () => {
      persistence.get
        .mockReturnValueOnce({ count: 100 })
        .mockReturnValueOnce({ count: 50 });
      persistence.all.mockReturnValueOnce([
        { bucket: '50-60%', count: 20, updates_occurred: 10, avg_predicted: 0.55 },
      ]);

      const result = oraclePredictor.getCalibration();
      const bucket = result.buckets['50-60%'];

      // Expected rate for 50-60% bucket is 0.55 (midpoint)
      // Actual rate is 10/20 = 0.50
      // Error = |0.55 - 0.50| = 0.05
      expect(bucket.error).toBeCloseTo(0.05, 2);
    });

    it('should return empty buckets when no data', () => {
      persistence.get
        .mockReturnValueOnce({ count: 0 })
        .mockReturnValueOnce({ count: 0 });
      persistence.all.mockReturnValueOnce([]);

      const result = oraclePredictor.getCalibration();

      expect(result.total_predictions).toBe(0);
      expect(Object.keys(result.buckets).length).toBe(0);
    });

    it('should calculate average calibration error', () => {
      persistence.get
        .mockReturnValueOnce({ count: 100 })
        .mockReturnValueOnce({ count: 50 });
      persistence.all.mockReturnValueOnce([
        { bucket: '40-50%', count: 20, updates_occurred: 9, avg_predicted: 0.45 },
        { bucket: '50-60%', count: 20, updates_occurred: 11, avg_predicted: 0.55 },
      ]);

      const result = oraclePredictor.getCalibration();

      // Both buckets have count >= 10, so both contribute to avg_error
      expect(result.avg_error).toBeDefined();
      expect(typeof result.avg_error).toBe('number');
    });
  });

  describe('state tracking', () => {
    it('should increment predictionsLogged after logging', () => {
      oraclePredictor.logPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 15000,
        currentDeviationPct: 0.002,
        predictedPUpdate: 0.45,
        confidence: { low: 0.35, high: 0.55 },
        bucket: '10-30s:small',
      });

      const state = oraclePredictor.getState();
      expect(state.stats.predictionsLogged).toBe(1);
    });

    it('should increment outcomesRecorded after recording', () => {
      persistence.get.mockReturnValueOnce({
        id: 1,
        predicted_p_update: 0.5,
      });

      oraclePredictor.recordOutcome('test-window', true);

      const state = oraclePredictor.getState();
      expect(state.stats.outcomesRecorded).toBe(1);
    });

    it('should increment calibrationChecks after getting calibration', () => {
      persistence.get
        .mockReturnValueOnce({ count: 0 })
        .mockReturnValueOnce({ count: 0 });
      persistence.all.mockReturnValueOnce([]);

      oraclePredictor.getCalibration();

      // Note: getState() also calls getCalibration() internally, so count will be 2
      const state = oraclePredictor.getState();
      expect(state.stats.calibrationChecks).toBeGreaterThanOrEqual(1);
    });
  });
});
