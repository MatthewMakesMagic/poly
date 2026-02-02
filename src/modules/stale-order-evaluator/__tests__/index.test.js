/**
 * Stale Order Evaluator Tests
 *
 * Tests for detecting and cancelling orders where edge has disappeared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as staleOrderEvaluator from '../index.js';
import { StaleReason } from '../types.js';

describe('Stale Order Evaluator', () => {
  beforeEach(async () => {
    await staleOrderEvaluator.init({
      edge: {
        min_edge_threshold: 0.10,
      },
    });
    staleOrderEvaluator.resetStats();
  });

  afterEach(async () => {
    await staleOrderEvaluator.shutdown();
  });

  describe('init()', () => {
    it('should initialize with default config', async () => {
      await staleOrderEvaluator.shutdown();
      await staleOrderEvaluator.init({});

      const state = staleOrderEvaluator.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(true);
      expect(state.config.minEdgeThreshold).toBe(0.10);
    });

    it('should accept custom config', async () => {
      await staleOrderEvaluator.shutdown();
      await staleOrderEvaluator.init({
        staleOrder: {
          enabled: false,
          minEdgeThreshold: 0.15,
        },
      });

      const state = staleOrderEvaluator.getState();
      expect(state.config.enabled).toBe(false);
      expect(state.config.minEdgeThreshold).toBe(0.15);
    });
  });

  describe('recalculateEdge()', () => {
    const mockCalculateProbability = vi.fn();

    beforeEach(() => {
      mockCalculateProbability.mockReset();
    });

    it('should recalculate UP token edge correctly', () => {
      mockCalculateProbability.mockReturnValue({ p_up: 0.75 });

      const order = {
        order_id: 'order-1',
        symbol: 'btc',
        side_token: 'UP',
        original_edge: 0.20,
      };

      const windowData = {
        market_price: 0.55,
        reference_price: 94500,
        time_remaining_ms: 300000,
      };

      const spotPrices = {
        btc: { price: 95000 },
      };

      const result = staleOrderEvaluator.recalculateEdge(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      expect(result.currentEdge).toBeCloseTo(0.20, 2); // 0.75 - 0.55
      expect(result.currentModelProbability).toBe(0.75);
      expect(result.currentMarketPrice).toBe(0.55);
    });

    it('should recalculate DOWN token edge correctly', () => {
      mockCalculateProbability.mockReturnValue({ p_up: 0.25 });

      const order = {
        order_id: 'order-1',
        symbol: 'eth',
        side_token: 'DOWN',
        original_edge: 0.15,
      };

      const windowData = {
        market_price: 0.40, // UP token price
        reference_price: 2500,
        time_remaining_ms: 300000,
      };

      const spotPrices = {
        eth: { price: 2400 },
      };

      const result = staleOrderEvaluator.recalculateEdge(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      // For DOWN: edge = market_price - p_up = 0.40 - 0.25 = 0.15
      expect(result.currentEdge).toBeCloseTo(0.15, 2);
    });

    it('should return error when spot price unavailable', () => {
      const order = { symbol: 'btc', side_token: 'UP' };
      const windowData = { market_price: 0.55, reference_price: 94500, time_remaining_ms: 300000 };
      const spotPrices = {}; // No BTC price

      const result = staleOrderEvaluator.recalculateEdge(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      expect(result.error).toBe('spot_price_unavailable');
      expect(result.currentEdge).toBeNull();
    });

    it('should return error when market price unavailable', () => {
      const order = { symbol: 'btc', side_token: 'UP' };
      const windowData = { reference_price: 94500, time_remaining_ms: 300000 }; // No market_price
      const spotPrices = { btc: { price: 95000 } };

      const result = staleOrderEvaluator.recalculateEdge(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      expect(result.error).toBe('market_price_unavailable');
    });

    it('should return error when window expired', () => {
      const order = { symbol: 'btc', side_token: 'UP' };
      const windowData = { market_price: 0.55, reference_price: 94500, time_remaining_ms: 0 };
      const spotPrices = { btc: { price: 95000 } };

      const result = staleOrderEvaluator.recalculateEdge(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      expect(result.error).toBe('window_expired');
    });
  });

  describe('evaluateOrder()', () => {
    const mockCalculateProbability = vi.fn();

    beforeEach(() => {
      mockCalculateProbability.mockReset();
    });

    it('should detect stale order when edge below threshold', () => {
      mockCalculateProbability.mockReturnValue({ p_up: 0.58 });

      const order = {
        order_id: 'order-1',
        window_id: 'btc-15m-123',
        symbol: 'btc',
        side_token: 'UP',
        original_edge: 0.15,
      };

      const windowData = {
        market_price: 0.55,
        reference_price: 94500,
        time_remaining_ms: 300000,
      };

      const spotPrices = { btc: { price: 94600 } };

      const result = staleOrderEvaluator.evaluateOrder(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      // Edge = 0.58 - 0.55 = 0.03, which is below 0.10 threshold
      expect(result.isStale).toBe(true);
      expect(result.reason).toBe(StaleReason.EDGE_BELOW_THRESHOLD);
      expect(result.details.current_edge).toBeCloseTo(0.03, 2);
    });

    it('should detect stale order when edge reversed', () => {
      mockCalculateProbability.mockReturnValue({ p_up: 0.40 });

      const order = {
        order_id: 'order-1',
        window_id: 'btc-15m-123',
        symbol: 'btc',
        side_token: 'UP',
        original_edge: 0.15, // Was positive
      };

      const windowData = {
        market_price: 0.55,
        reference_price: 94500,
        time_remaining_ms: 300000,
      };

      const spotPrices = { btc: { price: 94000 } };

      const result = staleOrderEvaluator.evaluateOrder(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      // Edge = 0.40 - 0.55 = -0.15 (reversed!)
      expect(result.isStale).toBe(true);
      expect(result.reason).toBe(StaleReason.EDGE_REVERSED);
    });

    it('should mark valid when edge still above threshold', () => {
      mockCalculateProbability.mockReturnValue({ p_up: 0.70 });

      const order = {
        order_id: 'order-1',
        window_id: 'btc-15m-123',
        symbol: 'btc',
        side_token: 'UP',
        original_edge: 0.15,
      };

      const windowData = {
        market_price: 0.55,
        reference_price: 94500,
        time_remaining_ms: 300000,
      };

      const spotPrices = { btc: { price: 95500 } };

      const result = staleOrderEvaluator.evaluateOrder(
        order,
        windowData,
        spotPrices,
        mockCalculateProbability
      );

      // Edge = 0.70 - 0.55 = 0.15, above 0.10 threshold
      expect(result.isStale).toBe(false);
      expect(result.reason).toBeNull();
    });

    it('should detect stale when window not found', () => {
      const order = {
        order_id: 'order-1',
        window_id: 'btc-15m-123',
        original_edge: 0.15,
      };

      const result = staleOrderEvaluator.evaluateOrder(
        order,
        null, // No window data
        {},
        vi.fn()
      );

      expect(result.isStale).toBe(true);
      expect(result.reason).toBe(StaleReason.WINDOW_NOT_FOUND);
    });

    it('should skip orders without original edge', () => {
      const order = {
        order_id: 'order-1',
        window_id: 'btc-15m-123',
        // No original_edge - placed before this feature
      };

      const result = staleOrderEvaluator.evaluateOrder(
        order,
        { market_price: 0.55 },
        {},
        vi.fn()
      );

      // Should be considered stale due to missing data
      expect(result.isStale).toBe(true);
      expect(result.reason).toBe(StaleReason.PRICE_DATA_UNAVAILABLE);
    });
  });

  describe('evaluateAll()', () => {
    const mockCalculateProbability = vi.fn();

    beforeEach(() => {
      mockCalculateProbability.mockReturnValue({ p_up: 0.52 }); // Low edge
    });

    it('should evaluate all orders and separate stale from valid', () => {
      const orders = [
        {
          order_id: 'order-1',
          window_id: 'btc-15m-123',
          symbol: 'btc',
          side_token: 'UP',
          original_edge: 0.15,
        },
        {
          order_id: 'order-2',
          window_id: 'eth-15m-123',
          symbol: 'eth',
          side_token: 'UP',
          original_edge: 0.20,
        },
      ];

      const windows = [
        { window_id: 'btc-15m-123', market_price: 0.50, reference_price: 94500, time_remaining_ms: 300000 },
        // eth window missing - order-2 should be stale
      ];

      const spotPrices = { btc: { price: 94600 } };

      const result = staleOrderEvaluator.evaluateAll(
        orders,
        windows,
        spotPrices,
        mockCalculateProbability
      );

      expect(result.summary.evaluated).toBe(2);
      expect(result.stale.length).toBe(2); // Both stale (one edge below, one window missing)
      expect(result.valid.length).toBe(0);
    });

    it('should skip orders without original_edge', () => {
      const orders = [
        { order_id: 'order-1', window_id: 'btc-15m-123' }, // No original_edge
        { order_id: 'order-2', window_id: 'eth-15m-123', original_edge: 0.15, symbol: 'eth', side_token: 'UP' },
      ];

      const windows = [];
      const spotPrices = {};

      const result = staleOrderEvaluator.evaluateAll(
        orders,
        windows,
        spotPrices,
        mockCalculateProbability
      );

      expect(result.valid.length).toBe(1); // order-1 skipped (no original_edge)
      expect(result.stale.length).toBe(1); // order-2 stale (window not found)
    });

    it('should return empty results when disabled', async () => {
      await staleOrderEvaluator.shutdown();
      await staleOrderEvaluator.init({ staleOrder: { enabled: false } });

      const orders = [{ order_id: 'order-1', original_edge: 0.15 }];

      const result = staleOrderEvaluator.evaluateAll(orders, [], {}, vi.fn());

      expect(result.stale.length).toBe(0);
      expect(result.valid.length).toBe(0);
      expect(result.summary.evaluated).toBe(0);
    });
  });

  describe('cancelStaleOrders()', () => {
    it('should cancel all stale orders via order manager', async () => {
      const mockOrderManager = {
        cancelOrder: vi.fn().mockResolvedValue({ success: true }),
      };

      const staleOrders = [
        { order_id: 'order-1', window_id: 'btc-15m-123', stale_reason: StaleReason.EDGE_BELOW_THRESHOLD },
        { order_id: 'order-2', window_id: 'eth-15m-123', stale_reason: StaleReason.EDGE_REVERSED },
      ];

      const result = await staleOrderEvaluator.cancelStaleOrders(staleOrders, mockOrderManager);

      expect(mockOrderManager.cancelOrder).toHaveBeenCalledTimes(2);
      expect(mockOrderManager.cancelOrder).toHaveBeenCalledWith('order-1');
      expect(mockOrderManager.cancelOrder).toHaveBeenCalledWith('order-2');
      expect(result.cancelled).toEqual(['order-1', 'order-2']);
      expect(result.failed).toEqual([]);
      expect(result.summary.cancelled).toBe(2);
    });

    it('should handle cancel failures gracefully', async () => {
      const mockOrderManager = {
        cancelOrder: vi.fn()
          .mockResolvedValueOnce({ success: true })
          .mockRejectedValueOnce(new Error('API error')),
      };

      const staleOrders = [
        { order_id: 'order-1', stale_reason: StaleReason.EDGE_BELOW_THRESHOLD },
        { order_id: 'order-2', stale_reason: StaleReason.EDGE_REVERSED },
      ];

      const result = await staleOrderEvaluator.cancelStaleOrders(staleOrders, mockOrderManager);

      expect(result.cancelled).toEqual(['order-1']);
      expect(result.failed).toEqual(['order-2']);
      expect(result.summary.cancelled).toBe(1);
      expect(result.summary.failed).toBe(1);
    });

    it('should return empty results for empty input', async () => {
      const mockOrderManager = { cancelOrder: vi.fn() };

      const result = await staleOrderEvaluator.cancelStaleOrders([], mockOrderManager);

      expect(mockOrderManager.cancelOrder).not.toHaveBeenCalled();
      expect(result.cancelled).toEqual([]);
      expect(result.summary.attempted).toBe(0);
    });

    it('should throw if order manager not available', async () => {
      const staleOrders = [{ order_id: 'order-1' }];

      await expect(
        staleOrderEvaluator.cancelStaleOrders(staleOrders, null)
      ).rejects.toThrow('Order manager not available');
    });
  });

  describe('getStats()', () => {
    it('should track evaluation stats', () => {
      const mockCalculateProbability = vi.fn().mockReturnValue({ p_up: 0.52 });

      const orders = [
        { order_id: 'order-1', window_id: 'btc-15m-123', symbol: 'btc', side_token: 'UP', original_edge: 0.15 },
      ];

      const windows = [
        { window_id: 'btc-15m-123', market_price: 0.50, reference_price: 94500, time_remaining_ms: 300000 },
      ];

      staleOrderEvaluator.evaluateAll(orders, windows, { btc: { price: 94600 } }, mockCalculateProbability);

      const stats = staleOrderEvaluator.getStats();
      expect(stats.evaluations).toBe(1);
      expect(stats.staleDetected).toBe(1);
    });
  });
});
