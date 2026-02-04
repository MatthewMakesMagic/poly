/**
 * Strategy Evaluator Module Integration Tests
 *
 * Tests the public interface of the strategy evaluator module.
 * Tests the simple threshold strategy: enter when token price > 70%
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
import * as strategyEvaluator from '../index.js';
import { StrategyEvaluatorErrorCodes, Direction } from '../types.js';

// Test configuration - simple threshold strategy
const mockConfig = {
  strategy: {
    entry: {
      entryThresholdPct: 0.70, // 70% threshold
    },
  },
  trading: {
    minTimeRemainingMs: 60000,
  },
};

describe('StrategyEvaluator Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await strategyEvaluator.shutdown();
  });

  afterEach(async () => {
    await strategyEvaluator.shutdown();
  });

  describe('init()', () => {
    it('initializes successfully with valid config', async () => {
      await strategyEvaluator.init(mockConfig);

      const state = strategyEvaluator.getState();
      expect(state.initialized).toBe(true);
    });

    it('uses default thresholds when config not provided', async () => {
      await strategyEvaluator.init({});

      const state = strategyEvaluator.getState();
      expect(state.initialized).toBe(true);
      expect(state.thresholds.entry_threshold_pct).toBe(0.70);
      expect(state.thresholds.min_time_remaining_ms).toBe(60000);
    });

    it('extracts minTimeRemainingMs from trading config', async () => {
      await strategyEvaluator.init({
        trading: { minTimeRemainingMs: 120000 },
      });

      const state = strategyEvaluator.getState();
      expect(state.thresholds.min_time_remaining_ms).toBe(120000);
    });

    it('is idempotent - multiple calls do not error', async () => {
      await strategyEvaluator.init(mockConfig);
      await strategyEvaluator.init(mockConfig);

      expect(strategyEvaluator.getState().initialized).toBe(true);
    });

    it('throws on invalid entryThresholdPct (negative)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { entryThresholdPct: -0.01 } },
      })).rejects.toThrow('entryThresholdPct must be a number between 0 and 1');
    });

    it('throws on invalid entryThresholdPct (zero)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { entryThresholdPct: 0 } },
      })).rejects.toThrow('entryThresholdPct must be a number between 0 and 1');
    });

    it('throws on invalid entryThresholdPct (>= 1)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { entryThresholdPct: 1.0 } },
      })).rejects.toThrow('entryThresholdPct must be a number between 0 and 1');
    });

    it('throws on invalid minTimeRemainingMs (negative)', async () => {
      await expect(strategyEvaluator.init({
        trading: { minTimeRemainingMs: -1000 },
      })).rejects.toThrow('minTimeRemainingMs must be a non-negative number');
    });
  });

  describe('evaluateEntryConditions()', () => {
    beforeEach(async () => {
      await strategyEvaluator.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await strategyEvaluator.shutdown();

      expect(() => strategyEvaluator.evaluateEntryConditions({
        spot_price: 42000,
        windows: [],
      })).toThrow('Strategy evaluator not initialized');
    });

    it('returns empty array when no windows', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 42000,
        windows: [],
      });

      expect(signals).toEqual([]);
    });

    it('returns signal when price above 70%', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.75, // 75% - above threshold
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe(Direction.LONG);
      expect(signals[0].window_id).toBe('test-window');
    });

    it('returns empty array when price below 70%', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.65, // 65% - below threshold
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toEqual([]);
    });

    it('returns empty array when time remaining below minimum', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.75, // Good price
          time_remaining_ms: 30000, // 30 seconds - below minimum
        }],
      });

      expect(signals).toEqual([]);
    });

    it('evaluates multiple windows independently', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [
          {
            window_id: 'window-1',
            market_id: 'btc-up',
            market_price: 0.80, // Above threshold
            time_remaining_ms: 600000,
          },
          {
            window_id: 'window-2',
            market_id: 'btc-down',
            market_price: 0.75, // Above threshold
            time_remaining_ms: 600000,
          },
          {
            window_id: 'window-3',
            market_id: 'eth-up',
            market_price: 0.50, // Below threshold
            time_remaining_ms: 600000,
          },
        ],
      });

      // First two windows should generate signals, third should not
      expect(signals).toHaveLength(2);
      expect(signals[0].window_id).toBe('window-1');
      expect(signals[1].window_id).toBe('window-2');
    });

    // V3 Stage 4: Duplicate window entry prevention moved to DB-level safeguards module.
    // The strategy evaluator now always evaluates windows independently;
    // duplicate prevention is handled by position-manager/safeguards.js using
    // the window_entries table in PostgreSQL.
    it('evaluates same window on subsequent calls (duplicate prevention is DB-level)', () => {
      // First evaluation - should generate signal
      const signals1 = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'same-window',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals1).toHaveLength(1);

      // Second evaluation on same window - also generates signal
      // (duplicate prevention is now at the safeguards/DB level, not evaluator level)
      const signals2 = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'same-window',
          market_id: 'btc-up',
          market_price: 0.85,
          time_remaining_ms: 500000,
        }],
      });

      expect(signals2).toHaveLength(1);
    });

    it('different windows can each generate signals', () => {
      const signals1 = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'window-a',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      const signals2 = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'window-b',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals1).toHaveLength(1);
      expect(signals2).toHaveLength(1);
      expect(signals1[0].window_id).toBe('window-a');
      expect(signals2[0].window_id).toBe('window-b');
    });

    it('includes window_id in all signals', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'specific-window-id',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0].window_id).toBe('specific-window-id');
    });

    it('includes market_id in all signals', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'specific-market-id',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0].market_id).toBe('specific-market-id');
    });

    it('signal includes all required fields', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0]).toHaveProperty('window_id');
      expect(signals[0]).toHaveProperty('market_id');
      expect(signals[0]).toHaveProperty('direction');
      expect(signals[0]).toHaveProperty('confidence');
      expect(signals[0]).toHaveProperty('spot_price');
      expect(signals[0]).toHaveProperty('market_price');
      expect(signals[0]).toHaveProperty('spot_lag');
      expect(signals[0]).toHaveProperty('spot_lag_pct');
      expect(signals[0]).toHaveProperty('time_remaining_ms');
      expect(signals[0]).toHaveProperty('signal_at');
    });

    it('always generates LONG direction (buying the high-conviction token)', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-down', // Even for "down" token
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe(Direction.LONG);
    });

    it('confidence equals market price (capped at 0.95)', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.85,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0].confidence).toBe(0.85);
    });

    it('caps confidence at 0.95 for very high prices', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.98,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0].confidence).toBe(0.95);
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state before init', () => {
      const state = strategyEvaluator.getState();

      expect(state.initialized).toBe(false);
      expect(state.thresholds).toBeNull();
    });

    it('returns initialized state with thresholds after init', async () => {
      await strategyEvaluator.init(mockConfig);

      const state = strategyEvaluator.getState();

      expect(state.initialized).toBe(true);
      expect(state.thresholds).toBeDefined();
      expect(state.thresholds.entry_threshold_pct).toBe(0.70);
      expect(state.thresholds.min_time_remaining_ms).toBe(60000);
    });

    it('includes evaluation stats', async () => {
      await strategyEvaluator.init(mockConfig);

      const state = strategyEvaluator.getState();

      expect(state.evaluation_count).toBe(0);
      expect(state.signals_generated).toBe(0);
      expect(state.last_evaluation_at).toBeNull();
      expect(state.last_signal_at).toBeNull();
    });

    it('updates stats after evaluation', async () => {
      await strategyEvaluator.init(mockConfig);

      strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      const state = strategyEvaluator.getState();

      expect(state.evaluation_count).toBe(1);
      expect(state.signals_generated).toBe(1);
      expect(state.last_evaluation_at).not.toBeNull();
      expect(state.last_signal_at).not.toBeNull();
    });

    it('tracks evaluation count separately from signal count', async () => {
      await strategyEvaluator.init(mockConfig);

      // Evaluate with no signal (price below threshold)
      strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.50, // Below 70% threshold
          time_remaining_ms: 600000,
        }],
      });

      const state = strategyEvaluator.getState();

      expect(state.evaluation_count).toBe(1);
      expect(state.signals_generated).toBe(0);
    });
  });

  describe('shutdown()', () => {
    it('resets state to uninitialized', async () => {
      await strategyEvaluator.init(mockConfig);
      expect(strategyEvaluator.getState().initialized).toBe(true);

      await strategyEvaluator.shutdown();

      expect(strategyEvaluator.getState().initialized).toBe(false);
      expect(strategyEvaluator.getState().thresholds).toBeNull();
    });

    it('resets evaluation stats', async () => {
      await strategyEvaluator.init(mockConfig);

      strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      await strategyEvaluator.shutdown();

      const state = strategyEvaluator.getState();
      expect(state.evaluation_count).toBe(0);
      expect(state.signals_generated).toBe(0);
    });

    it('clears window entry tracking', async () => {
      await strategyEvaluator.init(mockConfig);

      // Enter a window
      strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      await strategyEvaluator.shutdown();
      await strategyEvaluator.init(mockConfig);

      // Should be able to enter the same window again after restart
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 100000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc-up',
          market_price: 0.80,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toHaveLength(1);
    });

    it('is idempotent - can be called multiple times', async () => {
      await strategyEvaluator.init(mockConfig);
      await strategyEvaluator.shutdown();
      await strategyEvaluator.shutdown();

      expect(strategyEvaluator.getState().initialized).toBe(false);
    });

    it('allows reinitialization after shutdown', async () => {
      await strategyEvaluator.init(mockConfig);
      await strategyEvaluator.shutdown();
      await strategyEvaluator.init(mockConfig);

      expect(strategyEvaluator.getState().initialized).toBe(true);
    });
  });

  describe('module exports', () => {
    it('exports standard interface (init, getState, shutdown)', () => {
      expect(typeof strategyEvaluator.init).toBe('function');
      expect(typeof strategyEvaluator.getState).toBe('function');
      expect(typeof strategyEvaluator.shutdown).toBe('function');
    });

    it('exports evaluateEntryConditions', () => {
      expect(typeof strategyEvaluator.evaluateEntryConditions).toBe('function');
    });

    it('exports error types', () => {
      expect(strategyEvaluator.StrategyEvaluatorError).toBeDefined();
      expect(strategyEvaluator.StrategyEvaluatorErrorCodes).toBeDefined();
    });

    it('exports Direction and NoSignalReason', () => {
      expect(strategyEvaluator.Direction).toBeDefined();
      expect(strategyEvaluator.NoSignalReason).toBeDefined();
    });
  });
});
