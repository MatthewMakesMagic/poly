/**
 * Oracle Update Predictor Tests
 *
 * Unit tests for the OracleUpdatePredictor class.
 * Tests prediction algorithm, bucket matching, confidence intervals, and pattern analysis.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleUpdatePredictor } from '../predictor.js';
import { DEFAULT_CONFIG } from '../types.js';

describe('OracleUpdatePredictor', () => {
  let predictor;

  beforeEach(() => {
    predictor = new OracleUpdatePredictor({ config: DEFAULT_CONFIG });
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      expect(predictor.config).toBeDefined();
      expect(predictor.config.minHistoricalUpdates).toBe(20);
      expect(predictor.config.confidenceLevel).toBe(0.95);
    });

    it('should allow custom config override', () => {
      const customPredictor = new OracleUpdatePredictor({
        config: { minHistoricalUpdates: 10 },
      });
      expect(customPredictor.config.minHistoricalUpdates).toBe(10);
    });
  });

  describe('getPrediction', () => {
    const mockPatterns = {
      symbol: 'btc',
      totalUpdates: 100,
      avgUpdateIntervalMs: 15000, // 15 seconds average
      buckets: {
        '0-10s:micro': { name: '0-10s:micro', updates: 5, total: 20, updateRate: 0.25 },
        '0-10s:small': { name: '0-10s:small', updates: 8, total: 25, updateRate: 0.32 },
        '10-30s:micro': { name: '10-30s:micro', updates: 12, total: 30, updateRate: 0.4 },
        '10-30s:small': { name: '10-30s:small', updates: 15, total: 35, updateRate: 0.43 },
        '>5m:extreme': { name: '>5m:extreme', updates: 2, total: 5, updateRate: 0.4 },
      },
    };

    it('should return prediction with all required fields', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.0005,
        patterns: mockPatterns,
      });

      expect(result).toHaveProperty('p_update');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('inputs_used');
      expect(result.confidence).toHaveProperty('low');
      expect(result.confidence).toHaveProperty('high');
    });

    it('should return 0 probability when time to expiry is 0', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 0,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.001,
        patterns: mockPatterns,
      });

      expect(result.p_update).toBe(0);
      expect(result.edge_case).toBe('expiry');
    });

    it('should return 0 probability when time to expiry is negative', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: -1000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.001,
        patterns: mockPatterns,
      });

      expect(result.p_update).toBe(0);
      expect(result.edge_case).toBe('expiry');
    });

    it('should return 0.5 when insufficient historical data', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.001,
        patterns: { totalUpdates: 5, avgUpdateIntervalMs: 10000, buckets: {} },
      });

      expect(result.p_update).toBe(0.5);
      expect(result.edge_case).toBe('insufficient_data');
    });

    it('should return 0.5 when patterns are null', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.001,
        patterns: null,
      });

      expect(result.p_update).toBe(0.5);
      expect(result.edge_case).toBe('insufficient_data');
    });

    it('should increase probability with more time to expiry', () => {
      const shortTime = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 10000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.0005,
        patterns: mockPatterns,
      });

      const longTime = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 60000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.0005,
        patterns: mockPatterns,
      });

      expect(longTime.p_update).toBeGreaterThan(shortTime.p_update);
    });

    it('should return probability between 0 and 1', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 300000, // 5 minutes
        timeSinceLastUpdateMs: 60000,
        currentDeviationPct: 0.01,
        patterns: mockPatterns,
      });

      expect(result.p_update).toBeGreaterThanOrEqual(0);
      expect(result.p_update).toBeLessThanOrEqual(1);
    });

    it('should handle zero avgUpdateIntervalMs gracefully', () => {
      const patternsWithZeroInterval = {
        ...mockPatterns,
        avgUpdateIntervalMs: 0,
      };

      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.0005,
        patterns: patternsWithZeroInterval,
      });

      // Should fall back to base probability
      expect(result.p_update).toBeGreaterThanOrEqual(0);
      expect(result.p_update).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result.p_update)).toBe(true);
    });

    it('should handle NaN avgUpdateIntervalMs gracefully', () => {
      const patternsWithNaN = {
        ...mockPatterns,
        avgUpdateIntervalMs: NaN,
      };

      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: 30000,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.0005,
        patterns: patternsWithNaN,
      });

      expect(Number.isFinite(result.p_update)).toBe(true);
    });

    it('should handle extremely large timeToExpiryMs', () => {
      const result = predictor.getPrediction({
        symbol: 'btc',
        timeToExpiryMs: Number.MAX_SAFE_INTEGER,
        timeSinceLastUpdateMs: 5000,
        currentDeviationPct: 0.0005,
        patterns: mockPatterns,
      });

      // Should return 1.0 (near-certain update with infinite time)
      expect(result.p_update).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result.p_update)).toBe(true);
    });
  });

  describe('findTimeBucket', () => {
    it('should return 0-10s bucket for 5000ms', () => {
      const bucket = predictor.findTimeBucket(5000);
      expect(bucket.name).toBe('0-10s');
    });

    it('should return 10-30s bucket for 20000ms', () => {
      const bucket = predictor.findTimeBucket(20000);
      expect(bucket.name).toBe('10-30s');
    });

    it('should return 30s-1m bucket for 45000ms', () => {
      const bucket = predictor.findTimeBucket(45000);
      expect(bucket.name).toBe('30s-1m');
    });

    it('should return >5m bucket for very large values', () => {
      const bucket = predictor.findTimeBucket(600000);
      expect(bucket.name).toBe('>5m');
    });

    it('should return 0-10s bucket for 0ms', () => {
      const bucket = predictor.findTimeBucket(0);
      expect(bucket.name).toBe('0-10s');
    });
  });

  describe('findDeviationBucket', () => {
    it('should return micro bucket for 0.0005', () => {
      const bucket = predictor.findDeviationBucket(0.0005);
      expect(bucket.name).toBe('micro');
    });

    it('should return small bucket for 0.002', () => {
      const bucket = predictor.findDeviationBucket(0.002);
      expect(bucket.name).toBe('small');
    });

    it('should return medium bucket for 0.004', () => {
      const bucket = predictor.findDeviationBucket(0.004);
      expect(bucket.name).toBe('medium');
    });

    it('should return large bucket for 0.007', () => {
      const bucket = predictor.findDeviationBucket(0.007);
      expect(bucket.name).toBe('large');
    });

    it('should return extreme bucket for 0.02', () => {
      const bucket = predictor.findDeviationBucket(0.02);
      expect(bucket.name).toBe('extreme');
    });

    it('should handle negative deviation (take absolute value)', () => {
      const bucket = predictor.findDeviationBucket(-0.002);
      expect(bucket.name).toBe('small');
    });
  });

  describe('wilsonConfidence', () => {
    it('should return [0, 1] for zero samples', () => {
      const result = predictor.wilsonConfidence(0, 0, 0.95);
      expect(result.low).toBe(0);
      expect(result.high).toBe(1);
    });

    it('should return narrow interval for large sample size', () => {
      const result = predictor.wilsonConfidence(50, 100, 0.95);
      expect(result.low).toBeGreaterThan(0.3);
      expect(result.high).toBeLessThan(0.7);
    });

    it('should return wide interval for small sample size', () => {
      const result = predictor.wilsonConfidence(5, 10, 0.95);
      expect(result.high - result.low).toBeGreaterThan(0.3);
    });

    it('should clamp low to 0', () => {
      const result = predictor.wilsonConfidence(0, 5, 0.95);
      expect(result.low).toBe(0);
    });

    it('should clamp high to 1', () => {
      const result = predictor.wilsonConfidence(5, 5, 0.95);
      expect(result.high).toBeLessThanOrEqual(1);
    });
  });

  describe('analyzePatterns', () => {
    it('should return null for insufficient data', () => {
      const updates = Array(10).fill({
        time_since_previous_ms: 10000,
        deviation_from_previous_pct: 0.001,
      });

      const result = predictor.analyzePatterns(updates, 'btc');
      expect(result).toBeNull();
    });

    it('should return patterns for sufficient data', () => {
      const updates = Array(30).fill({
        time_since_previous_ms: 15000,
        deviation_from_previous_pct: 0.002,
      });

      const result = predictor.analyzePatterns(updates, 'btc');
      expect(result).not.toBeNull();
      expect(result.symbol).toBe('btc');
      expect(result.totalUpdates).toBe(30);
    });

    it('should calculate average update interval', () => {
      const updates = [
        { time_since_previous_ms: 10000, deviation_from_previous_pct: 0.001 },
        { time_since_previous_ms: 20000, deviation_from_previous_pct: 0.002 },
        { time_since_previous_ms: 15000, deviation_from_previous_pct: 0.001 },
      ];
      // Add more to meet minimum
      for (let i = 0; i < 20; i++) {
        updates.push({ time_since_previous_ms: 15000, deviation_from_previous_pct: 0.001 });
      }

      const result = predictor.analyzePatterns(updates, 'btc');
      expect(result.avgUpdateIntervalMs).toBeGreaterThan(0);
    });

    it('should create bucket matrix', () => {
      const updates = Array(25).fill({
        time_since_previous_ms: 5000,
        deviation_from_previous_pct: 0.0005,
      });

      const result = predictor.analyzePatterns(updates, 'btc');
      expect(result.buckets).toBeDefined();
      expect(Object.keys(result.buckets).length).toBeGreaterThan(0);
    });

    it('should count updates in correct buckets', () => {
      const updates = [];
      // 10 updates in 0-10s time bucket with micro deviation
      for (let i = 0; i < 25; i++) {
        updates.push({ time_since_previous_ms: 5000, deviation_from_previous_pct: 0.0005 });
      }

      const result = predictor.analyzePatterns(updates, 'btc');
      const bucket = result.buckets['0-10s:micro'];
      expect(bucket).toBeDefined();
      expect(bucket.updates).toBe(25);
    });

    it('should handle null time_since_previous_ms', () => {
      const updates = Array(25).fill({
        time_since_previous_ms: null,
        deviation_from_previous_pct: 0.001,
      });

      const result = predictor.analyzePatterns(updates, 'btc');
      expect(result).not.toBeNull();
    });

    it('should return null when bucket config is empty', () => {
      const predictorWithEmptyBuckets = new OracleUpdatePredictor({
        config: {
          ...DEFAULT_CONFIG,
          buckets: {
            timeSinceLast: [],
            deviation: [],
          },
        },
      });

      const updates = Array(25).fill({
        time_since_previous_ms: 5000,
        deviation_from_previous_pct: 0.001,
      });

      const result = predictorWithEmptyBuckets.analyzePatterns(updates, 'btc');
      expect(result).toBeNull();
    });

    it('should return null when timeSinceLast buckets is missing', () => {
      const predictorWithNoBuckets = new OracleUpdatePredictor({
        config: {
          ...DEFAULT_CONFIG,
          buckets: {
            timeSinceLast: null,
            deviation: DEFAULT_CONFIG.buckets.deviation,
          },
        },
      });

      const updates = Array(25).fill({
        time_since_previous_ms: 5000,
        deviation_from_previous_pct: 0.001,
      });

      const result = predictorWithNoBuckets.analyzePatterns(updates, 'btc');
      expect(result).toBeNull();
    });
  });

  describe('assignCalibrationBucket', () => {
    it('should assign 0-10% bucket for 0.05', () => {
      const bucket = predictor.assignCalibrationBucket(0.05);
      expect(bucket).toBe('0-10%');
    });

    it('should assign 50-60% bucket for 0.55', () => {
      const bucket = predictor.assignCalibrationBucket(0.55);
      expect(bucket).toBe('50-60%');
    });

    it('should assign 90-100% bucket for 0.95', () => {
      const bucket = predictor.assignCalibrationBucket(0.95);
      expect(bucket).toBe('90-100%');
    });

    it('should assign 90-100% bucket for 1.0', () => {
      const bucket = predictor.assignCalibrationBucket(1.0);
      expect(bucket).toBe('90-100%');
    });

    it('should assign 0-10% bucket for 0.0', () => {
      const bucket = predictor.assignCalibrationBucket(0.0);
      expect(bucket).toBe('0-10%');
    });
  });

  describe('pattern cache', () => {
    it('should initially have empty cache', () => {
      expect(predictor.isCacheValid('btc')).toBe(false);
    });

    it('should update cache with patterns', () => {
      const patterns = { symbol: 'btc', totalUpdates: 50 };
      predictor.updateCache('btc', patterns);
      expect(predictor.isCacheValid('btc')).toBe(true);
    });

    it('should retrieve cached patterns', () => {
      const patterns = { symbol: 'btc', totalUpdates: 50, test: 'value' };
      predictor.updateCache('btc', patterns);
      const cached = predictor.getCachedPatterns('btc');
      expect(cached.test).toBe('value');
    });

    it('should clear cache', () => {
      predictor.updateCache('btc', { symbol: 'btc' });
      predictor.clearCache();
      expect(predictor.getCachedPatterns('btc')).toBeNull();
    });
  });

  describe('getZScore', () => {
    it('should return 1.645 for 90% confidence', () => {
      expect(predictor.getZScore(0.90)).toBe(1.645);
    });

    it('should return 1.96 for 95% confidence', () => {
      expect(predictor.getZScore(0.95)).toBe(1.96);
    });

    it('should return 2.576 for 99% confidence', () => {
      expect(predictor.getZScore(0.99)).toBe(2.576);
    });

    it('should return 1.96 as default for unknown confidence', () => {
      expect(predictor.getZScore(0.85)).toBe(1.96);
    });
  });
});
