/**
 * Take-Profit Module Integration Tests
 *
 * Tests the public interface of the take-profit module.
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
import * as takeProfit from '../index.js';
import { TakeProfitErrorCodes, TriggerReason } from '../types.js';

// Test configuration
const mockConfig = {
  strategy: {
    takeProfit: {
      enabled: true,
      defaultTakeProfitPct: 0.10,
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

describe('TakeProfit Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await takeProfit.shutdown();
  });

  afterEach(async () => {
    await takeProfit.shutdown();
  });

  describe('init()', () => {
    it('initializes successfully with valid config', async () => {
      await takeProfit.init(mockConfig);

      const state = takeProfit.getState();
      expect(state.initialized).toBe(true);
    });

    it('uses default values when config not provided', async () => {
      await takeProfit.init({});

      const state = takeProfit.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(true);
      expect(state.config.default_take_profit_pct).toBe(0.10);
    });

    it('is idempotent - multiple calls do not error', async () => {
      await takeProfit.init(mockConfig);
      await takeProfit.init(mockConfig);

      expect(takeProfit.getState().initialized).toBe(true);
    });

    it('throws on invalid enabled (non-boolean)', async () => {
      await expect(takeProfit.init({
        strategy: { takeProfit: { enabled: 'yes' } },
      })).rejects.toThrow('enabled must be a boolean');
    });

    it('throws on invalid defaultTakeProfitPct (negative)', async () => {
      await expect(takeProfit.init({
        strategy: { takeProfit: { defaultTakeProfitPct: -0.10 } },
      })).rejects.toThrow('defaultTakeProfitPct must be a number between 0 and 1');
    });

    it('throws on invalid defaultTakeProfitPct (greater than 1)', async () => {
      await expect(takeProfit.init({
        strategy: { takeProfit: { defaultTakeProfitPct: 1.5 } },
      })).rejects.toThrow('defaultTakeProfitPct must be a number between 0 and 1');
    });

    it('throws on invalid defaultTakeProfitPct (non-number)', async () => {
      await expect(takeProfit.init({
        strategy: { takeProfit: { defaultTakeProfitPct: '10%' } },
      })).rejects.toThrow('defaultTakeProfitPct must be a number between 0 and 1');
    });

    it('accepts disabled configuration', async () => {
      await takeProfit.init({
        strategy: { takeProfit: { enabled: false, defaultTakeProfitPct: 0.10 } },
      });

      const state = takeProfit.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(false);
    });
  });

  describe('evaluate()', () => {
    beforeEach(async () => {
      await takeProfit.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await takeProfit.shutdown();

      expect(() => takeProfit.evaluate(mockPosition, 0.56))
        .toThrow('Take-profit module not initialized');
    });

    it('triggers when long position price rises above threshold', () => {
      const result = takeProfit.evaluate(mockPosition, 0.56); // 12% gain

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_ABOVE_THRESHOLD);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('limit'); // NOT 'market' like stop-loss
    });

    it('does NOT trigger when long position price is below threshold', () => {
      const result = takeProfit.evaluate(mockPosition, 0.54); // 8% gain

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe(TriggerReason.NOT_TRIGGERED);
      expect(result.action).toBeNull();
      expect(result.closeMethod).toBeNull();
    });

    it('triggers when short position price drops below threshold', () => {
      const shortPosition = { ...mockPosition, id: 2, side: 'short' };
      const result = takeProfit.evaluate(shortPosition, 0.44); // 12% drop

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_BELOW_THRESHOLD);
    });

    it('returns non-triggered result when take-profit is disabled', async () => {
      await takeProfit.shutdown();
      await takeProfit.init({
        strategy: { takeProfit: { enabled: false, defaultTakeProfitPct: 0.10 } },
      });

      const result = takeProfit.evaluate(mockPosition, 0.56);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('take_profit_disabled');
    });

    it('uses per-position take_profit_pct when available', () => {
      const positionWithOverride = { ...mockPosition, take_profit_pct: 0.20 };
      const result = takeProfit.evaluate(positionWithOverride, 0.56); // 12% gain

      expect(result.triggered).toBe(false); // 12% < 20%
      expect(result.take_profit_pct).toBe(0.20);
    });

    it('includes all required fields in result', () => {
      const result = takeProfit.evaluate(mockPosition, 0.56);

      expect(result).toHaveProperty('triggered');
      expect(result).toHaveProperty('position_id');
      expect(result).toHaveProperty('window_id');
      expect(result).toHaveProperty('side');
      expect(result).toHaveProperty('entry_price');
      expect(result).toHaveProperty('current_price');
      expect(result).toHaveProperty('take_profit_threshold');
      expect(result).toHaveProperty('take_profit_pct');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('closeMethod');
      expect(result).toHaveProperty('profit_amount');
      expect(result).toHaveProperty('profit_pct');
      expect(result).toHaveProperty('evaluated_at');
    });
  });

  describe('evaluateAll()', () => {
    beforeEach(async () => {
      await takeProfit.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await takeProfit.shutdown();

      expect(() => takeProfit.evaluateAll([mockPosition], () => 0.56))
        .toThrow('Take-profit module not initialized');
    });

    it('evaluates multiple positions and returns triggered', () => {
      const positions = [
        { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
        { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50 },
        { id: 3, window_id: 'w3', side: 'short', size: 10, entry_price: 0.50 },
      ];

      const getCurrentPrice = (pos) => {
        if (pos.id === 1) return 0.56;  // Triggered (12% gain)
        if (pos.id === 2) return 0.54;  // Safe (8% gain)
        if (pos.id === 3) return 0.44;  // Triggered (12% drop)
        return null;
      };

      const { triggered, summary } = takeProfit.evaluateAll(positions, getCurrentPrice);

      expect(triggered.length).toBe(2);
      expect(summary.evaluated).toBe(3);
      expect(summary.triggered).toBe(2);
      expect(summary.safe).toBe(1);
    });

    it('returns empty when no positions', () => {
      const { triggered, summary } = takeProfit.evaluateAll([], () => 0.56);

      expect(triggered.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });

    it('returns empty when positions is null', () => {
      const { triggered, summary } = takeProfit.evaluateAll(null, () => 0.56);

      expect(triggered.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });

    it('returns empty when take-profit is disabled', async () => {
      await takeProfit.shutdown();
      await takeProfit.init({
        strategy: { takeProfit: { enabled: false, defaultTakeProfitPct: 0.10 } },
      });

      const positions = [
        { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
      ];

      const { triggered, summary } = takeProfit.evaluateAll(positions, () => 0.56);

      expect(triggered.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state before init', () => {
      const state = takeProfit.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });

    it('returns initialized state with config after init', async () => {
      await takeProfit.init(mockConfig);

      const state = takeProfit.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.config.enabled).toBe(true);
      expect(state.config.default_take_profit_pct).toBe(0.10);
    });

    it('includes evaluation stats', async () => {
      await takeProfit.init(mockConfig);

      const state = takeProfit.getState();

      expect(state.evaluation_count).toBe(0);
      expect(state.triggered_count).toBe(0);
      expect(state.safe_count).toBe(0);
      expect(state.last_evaluation_at).toBeNull();
    });

    it('updates stats after evaluations', async () => {
      await takeProfit.init(mockConfig);

      takeProfit.evaluate(mockPosition, 0.56); // Triggered
      takeProfit.evaluate(mockPosition, 0.54); // Safe

      const state = takeProfit.getState();

      expect(state.evaluation_count).toBe(2);
      expect(state.triggered_count).toBe(1);
      expect(state.safe_count).toBe(1);
      expect(state.last_evaluation_at).not.toBeNull();
    });
  });

  describe('shutdown()', () => {
    it('resets state to uninitialized', async () => {
      await takeProfit.init(mockConfig);
      expect(takeProfit.getState().initialized).toBe(true);

      await takeProfit.shutdown();

      expect(takeProfit.getState().initialized).toBe(false);
      expect(takeProfit.getState().config).toBeNull();
    });

    it('resets evaluation stats', async () => {
      await takeProfit.init(mockConfig);
      takeProfit.evaluate(mockPosition, 0.56);

      await takeProfit.shutdown();

      const state = takeProfit.getState();
      expect(state.evaluation_count).toBe(0);
      expect(state.triggered_count).toBe(0);
    });

    it('is idempotent - can be called multiple times', async () => {
      await takeProfit.init(mockConfig);
      await takeProfit.shutdown();
      await takeProfit.shutdown();

      expect(takeProfit.getState().initialized).toBe(false);
    });

    it('allows reinitialization after shutdown', async () => {
      await takeProfit.init(mockConfig);
      await takeProfit.shutdown();
      await takeProfit.init(mockConfig);

      expect(takeProfit.getState().initialized).toBe(true);
    });
  });

  describe('module exports', () => {
    it('exports standard interface (init, getState, shutdown)', () => {
      expect(typeof takeProfit.init).toBe('function');
      expect(typeof takeProfit.getState).toBe('function');
      expect(typeof takeProfit.shutdown).toBe('function');
    });

    it('exports evaluate and evaluateAll', () => {
      expect(typeof takeProfit.evaluate).toBe('function');
      expect(typeof takeProfit.evaluateAll).toBe('function');
    });

    it('exports error types', () => {
      expect(takeProfit.TakeProfitError).toBeDefined();
      expect(takeProfit.TakeProfitErrorCodes).toBeDefined();
    });

    it('exports TriggerReason', () => {
      expect(takeProfit.TriggerReason).toBeDefined();
      expect(takeProfit.TriggerReason.PRICE_ABOVE_THRESHOLD).toBe('price_above_threshold');
      expect(takeProfit.TriggerReason.PRICE_BELOW_THRESHOLD).toBe('price_below_threshold');
      expect(takeProfit.TriggerReason.NOT_TRIGGERED).toBe('not_triggered');
    });

    it('exports createTakeProfitResult', () => {
      expect(takeProfit.createTakeProfitResult).toBeDefined();
      expect(typeof takeProfit.createTakeProfitResult).toBe('function');
    });
  });
});
