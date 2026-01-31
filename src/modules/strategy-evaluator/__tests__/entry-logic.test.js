/**
 * Entry Logic Unit Tests
 *
 * Tests the core entry evaluation logic for the spot-lag strategy.
 */

import { describe, it, expect, vi } from 'vitest';
import { evaluateEntry, calculateConfidence } from '../entry-logic.js';
import { Direction, NoSignalReason } from '../types.js';

// Default test thresholds
const defaultThresholds = {
  spotLagThresholdPct: 0.02,   // 2% lag required
  minConfidence: 0.6,          // Minimum confidence
  minTimeRemainingMs: 60000,   // 1 minute minimum
};

describe('entry-logic', () => {
  describe('evaluateEntry()', () => {
    describe('signal generation when conditions met', () => {
      it('returns signal when lag exceeds threshold (long position)', () => {
        // 3% lag = 1.5x threshold = confidence 0.75 (above 0.6 min)
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 43260,        // 3% higher than market
          market_price: 42000,
          time_remaining_ms: 600000, // 10 minutes
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.direction).toBe(Direction.LONG);
        expect(result.signal.window_id).toBe('test-window');
        expect(result.signal.market_id).toBe('test-market');
        expect(result.signal.spot_price).toBe(43260);
        expect(result.signal.market_price).toBe(42000);
        expect(result.signal.spot_lag).toBe(1260);
        expect(result.signal.confidence).toBeGreaterThanOrEqual(0.6);
        expect(result.signal.time_remaining_ms).toBe(600000);
        expect(result.signal.signal_at).toBeDefined();
      });

      it('returns signal when lag exceeds threshold (short position)', () => {
        // 3% lag = 1.5x threshold = confidence 0.75 (above 0.6 min)
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 40740,        // 3% lower than market
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.direction).toBe(Direction.SHORT);
        expect(result.signal.spot_lag).toBe(-1260);
      });

      it('includes correct spot_lag_pct in signal', () => {
        // 3% lag
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 43260,
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal.spot_lag_pct).toBeCloseTo(0.03, 3);
      });

      it('calculates higher confidence for larger lag', () => {
        // 4% lag (2x threshold)
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 43680,        // 4% higher
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.confidence).toBeCloseTo(1.0, 2);
      });
    });

    describe('no signal when conditions not met', () => {
      it('returns null when lag below threshold', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42100,        // ~0.2% lag, below threshold
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_LAG);
      });

      it('returns null when time remaining below minimum', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42840,        // Good lag
          market_price: 42000,
          time_remaining_ms: 30000, // 30 seconds - below 1 minute minimum
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_TIME);
      });

      it('returns null when confidence below minimum', () => {
        // Configure high confidence threshold
        const highConfidenceThresholds = {
          ...defaultThresholds,
          minConfidence: 0.9,
        };

        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42840,        // 2% lag, exactly at threshold
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: highConfidenceThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.LOW_CONFIDENCE);
      });
    });

    describe('edge cases', () => {
      it('handles zero market price gracefully', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42000,
          market_price: 0,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_LAG);
      });

      it('handles equal spot and market prices', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42000,
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_LAG);
      });

      it('evaluates time constraint before lag constraint', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42840,        // Good lag
          market_price: 42000,
          time_remaining_ms: 10000, // 10 seconds - below minimum
          thresholds: defaultThresholds,
        });

        // Should fail on time first
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_TIME);
      });

      it('handles exactly-at-threshold lag', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42840,        // Exactly 2% lag
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        // At exactly threshold, confidence = 0.5, which is below minConfidence 0.6
        expect(result.signal).toBeNull();
        expect(result.result.reason).toBe(NoSignalReason.LOW_CONFIDENCE);
      });

      it('handles barely-above-threshold lag for signal', () => {
        // Use lower confidence threshold to allow signal at threshold
        const lowConfidenceThresholds = {
          ...defaultThresholds,
          minConfidence: 0.5,
        };

        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42840,        // Exactly 2% lag
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: lowConfidenceThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.confidence).toBeCloseTo(0.5, 2);
      });
    });

    describe('evaluation result', () => {
      it('always includes evaluation result with correct fields', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42100,
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.result).toBeDefined();
        expect(result.result.window_id).toBe('test-window');
        expect(result.result.evaluated_at).toBeDefined();
        expect(result.result.spot_price).toBe(42100);
        expect(result.result.market_price).toBe(42000);
        expect(result.result.threshold_pct).toBe(0.02);
        expect(result.result.time_remaining_ms).toBe(600000);
        expect(typeof result.result.signal_generated).toBe('boolean');
        expect(result.result.reason).toBeDefined();
      });

      it('includes conditions_met reason when signal generated', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 43680,        // 4% lag - high confidence
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.result.signal_generated).toBe(true);
        expect(result.result.reason).toBe(NoSignalReason.CONDITIONS_MET);
      });
    });

    describe('logging', () => {
      it('calls logger when provided', () => {
        const mockLog = { info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42100,
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        expect(mockLog.info).toHaveBeenCalledWith('entry_evaluated', expect.any(Object));
      });

      it('logs expected vs actual format', () => {
        const mockLog = { info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 42100,
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        const logCall = mockLog.info.mock.calls[0][1];
        expect(logCall.expected).toBeDefined();
        expect(logCall.actual).toBeDefined();
        expect(logCall.expected.spot_lag_threshold_pct).toBe(0.02);
        expect(logCall.actual.spot_price).toBe(42100);
      });

      it('includes signal info when signal generated', () => {
        const mockLog = { info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'test-market',
          spot_price: 43680,        // 4% lag
          market_price: 42000,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        const logCall = mockLog.info.mock.calls[0][1];
        expect(logCall.signal).toBeDefined();
        expect(logCall.signal.direction).toBeDefined();
      });

      it('does not throw when logger is null', () => {
        expect(() => {
          evaluateEntry({
            window_id: 'test-window',
            market_id: 'test-market',
            spot_price: 42100,
            market_price: 42000,
            time_remaining_ms: 600000,
            thresholds: defaultThresholds,
            log: null,
          });
        }).not.toThrow();
      });
    });
  });

  describe('calculateConfidence()', () => {
    it('returns 0.5 at exactly threshold', () => {
      const confidence = calculateConfidence(0.02, 0.02);
      expect(confidence).toBeCloseTo(0.5, 2);
    });

    it('returns 1.0 at 2x threshold', () => {
      const confidence = calculateConfidence(0.04, 0.02);
      expect(confidence).toBeCloseTo(1.0, 2);
    });

    it('returns 0.75 at 1.5x threshold', () => {
      const confidence = calculateConfidence(0.03, 0.02);
      expect(confidence).toBeCloseTo(0.75, 2);
    });

    it('caps confidence at 1.0 for very high lag', () => {
      const confidence = calculateConfidence(0.10, 0.02); // 5x threshold
      expect(confidence).toBe(1.0);
    });

    it('returns less than 0.5 for lag below threshold', () => {
      const confidence = calculateConfidence(0.01, 0.02);
      expect(confidence).toBeLessThan(0.5);
    });
  });
});
