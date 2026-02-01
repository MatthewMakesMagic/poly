/**
 * Oracle Pattern Tracker Tests (tracker.js)
 *
 * Tests for the OraclePatternTracker class that detects oracle price updates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OraclePatternTracker } from '../tracker.js';

describe('OraclePatternTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new OraclePatternTracker({ minDeviationForUpdate: 0.0001 });
  });

  describe('constructor', () => {
    it('initializes with default config', () => {
      const t = new OraclePatternTracker();
      expect(t.minDeviationForUpdate).toBe(0.0001);
    });

    it('initializes with custom minDeviationForUpdate', () => {
      const t = new OraclePatternTracker({ minDeviationForUpdate: 0.001 });
      expect(t.minDeviationForUpdate).toBe(0.001);
    });

    it('initializes previous prices for all symbols as null', () => {
      const states = tracker.getAllTrackingStates();
      expect(states.btc.last_price).toBeNull();
      expect(states.eth.last_price).toBeNull();
      expect(states.sol.last_price).toBeNull();
      expect(states.xrp.last_price).toBeNull();
    });
  });

  describe('handleOracleTick', () => {
    describe('first tick handling', () => {
      it('stores first tick price but does not create update record', () => {
        const result = tracker.handleOracleTick({
          timestamp: 1706745600000,
          topic: 'crypto_prices_chainlink',
          symbol: 'btc',
          price: 50000,
        });

        expect(result).toBeNull();

        const state = tracker.getTrackingState('btc');
        expect(state.last_price).toBe(50000);
        expect(state.updates_recorded).toBe(0);
      });

      it('handles timestamp as Date object', () => {
        const result = tracker.handleOracleTick({
          timestamp: new Date(1706745600000),
          topic: 'crypto_prices_chainlink',
          symbol: 'btc',
          price: 50000,
        });

        expect(result).toBeNull();
        const state = tracker.getTrackingState('btc');
        expect(state.last_price).toBe(50000);
      });

      it('uses current time if timestamp is missing', () => {
        const before = Date.now();
        tracker.handleOracleTick({
          topic: 'crypto_prices_chainlink',
          symbol: 'btc',
          price: 50000,
        });
        const after = Date.now();

        const state = tracker.getTrackingState('btc');
        const lastUpdateTime = new Date(state.last_update_at).getTime();
        expect(lastUpdateTime).toBeGreaterThanOrEqual(before);
        expect(lastUpdateTime).toBeLessThanOrEqual(after);
      });
    });

    describe('update detection', () => {
      beforeEach(() => {
        // Set initial price
        tracker.handleOracleTick({
          timestamp: 1706745600000,
          symbol: 'btc',
          price: 50000,
        });
      });

      it('creates update record when price changes significantly', () => {
        const result = tracker.handleOracleTick({
          timestamp: 1706745610000,
          symbol: 'btc',
          price: 50010, // 0.02% change > 0.01% threshold
        });

        expect(result).not.toBeNull();
        expect(result.symbol).toBe('btc');
        expect(result.price).toBe(50010);
        expect(result.previous_price).toBe(50000);
        expect(result.deviation_from_previous_pct).toBeCloseTo(0.0002, 6);
        expect(result.time_since_previous_ms).toBe(10000);
      });

      it('does NOT create update record when price change is below threshold', () => {
        const result = tracker.handleOracleTick({
          timestamp: 1706745610000,
          symbol: 'btc',
          price: 50004, // 0.008% change < 0.01% threshold
        });

        expect(result).toBeNull();
      });

      it('detects negative price movements', () => {
        const result = tracker.handleOracleTick({
          timestamp: 1706745610000,
          symbol: 'btc',
          price: 49990, // -0.02% change
        });

        expect(result).not.toBeNull();
        expect(result.deviation_from_previous_pct).toBeCloseTo(-0.0002, 6);
      });

      it('updates timestamp for update record', () => {
        const result = tracker.handleOracleTick({
          timestamp: 1706745610000,
          symbol: 'btc',
          price: 50010,
        });

        expect(result.timestamp).toBe('2024-02-01T00:00:10.000Z');
      });

      it('calculates time_since_previous_ms correctly', () => {
        const result = tracker.handleOracleTick({
          timestamp: 1706745615000, // 15 seconds later
          symbol: 'btc',
          price: 50010,
        });

        expect(result.time_since_previous_ms).toBe(15000);
      });
    });

    describe('deviation calculation', () => {
      it('calculates positive deviation correctly', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 100 });
        const result = tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 101 });

        expect(result.deviation_from_previous_pct).toBeCloseTo(0.01, 6); // 1%
      });

      it('calculates negative deviation correctly', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 100 });
        const result = tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 99 });

        expect(result.deviation_from_previous_pct).toBeCloseTo(-0.01, 6); // -1%
      });

      it('calculates large deviation correctly', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 50000 });
        const result = tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 55000 });

        expect(result.deviation_from_previous_pct).toBeCloseTo(0.1, 6); // 10%
      });
    });

    describe('multiple symbols', () => {
      it('tracks symbols independently', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 50000 });
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'eth', price: 3000 });

        const btcResult = tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 50100 });
        const ethResult = tracker.handleOracleTick({ timestamp: 2000, symbol: 'eth', price: 3006 });

        expect(btcResult.previous_price).toBe(50000);
        expect(ethResult.previous_price).toBe(3000);
      });

      it('increments update counts per symbol', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 50000 });
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'eth', price: 3000 });

        tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 50100 });
        tracker.handleOracleTick({ timestamp: 3000, symbol: 'btc', price: 50200 });
        tracker.handleOracleTick({ timestamp: 2000, symbol: 'eth', price: 3006 });

        expect(tracker.getTrackingState('btc').updates_recorded).toBe(2);
        expect(tracker.getTrackingState('eth').updates_recorded).toBe(1);
        expect(tracker.getTrackingState('sol').updates_recorded).toBe(0);
      });

      it('supports all four symbols', () => {
        const symbols = ['btc', 'eth', 'sol', 'xrp'];
        const prices = [50000, 3000, 100, 0.5];

        for (let i = 0; i < symbols.length; i++) {
          tracker.handleOracleTick({ timestamp: 1000, symbol: symbols[i], price: prices[i] });
        }

        for (let i = 0; i < symbols.length; i++) {
          const state = tracker.getTrackingState(symbols[i]);
          expect(state.last_price).toBe(prices[i]);
        }
      });
    });

    describe('invalid input handling', () => {
      it('returns null for null tick', () => {
        expect(tracker.handleOracleTick(null)).toBeNull();
      });

      it('returns null for undefined tick', () => {
        expect(tracker.handleOracleTick(undefined)).toBeNull();
      });

      it('returns null for tick without symbol', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, price: 50000 })).toBeNull();
      });

      it('returns null for tick with non-number price', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 'invalid' })).toBeNull();
      });

      it('returns null for tick with NaN price', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: NaN })).toBeNull();
      });

      it('returns null for tick with Infinity price', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: Infinity })).toBeNull();
      });

      it('returns null for unknown symbol', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, symbol: 'unknown', price: 100 })).toBeNull();
      });

      it('returns null for tick with zero price', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 0 })).toBeNull();
      });

      it('returns null for tick with negative price', () => {
        expect(tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: -100 })).toBeNull();
      });

      it('returns null for out-of-order ticks (negative time difference)', () => {
        // Set initial price at timestamp 2000
        tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 50000 });

        // Send a tick with earlier timestamp - should be rejected
        const result = tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 50100 });

        expect(result).toBeNull();
        // State should still have the original timestamp
        const state = tracker.getTrackingState('btc');
        expect(state.last_price).toBe(50000);
      });
    });

    describe('threshold edge cases', () => {
      it('does NOT create update for exactly threshold deviation', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 100000 });
        // 0.01% of 100000 = 10
        const result = tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 100009.9 });

        // 0.0099% < 0.01% threshold
        expect(result).toBeNull();
      });

      it('creates update for just above threshold deviation', () => {
        tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 100000 });
        // Just above 0.01% threshold
        const result = tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 100011 });

        expect(result).not.toBeNull();
      });
    });
  });

  describe('getTrackingState', () => {
    it('returns null for unknown symbol', () => {
      expect(tracker.getTrackingState('unknown')).toBeNull();
    });

    it('returns initial state with nulls', () => {
      const state = tracker.getTrackingState('btc');
      expect(state.last_price).toBeNull();
      expect(state.last_update_at).toBeNull();
      expect(state.updates_recorded).toBe(0);
    });

    it('returns state after first tick', () => {
      tracker.handleOracleTick({ timestamp: 1706745600000, symbol: 'btc', price: 50000 });

      const state = tracker.getTrackingState('btc');
      expect(state.last_price).toBe(50000);
      expect(state.last_update_at).toBe('2024-02-01T00:00:00.000Z');
      expect(state.updates_recorded).toBe(0);
    });

    it('returns state after update', () => {
      tracker.handleOracleTick({ timestamp: 1706745600000, symbol: 'btc', price: 50000 });
      tracker.handleOracleTick({ timestamp: 1706745610000, symbol: 'btc', price: 50100 });

      const state = tracker.getTrackingState('btc');
      expect(state.last_price).toBe(50100);
      expect(state.last_update_at).toBe('2024-02-01T00:00:10.000Z');
      expect(state.updates_recorded).toBe(1);
    });
  });

  describe('getAllTrackingStates', () => {
    it('returns states for all symbols', () => {
      const states = tracker.getAllTrackingStates();

      expect(states).toHaveProperty('btc');
      expect(states).toHaveProperty('eth');
      expect(states).toHaveProperty('sol');
      expect(states).toHaveProperty('xrp');
    });

    it('reflects updates across all symbols', () => {
      tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 50000 });
      tracker.handleOracleTick({ timestamp: 1000, symbol: 'eth', price: 3000 });

      const states = tracker.getAllTrackingStates();

      expect(states.btc.last_price).toBe(50000);
      expect(states.eth.last_price).toBe(3000);
      expect(states.sol.last_price).toBeNull();
      expect(states.xrp.last_price).toBeNull();
    });
  });

  describe('reset', () => {
    it('clears all tracking state', () => {
      tracker.handleOracleTick({ timestamp: 1000, symbol: 'btc', price: 50000 });
      tracker.handleOracleTick({ timestamp: 2000, symbol: 'btc', price: 50100 });
      tracker.handleOracleTick({ timestamp: 1000, symbol: 'eth', price: 3000 });

      tracker.reset();

      const states = tracker.getAllTrackingStates();
      expect(states.btc.last_price).toBeNull();
      expect(states.btc.updates_recorded).toBe(0);
      expect(states.eth.last_price).toBeNull();
      expect(states.eth.updates_recorded).toBe(0);
    });
  });
});
