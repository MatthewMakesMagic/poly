/**
 * DivergenceTracker Class Tests
 *
 * Unit tests for spread calculation, direction determination,
 * and threshold breach detection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DivergenceTracker } from '../tracker.js';
import { TOPICS } from '../../../clients/rtds/types.js';
import { Direction, BreachEventType } from '../types.js';

describe('DivergenceTracker', () => {
  let tracker;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    tracker = new DivergenceTracker({
      logger: mockLogger,
      thresholdPct: 0.003, // 0.3%
      alignedThresholdPct: 0.0001, // 0.01%
    });
  });

  describe('updatePrice', () => {
    it('should update UI price from crypto_prices topic', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);

      expect(tracker.prices.btc.ui).toBe(50000);
      expect(tracker.prices.btc.oracle).toBeNull();
    });

    it('should update Oracle price from crypto_prices_chainlink topic', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      expect(tracker.prices.btc.ui).toBeNull();
      expect(tracker.prices.btc.oracle).toBe(50000);
    });

    it('should return null for invalid symbol', () => {
      const result = tracker.updatePrice('invalid', TOPICS.CRYPTO_PRICES, 50000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('invalid_symbol_received', { symbol: 'invalid' });
    });

    it('should return null for invalid price (NaN)', () => {
      const result = tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, NaN);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('invalid_price_received', expect.any(Object));
    });

    it('should return null for invalid price (Infinity)', () => {
      const result = tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, Infinity);

      expect(result).toBeNull();
    });

    it('should return null for invalid price (null)', () => {
      const result = tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, null);

      expect(result).toBeNull();
    });

    it('should return null for negative price', () => {
      const result = tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, -50000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('invalid_price_received', expect.objectContaining({
        symbol: 'btc',
        price: -50000,
        reason: 'negative_price',
      }));
    });

    it('should not increment ticksProcessed for invalid prices', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, NaN);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, -100);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, Infinity);

      expect(tracker.stats.ticksProcessed).toBe(0);
    });

    it('should rate-limit warning logs for repeated invalid prices', () => {
      // First call should log
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, NaN);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      // Second call within rate limit window should NOT log
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, NaN);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      // Different symbol should still log (separate rate limit key)
      tracker.updatePrice('eth', TOPICS.CRYPTO_PRICES, NaN);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    it('should return null for unknown topic', () => {
      const result = tracker.updatePrice('btc', 'unknown_topic', 50000);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('unknown_topic_received', expect.any(Object));
    });

    it('should increment ticksProcessed on valid price update', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      expect(tracker.stats.ticksProcessed).toBe(2);
    });
  });

  describe('calculateSpread', () => {
    it('should return null when only UI price is available', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);

      const spread = tracker.getSpread('btc');
      expect(spread).toBeNull();
    });

    it('should return null when only Oracle price is available', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      const spread = tracker.getSpread('btc');
      expect(spread).toBeNull();
    });

    it('should calculate positive spread (UI leading)', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50100); // UI price
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000); // Oracle price

      const spread = tracker.getSpread('btc');

      expect(spread.raw).toBe(100); // 50100 - 50000
      expect(spread.pct).toBeCloseTo(0.002, 5); // 100 / 50000 = 0.002 (0.2%)
      expect(spread.direction).toBe(Direction.UI_LEADING);
      expect(spread.ui_price).toBe(50100);
      expect(spread.oracle_price).toBe(50000);
      expect(spread.last_updated).toBeDefined();
    });

    it('should calculate negative spread (UI lagging)', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 49900); // UI price
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000); // Oracle price

      const spread = tracker.getSpread('btc');

      expect(spread.raw).toBe(-100); // 49900 - 50000
      expect(spread.pct).toBeCloseTo(-0.002, 5); // -100 / 50000 = -0.002 (-0.2%)
      expect(spread.direction).toBe(Direction.UI_LAGGING);
    });

    it('should detect aligned spread when within threshold', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50001); // UI price
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000); // Oracle price

      const spread = tracker.getSpread('btc');

      // 1 / 50000 = 0.00002 which is less than alignedThresholdPct (0.0001)
      expect(spread.direction).toBe(Direction.ALIGNED);
    });

    it('should handle zero oracle price (avoid division by zero)', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 100);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 0);

      const spread = tracker.getSpread('btc');

      expect(spread.raw).toBe(100);
      expect(spread.pct).toBe(0); // Division by zero returns 0
    });

    it('should update spread on each tick', () => {
      // First update
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);
      expect(tracker.getSpread('btc').raw).toBe(0);

      // Second update - UI price increases
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50200);
      expect(tracker.getSpread('btc').raw).toBe(200);

      // Third update - Oracle catches up
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50200);
      expect(tracker.getSpread('btc').raw).toBe(0);
    });
  });

  describe('determineDirection', () => {
    it('should return UI_LEADING for positive spread above aligned threshold', () => {
      expect(tracker.determineDirection(0.001)).toBe(Direction.UI_LEADING);
    });

    it('should return UI_LAGGING for negative spread below aligned threshold', () => {
      expect(tracker.determineDirection(-0.001)).toBe(Direction.UI_LAGGING);
    });

    it('should return ALIGNED for spread within aligned threshold', () => {
      expect(tracker.determineDirection(0.00005)).toBe(Direction.ALIGNED);
      expect(tracker.determineDirection(-0.00005)).toBe(Direction.ALIGNED);
      expect(tracker.determineDirection(0)).toBe(Direction.ALIGNED);
    });
  });

  describe('threshold breach detection', () => {
    it('should detect breach when spread exceeds threshold', () => {
      const breachCallback = vi.fn();
      tracker.subscribeToBreaches(breachCallback);

      // Set prices that create 0.5% spread (above 0.3% threshold)
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      expect(breachCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BreachEventType.STARTED,
          symbol: 'btc',
        })
      );
      expect(tracker.breachState.btc.breached).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith('spread_breach_started', expect.any(Object));
    });

    it('should detect breach end when spread returns below threshold', () => {
      const breachCallback = vi.fn();
      tracker.subscribeToBreaches(breachCallback);

      // Create breach
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      // Spread returns to normal
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50100);

      expect(breachCallback).toHaveBeenCalledTimes(2);
      expect(breachCallback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: BreachEventType.ENDED,
          symbol: 'btc',
          breach_duration_ms: expect.any(Number),
        })
      );
      expect(tracker.breachState.btc.breached).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith('spread_breach_ended', expect.any(Object));
    });

    it('should not emit duplicate breach events', () => {
      const breachCallback = vi.fn();
      tracker.subscribeToBreaches(breachCallback);

      // Create breach
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      // Another tick still above threshold
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50260);

      // Should only have one breach_started event
      expect(breachCallback).toHaveBeenCalledTimes(1);
    });

    it('should detect negative breach (UI lagging)', () => {
      const breachCallback = vi.fn();
      tracker.subscribeToBreaches(breachCallback);

      // UI price is lower than oracle
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 49750);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      expect(breachCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BreachEventType.STARTED,
          symbol: 'btc',
          direction: Direction.UI_LAGGING,
        })
      );
    });

    it('should track breach statistics', () => {
      // Create and end a breach
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50100);

      expect(tracker.stats.breachesDetected).toBe(1);
      expect(tracker.stats.lastBreachAt).toBeDefined();
    });
  });

  describe('subscription pattern', () => {
    describe('spread subscriptions', () => {
      it('should notify spread subscribers on update', () => {
        const callback = vi.fn();
        tracker.subscribeToSpread('btc', callback);

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            symbol: 'btc',
            raw: 0,
            pct: 0,
            direction: Direction.ALIGNED,
          })
        );
      });

      it('should allow multiple subscribers for same symbol', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        tracker.subscribeToSpread('btc', callback1);
        tracker.subscribeToSpread('btc', callback2);

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        expect(callback1).toHaveBeenCalled();
        expect(callback2).toHaveBeenCalled();
      });

      it('should unsubscribe correctly', () => {
        const callback = vi.fn();
        const unsubscribe = tracker.subscribeToSpread('btc', callback);

        // Unsubscribe before price update
        unsubscribe();

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        expect(callback).not.toHaveBeenCalled();
      });

      it('should handle subscriber errors gracefully', () => {
        const errorCallback = vi.fn().mockImplementation(() => {
          throw new Error('Subscriber error');
        });
        const goodCallback = vi.fn();

        tracker.subscribeToSpread('btc', errorCallback);
        tracker.subscribeToSpread('btc', goodCallback);

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50000);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        // Error should be logged but not thrown
        expect(mockLogger.warn).toHaveBeenCalledWith('spread_subscriber_error', expect.any(Object));
        // Good callback should still be called
        expect(goodCallback).toHaveBeenCalled();
      });
    });

    describe('breach subscriptions', () => {
      it('should notify breach subscribers', () => {
        const callback = vi.fn();
        tracker.subscribeToBreaches(callback);

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        expect(callback).toHaveBeenCalled();
      });

      it('should allow multiple breach subscribers', () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();
        tracker.subscribeToBreaches(callback1);
        tracker.subscribeToBreaches(callback2);

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        expect(callback1).toHaveBeenCalled();
        expect(callback2).toHaveBeenCalled();
      });

      it('should unsubscribe from breaches correctly', () => {
        const callback = vi.fn();
        const unsubscribe = tracker.subscribeToBreaches(callback);

        unsubscribe();

        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
        tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

        expect(callback).not.toHaveBeenCalled();
      });

      it('should handle breach subscriber errors gracefully', () => {
        const errorCallback = vi.fn().mockImplementation(() => {
          throw new Error('Subscriber error');
        });

        tracker.subscribeToBreaches(errorCallback);

        // Should not throw
        expect(() => {
          tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
          tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);
        }).not.toThrow();

        expect(mockLogger.warn).toHaveBeenCalledWith('breach_subscriber_error', expect.any(Object));
      });
    });
  });

  describe('getSpread / getAllSpreads', () => {
    it('should return null for symbol with no spread', () => {
      expect(tracker.getSpread('btc')).toBeNull();
    });

    it('should return null for invalid symbol', () => {
      expect(tracker.getSpread('invalid')).toBeNull();
    });

    it('should return spread for symbol with both prices', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50100);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      const spread = tracker.getSpread('btc');
      expect(spread).toBeDefined();
      expect(spread.raw).toBe(100);
    });

    it('should return all spreads', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50100);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);
      tracker.updatePrice('eth', TOPICS.CRYPTO_PRICES, 3010);
      tracker.updatePrice('eth', TOPICS.CRYPTO_PRICES_CHAINLINK, 3000);

      const allSpreads = tracker.getAllSpreads();

      expect(allSpreads.btc.raw).toBe(100);
      expect(allSpreads.eth.raw).toBe(10);
      expect(allSpreads.sol).toBeNull();
      expect(allSpreads.xrp).toBeNull();
    });
  });

  describe('getBreachStates', () => {
    it('should return initial breach states (all not breached)', () => {
      const states = tracker.getBreachStates();

      expect(states.btc.breached).toBe(false);
      expect(states.eth.breached).toBe(false);
      expect(states.sol.breached).toBe(false);
      expect(states.xrp.breached).toBe(false);
    });

    it('should return current breach state', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      const states = tracker.getBreachStates();

      expect(states.btc.breached).toBe(true);
      expect(states.btc.breachStartedAt).toBeDefined();
      expect(states.btc.spreadAtBreach).toBeDefined();
    });

    it('should return deep copy that cannot mutate internal state', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      const states = tracker.getBreachStates();

      // Attempt to mutate the returned state
      states.btc.breached = false;
      states.btc.spreadAtBreach = 999;

      // Internal state should be unchanged
      const internalStates = tracker.getBreachStates();
      expect(internalStates.btc.breached).toBe(true);
      expect(internalStates.btc.spreadAtBreach).not.toBe(999);
    });
  });

  describe('getStats', () => {
    it('should return statistics', () => {
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      const stats = tracker.getStats();

      expect(stats.ticks_processed).toBe(2);
      expect(stats.breaches_detected).toBe(1);
      expect(stats.last_breach_at).toBeDefined();
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      // Set up some state
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);
      tracker.subscribeToSpread('btc', vi.fn());
      tracker.subscribeToBreaches(vi.fn());

      // Reset
      tracker.reset();

      // Verify reset
      expect(tracker.prices.btc.ui).toBeNull();
      expect(tracker.prices.btc.oracle).toBeNull();
      expect(tracker.prices.btc.spread).toBeNull();
      expect(tracker.breachState.btc.breached).toBe(false);
      expect(tracker.spreadSubscribers.size).toBe(0);
      expect(tracker.breachSubscribers.size).toBe(0);
      expect(tracker.stats.ticksProcessed).toBe(0);
    });
  });

  describe('clearSubscriptions', () => {
    it('should clear all subscriptions', () => {
      const spreadCallback = vi.fn();
      const breachCallback = vi.fn();

      tracker.subscribeToSpread('btc', spreadCallback);
      tracker.subscribeToBreaches(breachCallback);

      tracker.clearSubscriptions();

      // Trigger updates
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES, 50250);
      tracker.updatePrice('btc', TOPICS.CRYPTO_PRICES_CHAINLINK, 50000);

      expect(spreadCallback).not.toHaveBeenCalled();
      expect(breachCallback).not.toHaveBeenCalled();
    });
  });
});
