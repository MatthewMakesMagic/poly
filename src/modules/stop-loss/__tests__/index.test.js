/**
 * Stop-Loss Module Integration Tests
 *
 * Tests the public interface of the stop-loss module.
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
import * as stopLoss from '../index.js';
import { StopLossErrorCodes, TriggerReason } from '../types.js';

// Test configuration
const mockConfig = {
  strategy: {
    stopLoss: {
      enabled: true,
      defaultStopLossPct: 0.05,
    },
  },
};

// Mock position for tests
const mockPosition = {
  id: 1,
  window_id: 'btc-15m-2026-01-31-10:15',
  side: 'long',
  size: 10,
  entry_price: 0.50,
};

describe('StopLoss Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopLoss.shutdown();
  });

  afterEach(async () => {
    await stopLoss.shutdown();
  });

  describe('init()', () => {
    it('initializes successfully with valid config', async () => {
      await stopLoss.init(mockConfig);

      const state = stopLoss.getState();
      expect(state.initialized).toBe(true);
    });

    it('uses default values when config not provided', async () => {
      await stopLoss.init({});

      const state = stopLoss.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(true);
      expect(state.config.default_stop_loss_pct).toBe(0.30);
      expect(state.config.absolute_floor).toBe(0.15);
      expect(state.config.absolute_ceiling).toBe(0.85);
    });

    it('is idempotent - multiple calls do not error', async () => {
      await stopLoss.init(mockConfig);
      await stopLoss.init(mockConfig);

      expect(stopLoss.getState().initialized).toBe(true);
    });

    it('throws on invalid enabled (non-boolean)', async () => {
      await expect(stopLoss.init({
        strategy: { stopLoss: { enabled: 'yes' } },
      })).rejects.toThrow('enabled must be a boolean');
    });

    it('throws on invalid defaultStopLossPct (negative)', async () => {
      await expect(stopLoss.init({
        strategy: { stopLoss: { defaultStopLossPct: -0.05 } },
      })).rejects.toThrow('defaultStopLossPct must be a number between 0 and 1');
    });

    it('throws on invalid defaultStopLossPct (greater than 1)', async () => {
      await expect(stopLoss.init({
        strategy: { stopLoss: { defaultStopLossPct: 1.5 } },
      })).rejects.toThrow('defaultStopLossPct must be a number between 0 and 1');
    });

    it('throws on invalid defaultStopLossPct (non-number)', async () => {
      await expect(stopLoss.init({
        strategy: { stopLoss: { defaultStopLossPct: '5%' } },
      })).rejects.toThrow('defaultStopLossPct must be a number between 0 and 1');
    });

    it('accepts disabled configuration', async () => {
      await stopLoss.init({
        strategy: { stopLoss: { enabled: false, defaultStopLossPct: 0.05 } },
      });

      const state = stopLoss.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(false);
    });
  });

  describe('evaluate()', () => {
    beforeEach(async () => {
      await stopLoss.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await stopLoss.shutdown();

      expect(() => stopLoss.evaluate(mockPosition, 0.47))
        .toThrow('Stop-loss module not initialized');
    });

    it('triggers when long position price drops below threshold', () => {
      const result = stopLoss.evaluate(mockPosition, 0.47); // 6% drop

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_BELOW_THRESHOLD);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('market');
    });

    it('does NOT trigger when long position price is safe', () => {
      const result = stopLoss.evaluate(mockPosition, 0.48); // 4% drop

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe(TriggerReason.NOT_TRIGGERED);
      expect(result.action).toBeNull();
      expect(result.closeMethod).toBeNull();
    });

    it('triggers when short position price rises above threshold', () => {
      const shortPosition = { ...mockPosition, id: 2, side: 'short' };
      const result = stopLoss.evaluate(shortPosition, 0.53); // 6% rise

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_ABOVE_THRESHOLD);
    });

    it('returns non-triggered result when stop-loss is disabled', async () => {
      await stopLoss.shutdown();
      await stopLoss.init({
        strategy: { stopLoss: { enabled: false, defaultStopLossPct: 0.05 } },
      });

      const result = stopLoss.evaluate(mockPosition, 0.47);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('stop_loss_disabled');
    });

    it('uses per-position stop_loss_pct when available', () => {
      const positionWithOverride = { ...mockPosition, stop_loss_pct: 0.10 };
      const result = stopLoss.evaluate(positionWithOverride, 0.47); // 6% drop

      expect(result.triggered).toBe(false); // 6% < 10%
      expect(result.stop_loss_pct).toBe(0.10);
    });

    it('includes all required fields in result', () => {
      const result = stopLoss.evaluate(mockPosition, 0.47);

      expect(result).toHaveProperty('triggered');
      expect(result).toHaveProperty('position_id');
      expect(result).toHaveProperty('window_id');
      expect(result).toHaveProperty('side');
      expect(result).toHaveProperty('entry_price');
      expect(result).toHaveProperty('current_price');
      expect(result).toHaveProperty('stop_loss_threshold');
      expect(result).toHaveProperty('stop_loss_pct');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('closeMethod');
      expect(result).toHaveProperty('loss_amount');
      expect(result).toHaveProperty('loss_pct');
      expect(result).toHaveProperty('evaluated_at');
    });
  });

  describe('evaluateAll()', () => {
    beforeEach(async () => {
      await stopLoss.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await stopLoss.shutdown();

      expect(() => stopLoss.evaluateAll([mockPosition], () => 0.47))
        .toThrow('Stop-loss module not initialized');
    });

    it('evaluates multiple positions and returns triggered', () => {
      const positions = [
        { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
        { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50 },
        { id: 3, window_id: 'w3', side: 'short', size: 10, entry_price: 0.50 },
      ];

      const getCurrentPrice = (pos) => {
        if (pos.id === 1) return 0.47;  // Triggered
        if (pos.id === 2) return 0.50;  // Safe
        if (pos.id === 3) return 0.53;  // Triggered
        return null;
      };

      const { triggered, summary } = stopLoss.evaluateAll(positions, getCurrentPrice);

      expect(triggered.length).toBe(2);
      expect(summary.evaluated).toBe(3);
      expect(summary.triggered).toBe(2);
      expect(summary.safe).toBe(1);
    });

    it('returns empty when no positions', () => {
      const { triggered, summary } = stopLoss.evaluateAll([], () => 0.50);

      expect(triggered.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });

    it('returns empty when positions is null', () => {
      const { triggered, summary } = stopLoss.evaluateAll(null, () => 0.50);

      expect(triggered.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });

    it('returns empty when stop-loss is disabled', async () => {
      await stopLoss.shutdown();
      await stopLoss.init({
        strategy: { stopLoss: { enabled: false, defaultStopLossPct: 0.05 } },
      });

      const positions = [
        { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
      ];

      const { triggered, summary } = stopLoss.evaluateAll(positions, () => 0.47);

      expect(triggered.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state before init', () => {
      const state = stopLoss.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });

    it('returns initialized state with config after init', async () => {
      await stopLoss.init(mockConfig);

      const state = stopLoss.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.config.enabled).toBe(true);
      expect(state.config.default_stop_loss_pct).toBe(0.05);
    });

    it('includes evaluation stats', async () => {
      await stopLoss.init(mockConfig);

      const state = stopLoss.getState();

      expect(state.evaluation_count).toBe(0);
      expect(state.triggered_count).toBe(0);
      expect(state.safe_count).toBe(0);
      expect(state.last_evaluation_at).toBeNull();
    });

    it('updates stats after evaluations', async () => {
      await stopLoss.init(mockConfig);

      stopLoss.evaluate(mockPosition, 0.47); // Triggered
      stopLoss.evaluate(mockPosition, 0.50); // Safe

      const state = stopLoss.getState();

      expect(state.evaluation_count).toBe(2);
      expect(state.triggered_count).toBe(1);
      expect(state.safe_count).toBe(1);
      expect(state.last_evaluation_at).not.toBeNull();
    });
  });

  describe('shutdown()', () => {
    it('resets state to uninitialized', async () => {
      await stopLoss.init(mockConfig);
      expect(stopLoss.getState().initialized).toBe(true);

      await stopLoss.shutdown();

      expect(stopLoss.getState().initialized).toBe(false);
      expect(stopLoss.getState().config).toBeNull();
    });

    it('resets evaluation stats', async () => {
      await stopLoss.init(mockConfig);
      stopLoss.evaluate(mockPosition, 0.47);

      await stopLoss.shutdown();

      const state = stopLoss.getState();
      expect(state.evaluation_count).toBe(0);
      expect(state.triggered_count).toBe(0);
    });

    it('is idempotent - can be called multiple times', async () => {
      await stopLoss.init(mockConfig);
      await stopLoss.shutdown();
      await stopLoss.shutdown();

      expect(stopLoss.getState().initialized).toBe(false);
    });

    it('allows reinitialization after shutdown', async () => {
      await stopLoss.init(mockConfig);
      await stopLoss.shutdown();
      await stopLoss.init(mockConfig);

      expect(stopLoss.getState().initialized).toBe(true);
    });
  });

  describe('module exports', () => {
    it('exports standard interface (init, getState, shutdown)', () => {
      expect(typeof stopLoss.init).toBe('function');
      expect(typeof stopLoss.getState).toBe('function');
      expect(typeof stopLoss.shutdown).toBe('function');
    });

    it('exports evaluate and evaluateAll', () => {
      expect(typeof stopLoss.evaluate).toBe('function');
      expect(typeof stopLoss.evaluateAll).toBe('function');
    });

    it('exports error types', () => {
      expect(stopLoss.StopLossError).toBeDefined();
      expect(stopLoss.StopLossErrorCodes).toBeDefined();
    });

    it('exports TriggerReason', () => {
      expect(stopLoss.TriggerReason).toBeDefined();
      expect(stopLoss.TriggerReason.PRICE_BELOW_THRESHOLD).toBe('price_below_threshold');
      expect(stopLoss.TriggerReason.PRICE_ABOVE_THRESHOLD).toBe('price_above_threshold');
      expect(stopLoss.TriggerReason.NOT_TRIGGERED).toBe('not_triggered');
    });

    it('exports createStopLossResult', () => {
      expect(stopLoss.createStopLossResult).toBeDefined();
      expect(typeof stopLoss.createStopLossResult).toBe('function');
    });
  });
});
