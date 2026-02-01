/**
 * Lag Tracker Module Interface Tests
 *
 * Tests for the public module interface: init, getState, shutdown,
 * analyze, getLagSignal, getStability.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as lagTracker from '../index.js';

// Mock the dependencies
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../clients/rtds/index.js', () => ({
  subscribe: vi.fn(() => vi.fn()), // Returns unsubscribe function
  SUPPORTED_SYMBOLS: ['btc', 'eth', 'sol', 'xrp'],
  TOPICS: {
    CRYPTO_PRICES: 'crypto_prices',
    CRYPTO_PRICES_CHAINLINK: 'crypto_prices_chainlink',
  },
}));

vi.mock('../../../clients/rtds/types.js', () => ({
  SUPPORTED_SYMBOLS: ['btc', 'eth', 'sol', 'xrp'],
  TOPICS: {
    CRYPTO_PRICES: 'crypto_prices',
    CRYPTO_PRICES_CHAINLINK: 'crypto_prices_chainlink',
  },
}));

vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(() => []),
    transaction: vi.fn((fn) => fn()),
  },
}));

describe('lagTracker module', () => {
  afterEach(async () => {
    await lagTracker.shutdown();
  });

  describe('init', () => {
    it('should initialize successfully with default config', async () => {
      await lagTracker.init({});

      const state = lagTracker.getState();
      expect(state.initialized).toBe(true);
    });

    it('should initialize with custom config', async () => {
      await lagTracker.init({
        lagTracker: {
          bufferMaxAgeMs: 30000,
          minCorrelation: 0.6,
        },
      });

      const state = lagTracker.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.bufferMaxAgeMs).toBe(30000);
      expect(state.config.minCorrelation).toBe(0.6);
    });

    it('should not reinitialize if already initialized', async () => {
      await lagTracker.init({});
      await lagTracker.init({}); // Second call should be no-op

      const state = lagTracker.getState();
      expect(state.initialized).toBe(true);
    });
  });

  describe('getState', () => {
    it('should return uninitialized state before init', () => {
      const state = lagTracker.getState();

      expect(state.initialized).toBe(false);
    });

    it('should return full state after init', async () => {
      await lagTracker.init({});

      const state = lagTracker.getState();

      expect(state).toHaveProperty('initialized', true);
      expect(state).toHaveProperty('buffers');
      expect(state).toHaveProperty('analysis');
      expect(state).toHaveProperty('stability');
      expect(state).toHaveProperty('signals');
      expect(state).toHaveProperty('config');
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      await lagTracker.init({});
      await lagTracker.shutdown();

      const state = lagTracker.getState();
      expect(state.initialized).toBe(false);
    });

    it('should handle shutdown when not initialized', async () => {
      // Should not throw
      await lagTracker.shutdown();

      const state = lagTracker.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('analyze', () => {
    it('should throw if not initialized', () => {
      expect(() => lagTracker.analyze('btc')).toThrow('not initialized');
    });

    it('should throw for invalid symbol', async () => {
      await lagTracker.init({});

      expect(() => lagTracker.analyze('invalid')).toThrow('Invalid symbol');
    });

    it('should return null when insufficient data', async () => {
      await lagTracker.init({});

      const result = lagTracker.analyze('btc');
      expect(result).toBeNull();
    });
  });

  describe('getLagSignal', () => {
    it('should throw if not initialized', () => {
      expect(() => lagTracker.getLagSignal('btc')).toThrow('not initialized');
    });

    it('should throw for invalid symbol', async () => {
      await lagTracker.init({});

      expect(() => lagTracker.getLagSignal('invalid')).toThrow('Invalid symbol');
    });

    it('should return no signal for valid symbol', async () => {
      await lagTracker.init({});

      const signal = lagTracker.getLagSignal('btc');
      expect(signal.has_signal).toBe(false);
    });
  });

  describe('getStability', () => {
    it('should throw if not initialized', () => {
      expect(() => lagTracker.getStability('btc')).toThrow('not initialized');
    });

    it('should throw for invalid symbol', async () => {
      await lagTracker.init({});

      expect(() => lagTracker.getStability('invalid')).toThrow('Invalid symbol');
    });

    it('should return stability metrics for valid symbol', async () => {
      await lagTracker.init({});

      const stability = lagTracker.getStability('btc');

      expect(stability).toHaveProperty('stable');
      expect(stability).toHaveProperty('tau_history');
      expect(stability).toHaveProperty('variance');
    });
  });

  describe('recordOutcome', () => {
    it('should throw if not initialized', () => {
      expect(() => lagTracker.recordOutcome(1, {})).toThrow('not initialized');
    });
  });

  describe('getAccuracyStats', () => {
    it('should throw if not initialized', () => {
      expect(() => lagTracker.getAccuracyStats()).toThrow('not initialized');
    });

    it('should return accuracy statistics', async () => {
      await lagTracker.init({});

      const stats = lagTracker.getAccuracyStats();

      expect(stats).toHaveProperty('total_signals');
      expect(stats).toHaveProperty('total_correct');
      expect(stats).toHaveProperty('accuracy');
    });
  });
});

describe('LagTrackerError', () => {
  it('should be exported from module', async () => {
    expect(lagTracker.LagTrackerError).toBeDefined();
    expect(lagTracker.LagTrackerErrorCodes).toBeDefined();
  });

  it('should have correct error codes', () => {
    expect(lagTracker.LagTrackerErrorCodes.NOT_INITIALIZED).toBe('LAG_TRACKER_NOT_INITIALIZED');
    expect(lagTracker.LagTrackerErrorCodes.INVALID_SYMBOL).toBe('LAG_TRACKER_INVALID_SYMBOL');
  });
});
