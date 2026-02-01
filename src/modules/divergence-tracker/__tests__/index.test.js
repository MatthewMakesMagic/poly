/**
 * Divergence Tracker Module Tests (index.js)
 *
 * Tests for the public interface: init, getSpread, subscribe, getState, shutdown
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing module
vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Track subscriptions for testing
const mockRtdsSubscriptions = new Map();
vi.mock('../../../clients/rtds/index.js', () => ({
  subscribe: vi.fn((symbol, callback) => {
    if (!mockRtdsSubscriptions.has(symbol)) {
      mockRtdsSubscriptions.set(symbol, new Set());
    }
    mockRtdsSubscriptions.get(symbol).add(callback);
    return () => {
      mockRtdsSubscriptions.get(symbol)?.delete(callback);
    };
  }),
  getState: vi.fn(() => ({ initialized: true })),
}));

// Import after mocking
import * as divergenceTracker from '../index.js';
import * as rtdsClient from '../../../clients/rtds/index.js';
import { TOPICS, SUPPORTED_SYMBOLS } from '../../../clients/rtds/types.js';
import { DivergenceTrackerError, DivergenceTrackerErrorCodes } from '../types.js';

describe('Divergence Tracker Module', () => {
  beforeEach(() => {
    mockRtdsSubscriptions.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await divergenceTracker.shutdown();
  });

  describe('init', () => {
    it('should initialize with default config', async () => {
      await divergenceTracker.init();

      const state = divergenceTracker.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.thresholdPct).toBe(0.003);
      expect(state.config.snapshotIntervalMs).toBe(1000);
      expect(state.config.enableSnapshots).toBe(true);
    });

    it('should initialize with custom config', async () => {
      await divergenceTracker.init({
        divergenceTracker: {
          thresholdPct: 0.005,
          snapshotIntervalMs: 500,
          enableSnapshots: false,
        },
      });

      const state = divergenceTracker.getState();
      expect(state.config.thresholdPct).toBe(0.005);
      expect(state.config.snapshotIntervalMs).toBe(500);
      expect(state.config.enableSnapshots).toBe(false);
    });

    it('should subscribe to RTDS for all symbols', async () => {
      await divergenceTracker.init();

      expect(rtdsClient.subscribe).toHaveBeenCalledTimes(SUPPORTED_SYMBOLS.length);
      for (const symbol of SUPPORTED_SYMBOLS) {
        expect(rtdsClient.subscribe).toHaveBeenCalledWith(symbol, expect.any(Function));
      }
    });

    it('should be idempotent (no double init)', async () => {
      await divergenceTracker.init();
      await divergenceTracker.init();

      // Should only subscribe once (4 symbols)
      expect(rtdsClient.subscribe).toHaveBeenCalledTimes(4);
    });
  });

  describe('getSpread', () => {
    beforeEach(async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });
    });

    it('should throw if not initialized', async () => {
      await divergenceTracker.shutdown();

      expect(() => divergenceTracker.getSpread('btc')).toThrow(DivergenceTrackerError);
      expect(() => divergenceTracker.getSpread('btc')).toThrow(
        /not initialized/i
      );
    });

    it('should throw for invalid symbol', () => {
      expect(() => divergenceTracker.getSpread('invalid')).toThrow(DivergenceTrackerError);
      expect(() => divergenceTracker.getSpread('invalid')).toThrow(
        /Invalid symbol/
      );
    });

    it('should return null if spread not yet available', () => {
      const spread = divergenceTracker.getSpread('btc');
      expect(spread).toBeNull();
    });

    it('should return spread after receiving ticks', () => {
      // Simulate ticks via RTDS callback
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const callback of btcCallbacks) {
        callback({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50100 });
        callback({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      const spread = divergenceTracker.getSpread('btc');
      expect(spread).toBeDefined();
      expect(spread.raw).toBe(100);
      expect(spread.pct).toBeCloseTo(0.002, 5);
      expect(spread.direction).toBe('ui_leading');
    });
  });

  describe('subscribe', () => {
    beforeEach(async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });
    });

    it('should throw if not initialized', async () => {
      await divergenceTracker.shutdown();

      expect(() => divergenceTracker.subscribe('btc', () => {})).toThrow(DivergenceTrackerError);
    });

    it('should throw for invalid symbol', () => {
      expect(() => divergenceTracker.subscribe('invalid', () => {})).toThrow(
        /Invalid symbol/
      );
    });

    it('should throw if callback is not a function', () => {
      expect(() => divergenceTracker.subscribe('btc', 'not a function')).toThrow(
        /must be a function/
      );
    });

    it('should receive spread updates', () => {
      const callback = vi.fn();
      divergenceTracker.subscribe('btc', callback);

      // Simulate ticks
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50100 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'btc',
          raw: 100,
        })
      );
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = divergenceTracker.subscribe('btc', callback);

      unsubscribe();

      // Simulate ticks
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50100 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('subscribeToBreaches', () => {
    beforeEach(async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });
    });

    it('should throw if not initialized', async () => {
      await divergenceTracker.shutdown();

      expect(() => divergenceTracker.subscribeToBreaches(() => {})).toThrow(DivergenceTrackerError);
    });

    it('should throw if callback is not a function', () => {
      expect(() => divergenceTracker.subscribeToBreaches('not a function')).toThrow(
        /must be a function/
      );
    });

    it('should receive breach events', () => {
      const callback = vi.fn();
      divergenceTracker.subscribeToBreaches(callback);

      // Simulate ticks that create breach (0.5% spread > 0.3% threshold)
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50250 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'breach_started',
          symbol: 'btc',
        })
      );
    });

    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = divergenceTracker.subscribeToBreaches(callback);

      unsubscribe();

      // Simulate ticks that create breach
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50250 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('should return uninitialized state before init', () => {
      const state = divergenceTracker.getState();

      expect(state.initialized).toBe(false);
      expect(state.spreads).toEqual({});
      expect(state.breaches).toEqual({});
      expect(state.config).toBeNull();
    });

    it('should return full state after init', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      const state = divergenceTracker.getState();

      expect(state.initialized).toBe(true);
      expect(state.spreads).toBeDefined();
      expect(state.breaches).toBeDefined();
      expect(state.stats).toBeDefined();
      expect(state.config).toBeDefined();
    });

    it('should include all spread data', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      // Simulate ticks
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50100 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      const state = divergenceTracker.getState();

      expect(state.spreads.btc).toBeDefined();
      expect(state.spreads.btc.raw).toBe(100);
    });

    it('should include breach states', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      // Simulate breach
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50250 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      const state = divergenceTracker.getState();

      expect(state.breaches.btc.breached).toBe(true);
    });

    it('should include statistics', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      // Simulate ticks
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50100 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      const state = divergenceTracker.getState();

      expect(state.stats.ticks_processed).toBeGreaterThan(0);
    });
  });

  describe('shutdown', () => {
    it('should gracefully shutdown', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      await divergenceTracker.shutdown();

      const state = divergenceTracker.getState();
      expect(state.initialized).toBe(false);
    });

    it('should unsubscribe from RTDS', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      // Before shutdown, subscriptions exist
      expect(mockRtdsSubscriptions.get('btc')?.size).toBeGreaterThan(0);

      await divergenceTracker.shutdown();

      // After shutdown, subscriptions are removed
      expect(mockRtdsSubscriptions.get('btc')?.size || 0).toBe(0);
    });

    it('should be safe to call multiple times', async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });

      await divergenceTracker.shutdown();
      await divergenceTracker.shutdown();

      const state = divergenceTracker.getState();
      expect(state.initialized).toBe(false);
    });

    it('should be safe to call without init', async () => {
      await expect(divergenceTracker.shutdown()).resolves.not.toThrow();
    });
  });

  describe('tick handling', () => {
    beforeEach(async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });
    });

    it('should handle null tick gracefully', () => {
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        expect(() => cb(null)).not.toThrow();
      }
    });

    it('should handle tick without symbol gracefully', () => {
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        expect(() => cb({ topic: TOPICS.CRYPTO_PRICES, price: 50000 })).not.toThrow();
      }
    });

    it('should handle tick without topic gracefully', () => {
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        expect(() => cb({ symbol: 'btc', price: 50000 })).not.toThrow();
      }
    });

    it('should process ticks from both topics', () => {
      const btcCallbacks = mockRtdsSubscriptions.get('btc');

      // Send UI tick only
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50000 });
      }
      expect(divergenceTracker.getSpread('btc')).toBeNull();

      // Send Oracle tick - now we have both
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }
      expect(divergenceTracker.getSpread('btc')).toBeDefined();
    });
  });

  describe('integration with multiple symbols', () => {
    beforeEach(async () => {
      await divergenceTracker.init({ divergenceTracker: { enableSnapshots: false } });
    });

    it('should track spreads independently per symbol', () => {
      // BTC ticks
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50100 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      // ETH ticks
      const ethCallbacks = mockRtdsSubscriptions.get('eth');
      for (const cb of ethCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'eth', price: 3030 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'eth', price: 3000 });
      }

      expect(divergenceTracker.getSpread('btc').raw).toBe(100);
      expect(divergenceTracker.getSpread('eth').raw).toBe(30);
      expect(divergenceTracker.getSpread('sol')).toBeNull();
    });

    it('should detect breaches independently per symbol', () => {
      const breachCallback = vi.fn();
      divergenceTracker.subscribeToBreaches(breachCallback);

      // BTC breach
      const btcCallbacks = mockRtdsSubscriptions.get('btc');
      for (const cb of btcCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'btc', price: 50250 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'btc', price: 50000 });
      }

      // ETH no breach
      const ethCallbacks = mockRtdsSubscriptions.get('eth');
      for (const cb of ethCallbacks) {
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES, symbol: 'eth', price: 3001 });
        cb({ timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES_CHAINLINK, symbol: 'eth', price: 3000 });
      }

      expect(breachCallback).toHaveBeenCalledTimes(1);
      expect(breachCallback).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'btc' })
      );
    });
  });
});
