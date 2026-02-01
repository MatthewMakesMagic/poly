/**
 * Lag Tracker Core Logic Tests
 *
 * Tests for cross-correlation, optimal lag finder, p-value calculation,
 * and price buffer functionality.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PriceBuffer,
  calculateCrossCorrelation,
  findOptimalLag,
  calculatePValue,
  normalCDF,
  LagTracker,
} from '../tracker.js';
import { DEFAULT_CONFIG } from '../types.js';

describe('PriceBuffer', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PriceBuffer(60000, 1000);
  });

  it('should add prices with timestamps', () => {
    const now = Date.now();
    buffer.add(100, now);
    buffer.add(101, now + 100);

    expect(buffer.length).toBe(2);
  });

  it('should reject invalid price values', () => {
    const now = Date.now();

    expect(buffer.add(NaN, now)).toBe(false);
    expect(buffer.add(Infinity, now)).toBe(false);
    expect(buffer.add(-100, now)).toBe(false);
    expect(buffer.add(0, now)).toBe(false);
    expect(buffer.add('100', now)).toBe(false);
    expect(buffer.add(null, now)).toBe(false);

    expect(buffer.length).toBe(0);
  });

  it('should reject invalid timestamp values', () => {
    expect(buffer.add(100, NaN)).toBe(false);
    expect(buffer.add(100, Infinity)).toBe(false);
    expect(buffer.add(100, 'now')).toBe(false);

    expect(buffer.length).toBe(0);
  });

  it('should remove old entries beyond maxAgeMs during cleanup', () => {
    const now = Date.now();
    buffer.add(100, now - 70000); // 70 seconds ago

    // Force cleanup by adding enough entries to trigger it
    // cleanupInterval is 50, so add 50 more entries
    for (let i = 0; i < 50; i++) {
      buffer.add(100 + i, now + i);
    }

    // Old entry should now be removed
    const all = buffer.getAll();
    const hasOldEntry = all.some(p => p.timestamp === now - 70000);
    expect(hasOldEntry).toBe(false);
  });

  it('should limit size to maxSize', () => {
    const smallBuffer = new PriceBuffer(60000, 5);
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      smallBuffer.add(100 + i, now + i);
    }

    expect(smallBuffer.length).toBe(5);
  });

  it('should get range of prices', () => {
    const now = Date.now();
    buffer.add(100, now - 5000);
    buffer.add(101, now - 3000);
    buffer.add(102, now - 1000);
    buffer.add(103, now);

    const range = buffer.getRange(now - 4000, now - 500);
    expect(range.length).toBe(2);
    expect(range[0].price).toBe(101);
    expect(range[1].price).toBe(102);
  });

  it('should find closest point within tolerance', () => {
    const now = Date.now();
    buffer.add(100, now - 1000);
    buffer.add(101, now);

    const closest = buffer.findClosest(now - 50, 100);
    expect(closest).not.toBeNull();
    expect(closest.price).toBe(101);
  });

  it('should return null if no point within tolerance', () => {
    const now = Date.now();
    buffer.add(100, now);

    const closest = buffer.findClosest(now - 500, 100);
    expect(closest).toBeNull();
  });

  it('should clear all entries', () => {
    const now = Date.now();
    buffer.add(100, now);
    buffer.add(101, now + 100);

    buffer.clear();
    expect(buffer.length).toBe(0);
  });
});

describe('normalCDF', () => {
  it('should return 0.5 for x = 0', () => {
    const result = normalCDF(0);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('should return ~0.8413 for x = 1', () => {
    const result = normalCDF(1);
    expect(result).toBeCloseTo(0.8413, 2);
  });

  it('should return ~0.9772 for x = 2', () => {
    const result = normalCDF(2);
    expect(result).toBeCloseTo(0.9772, 2);
  });

  it('should return ~0.0228 for x = -2', () => {
    const result = normalCDF(-2);
    expect(result).toBeCloseTo(0.0228, 2);
  });

  it('should approach 1 for large positive x', () => {
    const result = normalCDF(5);
    expect(result).toBeGreaterThan(0.999999);
  });

  it('should approach 0 for large negative x', () => {
    const result = normalCDF(-5);
    expect(result).toBeLessThan(0.000001);
  });

  it('should clamp to 1 for x > 8 (boundary)', () => {
    const result = normalCDF(8.1);
    expect(result).toBe(1);
  });

  it('should clamp to 0 for x < -8 (boundary)', () => {
    const result = normalCDF(-8.1);
    expect(result).toBe(0);
  });

  it('should return value near 1 for x = 8', () => {
    const result = normalCDF(8);
    expect(result).toBeGreaterThan(0.999999999);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should return value near 0 for x = -8', () => {
    const result = normalCDF(-8);
    expect(result).toBeLessThan(0.000000001);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe('calculateCrossCorrelation', () => {
  it('should return 1.0 for perfectly correlated series', () => {
    const now = Date.now();
    const seriesA = [];
    const seriesB = [];

    for (let i = 0; i < 20; i++) {
      const t = now + i * 100;
      seriesA.push({ price: 100 + i, timestamp: t });
      seriesB.push({ price: 100 + i, timestamp: t });
    }

    const result = calculateCrossCorrelation(seriesA, seriesB, 0, 100);
    expect(result).not.toBeNull();
    expect(result.correlation).toBeCloseTo(1.0, 5);
    expect(result.sampleSize).toBe(20);
  });

  it('should return -1.0 for perfectly negatively correlated series', () => {
    const now = Date.now();
    const seriesA = [];
    const seriesB = [];

    for (let i = 0; i < 20; i++) {
      const t = now + i * 100;
      seriesA.push({ price: 100 + i, timestamp: t });
      seriesB.push({ price: 120 - i, timestamp: t });
    }

    const result = calculateCrossCorrelation(seriesA, seriesB, 0, 100);
    expect(result).not.toBeNull();
    expect(result.correlation).toBeCloseTo(-1.0, 5);
  });

  it('should return ~0 for uncorrelated series', () => {
    const now = Date.now();
    const seriesA = [];
    const seriesB = [];

    // Use deterministic "random" pattern
    const aValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const bValues = [10, 2, 15, 8, 3, 19, 7, 14, 1, 16, 5, 11, 20, 6, 13, 4, 18, 9, 12, 17];

    for (let i = 0; i < 20; i++) {
      const t = now + i * 100;
      seriesA.push({ price: aValues[i], timestamp: t });
      seriesB.push({ price: bValues[i], timestamp: t });
    }

    const result = calculateCrossCorrelation(seriesA, seriesB, 0, 100);
    expect(result).not.toBeNull();
    expect(Math.abs(result.correlation)).toBeLessThan(0.3);
  });

  it('should return high correlation at correct lag offset', () => {
    const now = Date.now();
    const seriesA = [];
    const seriesB = [];

    // A leads B by 1000ms
    for (let i = 0; i < 30; i++) {
      const t = now + i * 100;
      seriesA.push({ price: 100 + i, timestamp: t });
      seriesB.push({ price: 100 + i, timestamp: t + 1000 }); // B is 1 second behind
    }

    // At tau = 1000ms, A(t) should correlate with B(t + 1000)
    const result = calculateCrossCorrelation(seriesA, seriesB, 1000, 100);
    expect(result).not.toBeNull();
    expect(result.correlation).toBeGreaterThan(0.9);
  });

  it('should return null for insufficient data', () => {
    const now = Date.now();
    const seriesA = [{ price: 100, timestamp: now }];
    const seriesB = [{ price: 100, timestamp: now }];

    const result = calculateCrossCorrelation(seriesA, seriesB, 0, 100);
    expect(result).toBeNull();
  });
});

describe('calculatePValue', () => {
  it('should return low p-value for high correlation with large sample', () => {
    const pValue = calculatePValue(0.8, 100);
    expect(pValue).toBeLessThan(0.01);
  });

  it('should return high p-value for low correlation with small sample', () => {
    const pValue = calculatePValue(0.2, 10);
    expect(pValue).toBeGreaterThan(0.05);
  });

  it('should return 1 for sample size < 3', () => {
    const pValue = calculatePValue(0.9, 2);
    expect(pValue).toBe(1);
  });

  it('should return 0 for perfect correlation', () => {
    const pValue = calculatePValue(1.0, 50);
    expect(pValue).toBe(0);
  });

  it('should return 0 for near-perfect correlation due to floating point', () => {
    // Test r² slightly > 1 due to floating point
    const pValue = calculatePValue(1.0000000001, 50);
    expect(pValue).toBe(0);
  });

  it('should be symmetric for positive and negative correlations', () => {
    const pValuePos = calculatePValue(0.7, 50);
    const pValueNeg = calculatePValue(-0.7, 50);
    expect(pValuePos).toBeCloseTo(pValueNeg, 5);
  });
});

describe('findOptimalLag', () => {
  it('should identify tau* with highest absolute correlation', () => {
    // Use buffers with no age limit (very high maxAge) to isolate the correlation logic
    const spotBuffer = new PriceBuffer(1000000, 2000);
    const oracleBuffer = new PriceBuffer(1000000, 2000);

    // Create data where spot leads oracle by 2000ms
    // Both series have the same pattern, oracle is shifted in time
    const baseTime = Date.now();

    // First add all spot data
    for (let i = 0; i < 100; i++) {
      const t = baseTime + i * 50;
      const price = 100 + i;
      spotBuffer.buffer.push({ price, timestamp: t }); // Direct push to avoid age-based removal
    }

    // Add oracle data - same prices at later timestamps
    for (let i = 0; i < 100; i++) {
      const t = baseTime + 2000 + i * 50;
      const price = 100 + i;
      oracleBuffer.buffer.push({ price, timestamp: t }); // Direct push
    }

    // With tau=2000, for oracle at (baseTime + 2000), we should find spot at baseTime
    const result = findOptimalLag(spotBuffer, oracleBuffer, [500, 1000, 2000, 5000], 100);

    expect(result).not.toBeNull();
    expect(result.tau_star_ms).toBe(2000);
    expect(result.correlation).toBeGreaterThan(0.8);
  });

  it('should return null if insufficient data', () => {
    const spotBuffer = new PriceBuffer(60000, 1000);
    const oracleBuffer = new PriceBuffer(60000, 1000);

    const now = Date.now();
    spotBuffer.add(100, now);
    oracleBuffer.add(100, now);

    const result = findOptimalLag(spotBuffer, oracleBuffer, [500, 1000, 2000]);
    expect(result).toBeNull();
  });
});

describe('LagTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new LagTracker({
      ...DEFAULT_CONFIG,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    });
  });

  describe('handleSpotTick', () => {
    it('should add price to spot buffer for symbol', () => {
      const tick = {
        symbol: 'btc',
        price: 95000,
        timestamp: Date.now(),
      };

      tracker.handleSpotTick(tick);
      const state = tracker.getState();

      expect(state.buffers.btc.spot_count).toBe(1);
    });
  });

  describe('handleOracleTick', () => {
    it('should add price to oracle buffer for symbol', () => {
      const tick = {
        symbol: 'btc',
        price: 95000,
        timestamp: Date.now(),
      };

      tracker.handleOracleTick(tick);
      const state = tracker.getState();

      expect(state.buffers.btc.oracle_count).toBe(1);
    });
  });

  describe('analyze', () => {
    it('should return null when insufficient data', () => {
      const result = tracker.analyze('btc');
      expect(result).toBeNull();
    });

    it('should return analysis results with sufficient data', () => {
      const now = Date.now();

      // Add enough spot data points
      for (let i = 0; i < 100; i++) {
        const t = now + i * 50;
        const price = 95000 + Math.sin(i / 5) * 100;
        tracker.handleSpotTick({ symbol: 'btc', price, timestamp: t });
      }

      // Add oracle data points with 1000ms lag (overlapping time range)
      for (let i = 0; i < 100; i++) {
        const t = now + i * 50 + 1000;
        const price = 95000 + Math.sin(i / 5) * 100;
        tracker.handleOracleTick({ symbol: 'btc', price, timestamp: t });
      }

      const result = tracker.analyze('btc');

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('tau_star_ms');
      expect(result).toHaveProperty('correlation');
      expect(result).toHaveProperty('p_value');
      expect(result).toHaveProperty('significant');
    });
  });

  describe('getLagSignal', () => {
    it('should return no signal when no significant move', () => {
      const signal = tracker.getLagSignal('btc');
      expect(signal.has_signal).toBe(false);
    });
  });

  describe('getStability', () => {
    it('should return empty history when no measurements', () => {
      const stability = tracker.getStability('btc');

      expect(stability.stable).toBe(true);
      expect(stability.tau_history).toEqual([]);
      expect(stability.variance).toBe(0);
    });

    it('should track stability over time', () => {
      const now = Date.now();

      // Generate data and perform multiple analyses
      for (let round = 0; round < 5; round++) {
        // Add spot data
        for (let i = 0; i < 100; i++) {
          const t = now + round * 10000 + i * 50;
          const price = 95000 + Math.sin(i / 5) * 100;
          tracker.handleSpotTick({ symbol: 'btc', price, timestamp: t });
        }
        // Add oracle data with lag
        for (let i = 0; i < 100; i++) {
          const t = now + round * 10000 + i * 50 + 1000;
          const price = 95000 + Math.sin(i / 5) * 100;
          tracker.handleOracleTick({ symbol: 'btc', price, timestamp: t });
        }
        tracker.analyze('btc');
      }

      const stability = tracker.getStability('btc');
      expect(stability.tau_history.length).toBeGreaterThan(0);
    });
  });

  describe('recordOutcome', () => {
    it('should record outcome for a signal', () => {
      // Create a signal first
      const signalId = tracker.createSignal('btc', {
        direction: 'up',
        tau_ms: 1000,
        correlation: 0.8,
        confidence: 0.75,
        spot_price: 95000,
        oracle_price: 94900,
        spot_move_magnitude: 0.002,
      });

      tracker.recordOutcome(signalId, {
        outcome_direction: 'up',
        pnl: 10.5,
      });

      const stats = tracker.getAccuracyStats();
      expect(stats.total_signals).toBe(1);
      expect(stats.total_correct).toBe(1);
    });

    it('should handle recording outcome for non-existent signal', () => {
      // Should not throw, just log warning
      tracker.recordOutcome(999999, {
        outcome_direction: 'up',
        pnl: 10.5,
      });

      const stats = tracker.getAccuracyStats();
      expect(stats.total_outcomes).toBe(0);
    });
  });

  describe('signal memory limits', () => {
    it('should drop oldest signal when at capacity', () => {
      // Create MAX_PENDING_SIGNALS + 1 signals
      const signalIds = [];
      for (let i = 0; i < 1001; i++) {
        const id = tracker.createSignal('btc', {
          direction: 'up',
          tau_ms: 1000,
          correlation: 0.8,
          confidence: 0.75,
          spot_price: 95000 + i,
          oracle_price: 94900,
          spot_move_magnitude: 0.002,
        });
        signalIds.push(id);
      }

      // First signal should have been dropped
      expect(tracker.signals.has(signalIds[0])).toBe(false);
      // Last signal should exist
      expect(tracker.signals.has(signalIds[1000])).toBe(true);
      // Should track dropped signals
      expect(tracker.signalStats.signals_dropped).toBeGreaterThan(0);
    });
  });
});
