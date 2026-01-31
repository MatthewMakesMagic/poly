/**
 * Position Sizer Module Integration Tests
 *
 * Tests the public interface of the position sizer module.
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
import * as positionSizer from '../index.js';
import { PositionSizerErrorCodes, AdjustmentReason } from '../types.js';

// Test configuration
const mockConfig = {
  strategy: {
    sizing: {
      baseSizeDollars: 10,
      minSizeDollars: 1,
      maxSlippagePct: 0.01,
      confidenceMultiplier: 0.5,
    },
  },
  risk: {
    maxPositionSize: 100,
    maxExposure: 500,
  },
};

// Mock signal for tests
const mockSignal = {
  window_id: 'btc-15m-2026-01-31-10:15',
  market_id: 'btc-market',
  token_id: 'btc-token-123',
  direction: 'long',
  confidence: 0.8,
};

// Mock orderbook with good liquidity
const mockOrderbook = {
  bids: [
    { price: '0.49', size: '100' },
    { price: '0.48', size: '200' },
  ],
  asks: [
    { price: '0.51', size: '100' },
    { price: '0.52', size: '200' },
  ],
};

describe('PositionSizer Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await positionSizer.shutdown();
  });

  afterEach(async () => {
    await positionSizer.shutdown();
  });

  describe('init()', () => {
    it('initializes successfully with valid config', async () => {
      await positionSizer.init(mockConfig);

      const state = positionSizer.getState();
      expect(state.initialized).toBe(true);
    });

    it('uses default values when config not provided', async () => {
      await positionSizer.init({});

      const state = positionSizer.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.base_size_dollars).toBe(10);
      expect(state.config.min_size_dollars).toBe(1);
      expect(state.config.max_slippage_pct).toBe(0.01);
      expect(state.config.confidence_multiplier).toBe(0);
    });

    it('is idempotent - multiple calls do not error', async () => {
      await positionSizer.init(mockConfig);
      await positionSizer.init(mockConfig);

      expect(positionSizer.getState().initialized).toBe(true);
    });

    it('throws on invalid baseSizeDollars (zero)', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { baseSizeDollars: 0 } },
      })).rejects.toThrow('baseSizeDollars must be a positive number');
    });

    it('throws on invalid baseSizeDollars (negative)', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { baseSizeDollars: -10 } },
      })).rejects.toThrow('baseSizeDollars must be a positive number');
    });

    it('throws on invalid minSizeDollars (zero)', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { minSizeDollars: 0 } },
      })).rejects.toThrow('minSizeDollars must be a positive number');
    });

    it('throws on invalid minSizeDollars (negative)', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { minSizeDollars: -1 } },
      })).rejects.toThrow('minSizeDollars must be a positive number');
    });

    it('throws when minSizeDollars exceeds baseSizeDollars', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { baseSizeDollars: 5, minSizeDollars: 10 } },
      })).rejects.toThrow('minSizeDollars cannot exceed baseSizeDollars');
    });

    it('throws on invalid maxSlippagePct (zero)', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { maxSlippagePct: 0 } },
      })).rejects.toThrow('maxSlippagePct must be a number between 0 and 1');
    });

    it('throws on invalid maxSlippagePct (>= 1)', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { maxSlippagePct: 1.0 } },
      })).rejects.toThrow('maxSlippagePct must be a number between 0 and 1');
    });

    it('throws on negative confidenceMultiplier', async () => {
      await expect(positionSizer.init({
        strategy: { sizing: { confidenceMultiplier: -0.5 } },
      })).rejects.toThrow('confidenceMultiplier must be a non-negative number');
    });

    it('throws on invalid maxPositionSize', async () => {
      await expect(positionSizer.init({
        risk: { maxPositionSize: 0 },
      })).rejects.toThrow('maxPositionSize must be a positive number');
    });

    it('throws on invalid maxExposure', async () => {
      await expect(positionSizer.init({
        risk: { maxExposure: -100 },
      })).rejects.toThrow('maxExposure must be a positive number');
    });
  });

  describe('calculateSize()', () => {
    beforeEach(async () => {
      await positionSizer.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await positionSizer.shutdown();

      await expect(positionSizer.calculateSize(mockSignal, {}))
        .rejects.toThrow('Position sizer not initialized');
    });

    it('throws on null signal', async () => {
      await expect(positionSizer.calculateSize(null, {}))
        .rejects.toThrow('Invalid signal: must be an object');
    });

    it('throws on missing window_id', async () => {
      await expect(positionSizer.calculateSize({ direction: 'long' }, {}))
        .rejects.toThrow('Invalid signal: missing window_id');
    });

    it('throws on invalid direction', async () => {
      await expect(positionSizer.calculateSize({
        window_id: 'test',
        direction: 'invalid',
      }, {})).rejects.toThrow('Invalid signal: direction must be "long" or "short"');
    });

    it('returns base size when no limits hit', async () => {
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(true);
      // With confidence 0.8 and multiplier 0.5: base * (1 + (0.8 - 0.5) * 0.5) = 10 * 1.15 = 11.5
      expect(result.actual_size).toBeGreaterThan(mockConfig.strategy.sizing.baseSizeDollars);
      expect(result.adjustment_reason).toBe(AdjustmentReason.NO_ADJUSTMENT);
    });

    it('returns base size without confidence adjustment when multiplier is 0', async () => {
      await positionSizer.shutdown();
      await positionSizer.init({
        ...mockConfig,
        strategy: {
          sizing: {
            ...mockConfig.strategy.sizing,
            confidenceMultiplier: 0,
          },
        },
      });

      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(true);
      expect(result.actual_size).toBe(10);
    });

    it('reduces size for liquidity constraint', async () => {
      // Limited liquidity - only $2.55 available at best ask price level
      const limitedOrderbook = {
        asks: [{ price: '0.51', size: '5' }], // 0.51 * 5 = 2.55
        bids: [],
      };

      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(limitedOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(true);
      expect(result.actual_size).toBeLessThanOrEqual(2.55);
      expect(result.adjustment_reason).toBe(AdjustmentReason.LIQUIDITY_LIMITED);
    });

    it('reduces size for exposure cap', async () => {
      // Re-init with higher base size to trigger exposure cap
      await positionSizer.shutdown();
      await positionSizer.init({
        strategy: {
          sizing: {
            baseSizeDollars: 100,
            minSizeDollars: 1,
            maxSlippagePct: 0.01,
            confidenceMultiplier: 0,
          },
        },
        risk: {
          maxPositionSize: 200,
          maxExposure: 150,
        },
      });

      // Large orderbook for liquidity
      const largeOrderbook = {
        asks: [{ price: '0.50', size: '400' }], // $200 available
        bids: [],
      };

      // Exposure at 100, max 150, so only $50 headroom
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(largeOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(100),
      });

      expect(result.success).toBe(true);
      expect(result.actual_size).toBe(50);
      expect(result.adjustment_reason).toBe(AdjustmentReason.EXPOSURE_CAPPED);
    });

    it('rejects when exposure cap exceeded and headroom below minimum', async () => {
      // At max exposure - no headroom
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(500),
      });

      expect(result.success).toBe(false);
      expect(result.actual_size).toBe(0);
      expect(result.adjustment_reason).toBe(AdjustmentReason.REJECTED);
      expect(result.rejection_code).toBe('EXPOSURE_CAP_EXCEEDED');
    });

    it('caps at maxPositionSize', async () => {
      await positionSizer.shutdown();
      await positionSizer.init({
        strategy: {
          sizing: {
            baseSizeDollars: 200, // Above maxPositionSize
            minSizeDollars: 1,
            maxSlippagePct: 0.01,
            confidenceMultiplier: 0,
          },
        },
        risk: {
          maxPositionSize: 100,
          maxExposure: 500,
        },
      });

      // Large orderbook with plenty of liquidity
      const largeOrderbook = {
        asks: [{ price: '0.50', size: '400' }], // $200 available
        bids: [],
      };

      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(largeOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(true);
      expect(result.actual_size).toBe(100);
      expect(result.adjustment_reason).toBe(AdjustmentReason.POSITION_LIMIT_CAPPED);
    });

    it('rejects when below minimum size', async () => {
      // Tiny liquidity below minimum
      const tinyOrderbook = {
        asks: [{ price: '0.51', size: '0.5' }], // 0.255 available
        bids: [],
      };

      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(tinyOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(false);
      expect(result.actual_size).toBe(0);
      expect(result.adjustment_reason).toBe(AdjustmentReason.REJECTED);
      expect(result.rejection_code).toBe('INSUFFICIENT_LIQUIDITY');
    });

    it('SizingResult includes all required fields', async () => {
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(100),
      });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('requested_size');
      expect(result).toHaveProperty('actual_size');
      expect(result).toHaveProperty('adjustment_reason');
      expect(result).toHaveProperty('window_id');
      expect(result).toHaveProperty('market_id');
      expect(result).toHaveProperty('token_id');
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('available_liquidity');
      expect(result).toHaveProperty('estimated_slippage');
      expect(result).toHaveProperty('current_exposure');
      expect(result).toHaveProperty('exposure_headroom');
      expect(result).toHaveProperty('sized_at');
    });

    it('handles short direction correctly', async () => {
      const shortSignal = { ...mockSignal, direction: 'short' };

      const result = await positionSizer.calculateSize(shortSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(true);
      expect(result.direction).toBe('short');
    });

    it('handles orderbook fetch failure gracefully', async () => {
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockRejectedValue(new Error('API error')),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(false);
      expect(result.adjustment_reason).toBe(AdjustmentReason.REJECTED);
    });

    it('handles missing getOrderBook function', async () => {
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: null,
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      expect(result.success).toBe(false);
    });

    it('handles missing getCurrentExposure function', async () => {
      const result = await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: null,
      });

      // Should use 0 as default exposure
      expect(result.success).toBe(true);
    });

    it('records sizing statistics', async () => {
      await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      const state = positionSizer.getState();
      expect(state.sizing_count).toBe(1);
      expect(state.success_count).toBe(1);
    });

    it('records rejection statistics', async () => {
      await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(500), // At max exposure
      });

      const state = positionSizer.getState();
      expect(state.sizing_count).toBe(1);
      expect(state.rejection_count).toBe(1);
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state before init', () => {
      const state = positionSizer.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
      expect(state.risk).toBeNull();
    });

    it('returns initialized state with config after init', async () => {
      await positionSizer.init(mockConfig);

      const state = positionSizer.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.config.base_size_dollars).toBe(10);
      expect(state.config.min_size_dollars).toBe(1);
      expect(state.config.max_slippage_pct).toBe(0.01);
      expect(state.config.confidence_multiplier).toBe(0.5);
    });

    it('includes risk config', async () => {
      await positionSizer.init(mockConfig);

      const state = positionSizer.getState();

      expect(state.risk).toBeDefined();
      expect(state.risk.max_position_size).toBe(100);
      expect(state.risk.max_exposure).toBe(500);
    });

    it('includes sizing stats', async () => {
      await positionSizer.init(mockConfig);

      const state = positionSizer.getState();

      expect(state.sizing_count).toBe(0);
      expect(state.success_count).toBe(0);
      expect(state.rejection_count).toBe(0);
      expect(state.last_sizing_at).toBeNull();
    });

    it('includes adjustment counts', async () => {
      await positionSizer.init(mockConfig);

      const state = positionSizer.getState();

      expect(state.adjustment_counts).toBeDefined();
      expect(state.adjustment_counts.no_adjustment).toBe(0);
      expect(state.adjustment_counts.liquidity_limited).toBe(0);
      expect(state.adjustment_counts.exposure_capped).toBe(0);
      expect(state.adjustment_counts.position_limit_capped).toBe(0);
    });

    it('updates stats after calculations', async () => {
      await positionSizer.init(mockConfig);

      await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      const state = positionSizer.getState();

      expect(state.sizing_count).toBe(1);
      expect(state.success_count).toBe(1);
      expect(state.last_sizing_at).not.toBeNull();
      expect(state.adjustment_counts.no_adjustment).toBe(1);
    });
  });

  describe('shutdown()', () => {
    it('resets state to uninitialized', async () => {
      await positionSizer.init(mockConfig);
      expect(positionSizer.getState().initialized).toBe(true);

      await positionSizer.shutdown();

      expect(positionSizer.getState().initialized).toBe(false);
      expect(positionSizer.getState().config).toBeNull();
    });

    it('resets sizing stats', async () => {
      await positionSizer.init(mockConfig);

      await positionSizer.calculateSize(mockSignal, {
        getOrderBook: vi.fn().mockResolvedValue(mockOrderbook),
        getCurrentExposure: vi.fn().mockReturnValue(0),
      });

      await positionSizer.shutdown();

      const state = positionSizer.getState();
      expect(state.sizing_count).toBe(0);
      expect(state.success_count).toBe(0);
    });

    it('is idempotent - can be called multiple times', async () => {
      await positionSizer.init(mockConfig);
      await positionSizer.shutdown();
      await positionSizer.shutdown();

      expect(positionSizer.getState().initialized).toBe(false);
    });

    it('allows reinitialization after shutdown', async () => {
      await positionSizer.init(mockConfig);
      await positionSizer.shutdown();
      await positionSizer.init(mockConfig);

      expect(positionSizer.getState().initialized).toBe(true);
    });
  });

  describe('module exports', () => {
    it('exports standard interface (init, getState, shutdown)', () => {
      expect(typeof positionSizer.init).toBe('function');
      expect(typeof positionSizer.getState).toBe('function');
      expect(typeof positionSizer.shutdown).toBe('function');
    });

    it('exports calculateSize', () => {
      expect(typeof positionSizer.calculateSize).toBe('function');
    });

    it('exports error types', () => {
      expect(positionSizer.PositionSizerError).toBeDefined();
      expect(positionSizer.PositionSizerErrorCodes).toBeDefined();
    });

    it('exports AdjustmentReason', () => {
      expect(positionSizer.AdjustmentReason).toBeDefined();
      expect(positionSizer.AdjustmentReason.NO_ADJUSTMENT).toBe('no_adjustment');
      expect(positionSizer.AdjustmentReason.LIQUIDITY_LIMITED).toBe('liquidity_limited');
      expect(positionSizer.AdjustmentReason.EXPOSURE_CAPPED).toBe('exposure_capped');
      expect(positionSizer.AdjustmentReason.POSITION_LIMIT_CAPPED).toBe('position_limit_capped');
    });
  });
});
