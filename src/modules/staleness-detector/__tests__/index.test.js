/**
 * Staleness Detector Module Interface Tests
 *
 * Tests for the public module interface:
 * - init/shutdown lifecycle
 * - getStaleness/isStale queries
 * - subscribeToStaleness event subscription
 * - getState
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as stalenessDetector from '../index.js';
import { StalenessDetectorError, StalenessDetectorErrorCodes } from '../types.js';

// Mock the logger module
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock oracle-tracker module
vi.mock('../../oracle-tracker/index.js', () => ({
  getState: vi.fn(() => ({
    initialized: true,
    tracking: {
      btc: { last_price: 95000, last_update_at: new Date(Date.now() - 5000).toISOString() },
      eth: { last_price: 3500, last_update_at: new Date(Date.now() - 5000).toISOString() },
      sol: { last_price: 150, last_update_at: new Date(Date.now() - 5000).toISOString() },
      xrp: { last_price: 0.5, last_update_at: new Date(Date.now() - 5000).toISOString() },
    },
  })),
}));

describe('Staleness Detector Module', () => {
  beforeEach(async () => {
    // Reset module state
    await stalenessDetector.shutdown();
  });

  afterEach(async () => {
    await stalenessDetector.shutdown();
  });

  describe('init', () => {
    test('initializes with default config', async () => {
      await stalenessDetector.init();

      const state = stalenessDetector.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.config.stalenessThresholdMs).toBe(15000);
      expect(state.config.minDivergencePct).toBe(0.001);
      expect(state.config.chainlinkDeviationThresholdPct).toBe(0.005);
      expect(state.config.scoreThreshold).toBe(0.6);
    });

    test('initializes with custom config', async () => {
      await stalenessDetector.init({
        stalenessDetector: {
          stalenessThresholdMs: 10000,
          minDivergencePct: 0.002,
          chainlinkDeviationThresholdPct: 0.004,
          scoreThreshold: 0.7,
        },
      });

      const state = stalenessDetector.getState();

      expect(state.config.stalenessThresholdMs).toBe(10000);
      expect(state.config.minDivergencePct).toBe(0.002);
      expect(state.config.chainlinkDeviationThresholdPct).toBe(0.004);
      expect(state.config.scoreThreshold).toBe(0.7);
    });

    test('is idempotent', async () => {
      await stalenessDetector.init();
      await stalenessDetector.init(); // Second call should be no-op

      const state = stalenessDetector.getState();
      expect(state.initialized).toBe(true);
    });

    test('throws on invalid stalenessThresholdMs', async () => {
      await expect(
        stalenessDetector.init({
          stalenessDetector: { stalenessThresholdMs: 0 },
        })
      ).rejects.toThrow(StalenessDetectorError);
    });

    test('throws on invalid minDivergencePct', async () => {
      await expect(
        stalenessDetector.init({
          stalenessDetector: { minDivergencePct: 0.01, chainlinkDeviationThresholdPct: 0.005 },
        })
      ).rejects.toThrow(StalenessDetectorError);
    });

    test('throws on invalid scoreThreshold', async () => {
      await expect(
        stalenessDetector.init({
          stalenessDetector: { scoreThreshold: 1.5 },
        })
      ).rejects.toThrow(StalenessDetectorError);
    });
  });

  describe('getStaleness', () => {
    test('throws when not initialized', () => {
      expect(() => stalenessDetector.getStaleness('btc')).toThrow(StalenessDetectorError);
      expect(() => stalenessDetector.getStaleness('btc')).toThrow('not initialized');
    });

    test('throws on invalid symbol', async () => {
      await stalenessDetector.init();

      expect(() => stalenessDetector.getStaleness('invalid')).toThrow(StalenessDetectorError);
      expect(() => stalenessDetector.getStaleness('invalid')).toThrow('Invalid symbol');
    });

    test('returns evaluation for valid symbol', async () => {
      await stalenessDetector.init();

      const result = stalenessDetector.getStaleness('btc');

      expect(result).toHaveProperty('symbol', 'btc');
      expect(result).toHaveProperty('is_stale');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('conditions');
      expect(result).toHaveProperty('inputs');
      expect(result).toHaveProperty('evaluated_at');
    });

    test('returns evaluation for all supported symbols', async () => {
      await stalenessDetector.init();

      const symbols = ['btc', 'eth', 'sol', 'xrp'];

      for (const symbol of symbols) {
        const result = stalenessDetector.getStaleness(symbol);
        expect(result.symbol).toBe(symbol);
        expect(typeof result.is_stale).toBe('boolean');
      }
    });
  });

  describe('isStale', () => {
    test('throws when not initialized', () => {
      expect(() => stalenessDetector.isStale('btc')).toThrow(StalenessDetectorError);
    });

    test('throws on invalid symbol', async () => {
      await stalenessDetector.init();

      expect(() => stalenessDetector.isStale('invalid')).toThrow(StalenessDetectorError);
    });

    test('returns boolean for valid symbol', async () => {
      await stalenessDetector.init();

      const result = stalenessDetector.isStale('btc');

      expect(typeof result).toBe('boolean');
    });

    test('returns false when oracle recently updated', async () => {
      await stalenessDetector.init();

      // Mock data has 5 second old updates, should not be stale
      const result = stalenessDetector.isStale('btc');

      expect(result).toBe(false);
    });
  });

  describe('subscribeToStaleness', () => {
    test('throws when not initialized', () => {
      expect(() => stalenessDetector.subscribeToStaleness(() => {})).toThrow(StalenessDetectorError);
    });

    test('throws when callback is not a function', async () => {
      await stalenessDetector.init();

      expect(() => stalenessDetector.subscribeToStaleness('not a function')).toThrow(StalenessDetectorError);
      expect(() => stalenessDetector.subscribeToStaleness(null)).toThrow(StalenessDetectorError);
    });

    test('returns unsubscribe function', async () => {
      await stalenessDetector.init();

      const unsubscribe = stalenessDetector.subscribeToStaleness(() => {});

      expect(typeof unsubscribe).toBe('function');
    });

    test('unsubscribe function works', async () => {
      await stalenessDetector.init();

      const callback = vi.fn();
      const unsubscribe = stalenessDetector.subscribeToStaleness(callback);

      unsubscribe();

      // Trigger evaluation - callback should not be called
      stalenessDetector.getStaleness('btc');

      // Note: callback would only be called on state transitions, not queries
      // This test just verifies unsubscribe doesn't throw
    });
  });

  describe('getState', () => {
    test('returns uninitialized state before init', () => {
      const state = stalenessDetector.getState();

      expect(state.initialized).toBe(false);
      expect(state.staleness).toEqual({});
      expect(state.stats.staleness_events_emitted).toBe(0);
      expect(state.config).toBeNull();
    });

    test('returns initialized state after init', async () => {
      await stalenessDetector.init();

      const state = stalenessDetector.getState();

      expect(state.initialized).toBe(true);
      expect(state.staleness).toBeDefined();
      expect(state.stats).toBeDefined();
      expect(state.config).toBeDefined();
    });

    test('includes all expected state properties', async () => {
      await stalenessDetector.init();

      const state = stalenessDetector.getState();

      expect(state).toHaveProperty('initialized');
      expect(state).toHaveProperty('staleness');
      expect(state).toHaveProperty('stats');
      expect(state).toHaveProperty('config');

      expect(state.stats).toHaveProperty('staleness_events_emitted');
      expect(state.stats).toHaveProperty('resolutions_detected');
      expect(state.stats).toHaveProperty('avg_staleness_duration_ms');
    });
  });

  describe('shutdown', () => {
    test('clears initialized state', async () => {
      await stalenessDetector.init();
      expect(stalenessDetector.getState().initialized).toBe(true);

      await stalenessDetector.shutdown();

      expect(stalenessDetector.getState().initialized).toBe(false);
    });

    test('is idempotent', async () => {
      await stalenessDetector.init();
      await stalenessDetector.shutdown();
      await stalenessDetector.shutdown(); // Should not throw

      expect(stalenessDetector.getState().initialized).toBe(false);
    });

    test('allows re-initialization after shutdown', async () => {
      await stalenessDetector.init();
      await stalenessDetector.shutdown();

      await stalenessDetector.init({
        stalenessDetector: { stalenessThresholdMs: 20000 },
      });

      const state = stalenessDetector.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.stalenessThresholdMs).toBe(20000);
    });
  });

  describe('error codes', () => {
    test('exports expected error codes', () => {
      expect(StalenessDetectorErrorCodes.NOT_INITIALIZED).toBe('STALENESS_DETECTOR_NOT_INITIALIZED');
      expect(StalenessDetectorErrorCodes.INVALID_SYMBOL).toBe('STALENESS_DETECTOR_INVALID_SYMBOL');
      expect(StalenessDetectorErrorCodes.INVALID_CONFIG).toBe('STALENESS_DETECTOR_INVALID_CONFIG');
      expect(StalenessDetectorErrorCodes.TRACKER_UNAVAILABLE).toBe('STALENESS_DETECTOR_TRACKER_UNAVAILABLE');
      expect(StalenessDetectorErrorCodes.SUBSCRIPTION_FAILED).toBe('STALENESS_DETECTOR_SUBSCRIPTION_FAILED');
    });

    test('StalenessDetectorError has correct properties', () => {
      const error = new StalenessDetectorError(
        StalenessDetectorErrorCodes.INVALID_SYMBOL,
        'Test error message',
        { symbol: 'test' }
      );

      expect(error.code).toBe('STALENESS_DETECTOR_INVALID_SYMBOL');
      expect(error.message).toBe('Test error message');
      expect(error.context).toEqual({ symbol: 'test' });
      expect(error.name).toBe('StalenessDetectorError');
      expect(error instanceof Error).toBe(true);
    });
  });
});
