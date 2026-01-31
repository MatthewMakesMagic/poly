/**
 * Entry Logic Unit Tests
 *
 * Tests the core entry evaluation logic for the simple threshold strategy.
 * Entry triggers when token price > 70%, limited to 1 entry per window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateEntry, calculateConfidence } from '../entry-logic.js';
import { resetState } from '../state.js';
import { Direction, NoSignalReason } from '../types.js';

// Default test thresholds for simple threshold strategy
const defaultThresholds = {
  entryThresholdPct: 0.70,       // 70% price threshold
  minTimeRemainingMs: 60000,     // 1 minute minimum
};

describe('entry-logic', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  describe('evaluateEntry()', () => {
    describe('signal generation when conditions met', () => {
      it('returns signal when price above 70%', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.75,        // 75% - above threshold
          time_remaining_ms: 600000, // 10 minutes
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.direction).toBe(Direction.LONG);
        expect(result.signal.window_id).toBe('test-window');
        expect(result.signal.market_id).toBe('btc-up');
        expect(result.signal.market_price).toBe(0.75);
        expect(result.signal.confidence).toBe(0.75);
        expect(result.signal.time_remaining_ms).toBe(600000);
        expect(result.signal.signal_at).toBeDefined();
      });

      it('always generates LONG direction', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-down', // Even for "down" market
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.direction).toBe(Direction.LONG);
      });

      it('sets spot_lag to 0 (not used in simple strategy)', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal.spot_lag).toBe(0);
        expect(result.signal.spot_lag_pct).toBe(0);
      });

      it('calculates confidence equal to market price', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.85,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.confidence).toBe(0.85);
      });

      it('caps confidence at 0.95 for very high prices', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.98,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.confidence).toBe(0.95);
      });
    });

    describe('no signal when conditions not met', () => {
      it('returns null when price below threshold', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.65,        // 65% - below threshold
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.BELOW_THRESHOLD);
      });

      it('returns null when time remaining below minimum', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,        // Good price
          time_remaining_ms: 30000,  // 30 seconds - below 1 minute minimum
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.signal_generated).toBe(false);
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_TIME);
      });

      it('returns null when window already entered', () => {
        // First entry - should succeed
        const result1 = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result1.signal).not.toBeNull();

        // Second entry on same window - should fail
        const result2 = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.85,        // Even higher price
          time_remaining_ms: 500000,
          thresholds: defaultThresholds,
        });

        expect(result2.signal).toBeNull();
        expect(result2.result.signal_generated).toBe(false);
        expect(result2.result.reason).toBe(NoSignalReason.ALREADY_ENTERED_WINDOW);
      });
    });

    describe('one entry per window', () => {
      it('different windows can each generate signals', () => {
        const result1 = evaluateEntry({
          window_id: 'window-a',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        const result2 = evaluateEntry({
          window_id: 'window-b',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result1.signal).not.toBeNull();
        expect(result2.signal).not.toBeNull();
        expect(result1.signal.window_id).toBe('window-a');
        expect(result2.signal.window_id).toBe('window-b');
      });

      it('blocks re-entry even with different market_id', () => {
        // Enter with btc-up
        const result1 = evaluateEntry({
          window_id: 'same-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result1.signal).not.toBeNull();

        // Try to enter same window with btc-down
        const result2 = evaluateEntry({
          window_id: 'same-window',
          market_id: 'btc-down',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result2.signal).toBeNull();
        expect(result2.result.reason).toBe(NoSignalReason.ALREADY_ENTERED_WINDOW);
      });
    });

    describe('edge cases', () => {
      it('handles exactly-at-threshold price', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.70,        // Exactly at threshold
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        // 0.70 is NOT > 0.70, so no signal
        expect(result.signal).toBeNull();
        expect(result.result.reason).toBe(NoSignalReason.BELOW_THRESHOLD);
      });

      it('handles barely-above-threshold price', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.701,       // Just above threshold
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).not.toBeNull();
        expect(result.signal.confidence).toBeCloseTo(0.701, 3);
      });

      it('evaluates time constraint first (before window check)', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 10000,  // 10 seconds - below minimum
          thresholds: defaultThresholds,
        });

        // Should fail on time before checking window
        expect(result.result.reason).toBe(NoSignalReason.INSUFFICIENT_TIME);
      });

      it('evaluates window check before price check', () => {
        // First enter the window
        evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        // Now try again with low price
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.50,        // Below threshold
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        // Should fail on already entered before checking price
        expect(result.result.reason).toBe(NoSignalReason.ALREADY_ENTERED_WINDOW);
      });

      it('handles very low price', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.10,        // 10%
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.signal).toBeNull();
        expect(result.result.reason).toBe(NoSignalReason.BELOW_THRESHOLD);
      });
    });

    describe('evaluation result', () => {
      it('always includes evaluation result with correct fields', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.50,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.result).toBeDefined();
        expect(result.result.window_id).toBe('test-window');
        expect(result.result.evaluated_at).toBeDefined();
        expect(result.result.spot_price).toBe(100000);
        expect(result.result.market_price).toBe(0.50);
        expect(result.result.threshold_pct).toBe(0.70);
        expect(result.result.time_remaining_ms).toBe(600000);
        expect(typeof result.result.signal_generated).toBe('boolean');
        expect(result.result.reason).toBeDefined();
      });

      it('includes conditions_met reason when signal generated', () => {
        const result = evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
        });

        expect(result.result.signal_generated).toBe(true);
        expect(result.result.reason).toBe(NoSignalReason.CONDITIONS_MET);
      });
    });

    describe('logging', () => {
      it('calls debug logger for non-signal evaluations', () => {
        const mockLog = { debug: vi.fn(), info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.50,        // Below threshold
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        expect(mockLog.debug).toHaveBeenCalledWith('entry_evaluated', expect.any(Object));
        expect(mockLog.info).not.toHaveBeenCalled();
      });

      it('calls info logger when signal generated', () => {
        const mockLog = { debug: vi.fn(), info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        expect(mockLog.info).toHaveBeenCalledWith('entry_signal_generated', expect.any(Object));
        expect(mockLog.debug).not.toHaveBeenCalled();
      });

      it('logs expected vs actual format', () => {
        const mockLog = { debug: vi.fn(), info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.50,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        const logCall = mockLog.debug.mock.calls[0][1];
        expect(logCall.expected).toBeDefined();
        expect(logCall.actual).toBeDefined();
        expect(logCall.expected.entry_threshold_pct).toBe(0.70);
        expect(logCall.actual.market_price).toBe(0.50);
      });

      it('includes signal info when signal generated', () => {
        const mockLog = { debug: vi.fn(), info: vi.fn() };

        evaluateEntry({
          window_id: 'test-window',
          market_id: 'btc-up',
          spot_price: 100000,
          market_price: 0.80,
          time_remaining_ms: 600000,
          thresholds: defaultThresholds,
          log: mockLog,
        });

        const logCall = mockLog.info.mock.calls[0][1];
        expect(logCall.signal).toBeDefined();
        expect(logCall.signal.direction).toBeDefined();
        expect(logCall.signal.market_price).toBe(0.80);
      });

      it('does not throw when logger is null', () => {
        expect(() => {
          evaluateEntry({
            window_id: 'test-window',
            market_id: 'btc-up',
            spot_price: 100000,
            market_price: 0.50,
            time_remaining_ms: 600000,
            thresholds: defaultThresholds,
            log: null,
          });
        }).not.toThrow();
      });
    });
  });

  describe('calculateConfidence()', () => {
    it('returns market price for prices below 0.95', () => {
      expect(calculateConfidence(0.70, 0.70)).toBe(0.70);
      expect(calculateConfidence(0.75, 0.70)).toBe(0.75);
      expect(calculateConfidence(0.85, 0.70)).toBe(0.85);
      expect(calculateConfidence(0.90, 0.70)).toBe(0.90);
    });

    it('caps at 0.95 for very high prices', () => {
      expect(calculateConfidence(0.95, 0.70)).toBe(0.95);
      expect(calculateConfidence(0.98, 0.70)).toBe(0.95);
      expect(calculateConfidence(0.99, 0.70)).toBe(0.95);
    });
  });
});
