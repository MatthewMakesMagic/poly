/**
 * Strategy Evaluator Module Integration Tests
 *
 * Tests the public interface of the strategy evaluator module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import * as strategyEvaluator from '../index.js';
import { StrategyEvaluatorErrorCodes, Direction } from '../types.js';

// Test configuration
const mockConfig = {
  strategy: {
    entry: {
      spotLagThresholdPct: 0.02,
      minConfidence: 0.6,
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
      expect(state.thresholds.spot_lag_threshold_pct).toBe(0.02);
      expect(state.thresholds.min_confidence).toBe(0.6);
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

    it('throws on invalid spotLagThresholdPct (negative)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { spotLagThresholdPct: -0.01 } },
      })).rejects.toThrow('spotLagThresholdPct must be a number between 0 and 1');
    });

    it('throws on invalid spotLagThresholdPct (zero)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { spotLagThresholdPct: 0 } },
      })).rejects.toThrow('spotLagThresholdPct must be a number between 0 and 1');
    });

    it('throws on invalid spotLagThresholdPct (>= 1)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { spotLagThresholdPct: 1.0 } },
      })).rejects.toThrow('spotLagThresholdPct must be a number between 0 and 1');
    });

    it('throws on invalid minConfidence (negative)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { minConfidence: -0.1 } },
      })).rejects.toThrow('minConfidence must be a number between 0 and 1');
    });

    it('throws on invalid minConfidence (> 1)', async () => {
      await expect(strategyEvaluator.init({
        strategy: { entry: { minConfidence: 1.5 } },
      })).rejects.toThrow('minConfidence must be a number between 0 and 1');
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

    it('returns signal when conditions met', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 43680,        // 4% higher (high confidence)
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe(Direction.LONG);
      expect(signals[0].window_id).toBe('test-window');
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.6);
    });

    it('returns empty array when lag below threshold', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 42100,        // ~0.2% lag, below threshold
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toEqual([]);
    });

    it('returns empty array when time remaining below minimum', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 43680,        // Good lag
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
          time_remaining_ms: 30000, // 30 seconds - below minimum
        }],
      });

      expect(signals).toEqual([]);
    });

    it('evaluates multiple windows independently', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 43680,        // 4% higher
        windows: [
          {
            window_id: 'window-1',
            market_id: 'btc',
            market_price: 42000,
            time_remaining_ms: 600000,
          },
          {
            window_id: 'window-2',
            market_id: 'eth',
            market_price: 42000,
            time_remaining_ms: 600000,
          },
          {
            window_id: 'window-3',
            market_id: 'sol',
            market_price: 43680,  // Same as spot - no lag
            time_remaining_ms: 600000,
          },
        ],
      });

      // First two windows should generate signals, third should not
      expect(signals).toHaveLength(2);
      expect(signals[0].window_id).toBe('window-1');
      expect(signals[1].window_id).toBe('window-2');
    });

    it('includes window_id in all signals', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 43680,
        windows: [{
          window_id: 'specific-window-id',
          market_id: 'btc',
          market_price: 42000,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0].window_id).toBe('specific-window-id');
    });

    it('includes market_id in all signals', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 43680,
        windows: [{
          window_id: 'test-window',
          market_id: 'specific-market-id',
          market_price: 42000,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals[0].market_id).toBe('specific-market-id');
    });

    it('signal includes all required fields', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 43680,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
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

    it('handles short direction when spot below market', () => {
      const signals = strategyEvaluator.evaluateEntryConditions({
        spot_price: 40320,        // 4% lower
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
          time_remaining_ms: 600000,
        }],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].direction).toBe(Direction.SHORT);
      expect(signals[0].spot_lag).toBeLessThan(0);
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
      expect(state.thresholds.spot_lag_threshold_pct).toBe(0.02);
      expect(state.thresholds.min_confidence).toBe(0.6);
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
        spot_price: 43680,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
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

      // Evaluate with no signal
      strategyEvaluator.evaluateEntryConditions({
        spot_price: 42000,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,  // No lag
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
        spot_price: 43680,
        windows: [{
          window_id: 'test-window',
          market_id: 'btc',
          market_price: 42000,
          time_remaining_ms: 600000,
        }],
      });

      await strategyEvaluator.shutdown();

      const state = strategyEvaluator.getState();
      expect(state.evaluation_count).toBe(0);
      expect(state.signals_generated).toBe(0);
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
