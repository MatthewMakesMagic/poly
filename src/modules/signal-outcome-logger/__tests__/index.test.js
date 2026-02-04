/**
 * Signal Outcome Logger Module Tests
 *
 * Tests for the module public interface:
 * - init/shutdown lifecycle
 * - logSignal, updateOutcome exports
 * - getStats, getStatsByBucket, getRecentSignals exports
 * - getState
 * - Error handling for uninitialized state
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing module
vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn(() => ({ lastInsertRowid: 1 })),
  get: vi.fn(() => ({
    id: 1,
    window_id: 'btc-15m-1706745600',
    symbol: 'btc',
    signal_direction: 'fade_up',
    strike: 0.5,
    market_token_price: 0.72,
  })),
  all: vi.fn(() => []),
}));

// Mock oracle-edge-signal - will fail to load gracefully
vi.mock('../../oracle-edge-signal/index.js', () => {
  throw new Error('Module not available');
});

describe('signal-outcome-logger module', () => {
  let module;

  beforeEach(async () => {
    // Clear module cache and reimport
    vi.resetModules();
    module = await import('../index.js');
  });

  afterEach(async () => {
    if (module) {
      await module.shutdown();
    }
  });

  describe('init', () => {
    test('initializes successfully', async () => {
      await module.init({});

      const state = module.getState();
      expect(state.initialized).toBe(true);
    });

    test('uses default config when none provided', async () => {
      await module.init();

      const state = module.getState();
      expect(state.config.autoSubscribeToSignals).toBe(true);
      expect(state.config.defaultPositionSize).toBe(1);
    });

    test('accepts custom config', async () => {
      await module.init({
        signalOutcomeLogger: {
          defaultPositionSize: 5,
          retentionDays: 60,
        },
      });

      const state = module.getState();
      expect(state.config.defaultPositionSize).toBe(5);
      expect(state.config.retentionDays).toBe(60);
    });

    test('is idempotent', async () => {
      await module.init({});
      await module.init({});

      const state = module.getState();
      expect(state.initialized).toBe(true);
    });

    test('handles oracle-edge-signal unavailability gracefully', async () => {
      await module.init({});

      const state = module.getState();
      expect(state.initialized).toBe(true);
      expect(state.subscriptions.signal_generator).toBe(false);
    });

    test('throws for invalid defaultPositionSize', async () => {
      await expect(
        module.init({
          signalOutcomeLogger: {
            defaultPositionSize: -1,
          },
        })
      ).rejects.toThrow('defaultPositionSize must be a positive number');
    });

    test('throws for zero defaultPositionSize', async () => {
      await expect(
        module.init({
          signalOutcomeLogger: {
            defaultPositionSize: 0,
          },
        })
      ).rejects.toThrow('defaultPositionSize must be a positive number');
    });

    test('throws for invalid retentionDays', async () => {
      await expect(
        module.init({
          signalOutcomeLogger: {
            retentionDays: -5,
          },
        })
      ).rejects.toThrow('retentionDays must be a positive integer');
    });

    test('throws for non-integer retentionDays', async () => {
      await expect(
        module.init({
          signalOutcomeLogger: {
            retentionDays: 10.5,
          },
        })
      ).rejects.toThrow('retentionDays must be a positive integer');
    });
  });

  describe('shutdown', () => {
    test('shuts down successfully', async () => {
      await module.init({});
      await module.shutdown();

      const state = module.getState();
      expect(state.initialized).toBe(false);
    });

    test('is idempotent', async () => {
      await module.init({});
      await module.shutdown();
      await module.shutdown();

      const state = module.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('logSignal', () => {
    test('throws when not initialized', async () => {
      await expect(
        module.logSignal({ window_id: 'test' })
      ).rejects.toThrow('not initialized');
    });

    test('logs signal when initialized', async () => {
      await module.init({});

      const id = await module.logSignal({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
        direction: 'fade_up',
        confidence: 0.78,
        inputs: { market_price: 0.72 },
      });

      expect(id).toBeDefined();
    });
  });

  describe('updateOutcome', () => {
    test('throws when not initialized', async () => {
      await expect(
        module.updateOutcome('window-1', { final_oracle_price: 0.5 })
      ).rejects.toThrow('not initialized');
    });

    test('updates outcome when initialized', async () => {
      await module.init({});

      const result = await module.updateOutcome('btc-15m-1706745600', {
        final_oracle_price: 0.48,
        settlement_time: new Date().toISOString(),
      });

      expect(result).toBe(true);
    });
  });

  describe('getStats', () => {
    test('rejects when not initialized', async () => {
      await expect(module.getStats()).rejects.toThrow('not initialized');
    });

    test('returns stats when initialized', async () => {
      await module.init({});

      const stats = await module.getStats();

      expect(stats).toHaveProperty('total_signals');
      expect(stats).toHaveProperty('win_rate');
    });
  });

  describe('getStatsByBucket', () => {
    test('rejects when not initialized', async () => {
      await expect(module.getStatsByBucket('symbol')).rejects.toThrow('not initialized');
    });

    test('returns bucket stats when initialized', async () => {
      await module.init({});

      const stats = await module.getStatsByBucket('symbol');

      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('getRecentSignals', () => {
    test('rejects when not initialized', async () => {
      await expect(module.getRecentSignals()).rejects.toThrow('not initialized');
    });

    test('returns signals when initialized', async () => {
      await module.init({});

      const signals = await module.getRecentSignals(10);

      expect(Array.isArray(signals)).toBe(true);
    });
  });

  describe('subscribeToSettlements', () => {
    test('throws when not initialized', () => {
      expect(() => module.subscribeToSettlements(() => {})).toThrow('not initialized');
    });

    test('accepts settlement subscription when initialized', async () => {
      await module.init({});

      expect(() => module.subscribeToSettlements(() => () => {})).not.toThrow();
    });
  });

  describe('getState', () => {
    test('returns uninitialized state before init', () => {
      const state = module.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });

    test('returns initialized state after init', async () => {
      await module.init({});

      const state = module.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).not.toBeNull();
      expect(state.internal_stats).toBeDefined();
      expect(state.subscriptions).toBeDefined();
    });

    test('returns subscriptions status', async () => {
      await module.init({});

      const state = module.getState();

      expect(state.subscriptions).toHaveProperty('signal_generator');
      expect(state.subscriptions).toHaveProperty('settlements');
    });
  });

  describe('exports', () => {
    test('exports error classes', () => {
      expect(module.SignalOutcomeLoggerError).toBeDefined();
      expect(module.SignalOutcomeLoggerErrorCodes).toBeDefined();
    });

    test('exports BucketType enum', () => {
      expect(module.BucketType).toBeDefined();
      expect(module.BucketType.SYMBOL).toBe('symbol');
    });
  });
});
