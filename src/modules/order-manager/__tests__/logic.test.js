/**
 * Order Manager Logic Tests
 *
 * Unit tests for order business logic functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  },
  run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../persistence/write-ahead.js', () => ({
  logIntent: vi.fn().mockReturnValue(1),
  markExecuting: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  INTENT_TYPES: { PLACE_ORDER: 'place_order' },
}));

vi.mock('../../../clients/polymarket/index.js', () => ({
  buy: vi.fn().mockResolvedValue({
    orderID: 'order-123',
    status: 'live',
    success: true,
  }),
  sell: vi.fn().mockResolvedValue({
    orderID: 'order-456',
    status: 'matched',
    success: true,
  }),
}));

// Import after mocks
import * as logic from '../logic.js';
import * as state from '../state.js';
import * as writeAhead from '../../../persistence/write-ahead.js';
import * as polymarketClient from '../../../clients/polymarket/index.js';
import persistence from '../../../persistence/index.js';
import { OrderStatus } from '../types.js';

describe('Order Manager Logic', () => {
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state.clearCache();
  });

  describe('placeOrder()', () => {
    const validParams = {
      tokenId: 'token-1',
      side: 'buy',
      size: 100,
      price: 0.5,
      orderType: 'GTC',
      windowId: 'window-1',
      marketId: 'market-1',
    };

    it('validates tokenId is required', async () => {
      await expect(
        logic.placeOrder({ ...validParams, tokenId: null }, mockLog)
      ).rejects.toThrow('tokenId is required');
    });

    it('validates side must be buy or sell', async () => {
      await expect(
        logic.placeOrder({ ...validParams, side: 'hold' }, mockLog)
      ).rejects.toThrow("side must be 'buy' or 'sell'");
    });

    it('validates size must be positive', async () => {
      await expect(
        logic.placeOrder({ ...validParams, size: 0 }, mockLog)
      ).rejects.toThrow('size must be a positive number');
    });

    it('validates price range 0.01-0.99', async () => {
      await expect(
        logic.placeOrder({ ...validParams, price: 0 }, mockLog)
      ).rejects.toThrow('price must be a number between 0.01 and 0.99');

      await expect(
        logic.placeOrder({ ...validParams, price: 1 }, mockLog)
      ).rejects.toThrow('price must be a number between 0.01 and 0.99');
    });

    it('allows null price for market orders', async () => {
      await logic.placeOrder({ ...validParams, price: null }, mockLog);
      expect(polymarketClient.buy).toHaveBeenCalledWith('token-1', 100, null, 'GTC');
    });

    it('logs intent with correct payload', async () => {
      await logic.placeOrder(validParams, mockLog);

      expect(writeAhead.logIntent).toHaveBeenCalledWith(
        'place_order',
        'window-1',
        expect.objectContaining({
          tokenId: 'token-1',
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
          requestedAt: expect.any(String),
        })
      );
    });

    it('marks intent executing before API call', async () => {
      await logic.placeOrder(validParams, mockLog);

      // Check call order
      const intentOrder = writeAhead.logIntent.mock.invocationCallOrder[0];
      const executingOrder = writeAhead.markExecuting.mock.invocationCallOrder[0];
      const buyOrder = polymarketClient.buy.mock.invocationCallOrder[0];

      expect(intentOrder).toBeLessThan(executingOrder);
      expect(executingOrder).toBeLessThan(buyOrder);
    });

    it('persists order with all required fields', async () => {
      await logic.placeOrder(validParams, mockLog);

      const insertCall = persistence.run.mock.calls.find((call) =>
        call[0].includes('INSERT INTO orders')
      );

      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall;

      // Check all fields are present
      expect(params).toContain('order-123'); // order_id
      expect(params).toContain(1); // intent_id
      expect(params).toContain('window-1'); // window_id
      expect(params).toContain('market-1'); // market_id
      expect(params).toContain('token-1'); // token_id
      expect(params).toContain('buy'); // side
      expect(params).toContain('GTC'); // order_type
      expect(params).toContain(0.5); // price
      expect(params).toContain(100); // size
    });

    it('caches order after successful placement', async () => {
      await logic.placeOrder(validParams, mockLog);

      const cached = state.getCachedOrder('order-123');
      expect(cached).toBeDefined();
      expect(cached.order_id).toBe('order-123');
    });

    it('marks intent completed with result', async () => {
      await logic.placeOrder(validParams, mockLog);

      expect(writeAhead.markCompleted).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          orderId: 'order-123',
          status: 'open',
          latencyMs: expect.any(Number),
        })
      );
    });

    it('records latency in stats', async () => {
      const statsBefore = state.getStats();
      expect(statsBefore.ordersPlaced).toBe(0);

      await logic.placeOrder(validParams, mockLog);

      const statsAfter = state.getStats();
      expect(statsAfter.ordersPlaced).toBe(1);
      expect(statsAfter.avgLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('placeOrder() error handling', () => {
    const validParams = {
      tokenId: 'token-1',
      side: 'buy',
      size: 100,
      price: 0.5,
      orderType: 'GTC',
      windowId: 'window-1',
      marketId: 'market-1',
    };

    it('marks intent failed on API error', async () => {
      polymarketClient.buy.mockRejectedValueOnce(new Error('Network error'));

      await expect(logic.placeOrder(validParams, mockLog)).rejects.toThrow();

      expect(writeAhead.markFailed).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          message: 'Network error',
        })
      );
    });

    it('includes latency in failure record', async () => {
      polymarketClient.buy.mockRejectedValueOnce(new Error('Timeout'));

      await expect(logic.placeOrder(validParams, mockLog)).rejects.toThrow();

      expect(writeAhead.markFailed).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          latencyMs: expect.any(Number),
        })
      );
    });

    it('does not persist order on failure', async () => {
      polymarketClient.buy.mockRejectedValueOnce(new Error('Failed'));
      persistence.run.mockClear();

      await expect(logic.placeOrder(validParams, mockLog)).rejects.toThrow();

      // Should not have inserted order
      const insertCalls = persistence.run.mock.calls.filter((call) =>
        call[0].includes('INSERT INTO orders')
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('does not cache order on failure', async () => {
      polymarketClient.buy.mockRejectedValueOnce(new Error('Failed'));

      await expect(logic.placeOrder(validParams, mockLog)).rejects.toThrow();

      const cached = state.getCachedOrder('order-123');
      expect(cached).toBeUndefined();
    });
  });

  describe('updateOrderStatus()', () => {
    beforeEach(async () => {
      // Set up a cached order
      state.cacheOrder({
        order_id: 'order-1',
        intent_id: 1,
        status: 'open',
        window_id: 'window-1',
      });
    });

    it('updates status in cache and database', () => {
      const updated = logic.updateOrderStatus('order-1', OrderStatus.FILLED, {}, mockLog);

      expect(updated.status).toBe('filled');

      const cached = state.getCachedOrder('order-1');
      expect(cached.status).toBe('filled');

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders SET'),
        expect.arrayContaining(['filled', 'order-1'])
      );
    });

    it('throws for non-existent order', () => {
      expect(() =>
        logic.updateOrderStatus('non-existent', OrderStatus.FILLED, {}, mockLog)
      ).toThrow('Order not found');
    });

    it('throws for invalid status transition', () => {
      // open -> pending is not allowed
      expect(() =>
        logic.updateOrderStatus('order-1', OrderStatus.PENDING, {}, mockLog)
      ).toThrow('Invalid status transition');
    });

    it('sets filled_at timestamp when transitioning to filled', () => {
      logic.updateOrderStatus('order-1', OrderStatus.FILLED, {}, mockLog);

      const cached = state.getCachedOrder('order-1');
      expect(cached.filled_at).toBeDefined();
    });

    it('sets cancelled_at timestamp when transitioning to cancelled', () => {
      logic.updateOrderStatus('order-1', OrderStatus.CANCELLED, {}, mockLog);

      const cached = state.getCachedOrder('order-1');
      expect(cached.cancelled_at).toBeDefined();
    });

    it('allows setting avg_fill_price on fill', () => {
      logic.updateOrderStatus(
        'order-1',
        OrderStatus.FILLED,
        { avg_fill_price: 0.55 },
        mockLog
      );

      const cached = state.getCachedOrder('order-1');
      expect(cached.avg_fill_price).toBe(0.55);
    });
  });

  describe('getOrder()', () => {
    it('returns cached order', () => {
      state.cacheOrder({ order_id: 'cached-1', status: 'open' });

      const order = logic.getOrder('cached-1');
      expect(order).toBeDefined();
      expect(order.order_id).toBe('cached-1');
    });

    it('falls back to database', () => {
      persistence.get.mockReturnValueOnce({
        order_id: 'db-1',
        status: 'filled',
      });

      const order = logic.getOrder('db-1');
      expect(order).toBeDefined();
      expect(order.order_id).toBe('db-1');
      expect(persistence.get).toHaveBeenCalled();
    });

    it('caches order after database fetch', () => {
      persistence.get.mockReturnValueOnce({
        order_id: 'db-2',
        status: 'open',
      });

      logic.getOrder('db-2');

      // Should now be in cache
      const cached = state.getCachedOrder('db-2');
      expect(cached).toBeDefined();
    });
  });

  describe('getOpenOrders()', () => {
    it('returns open and partially_filled orders', () => {
      persistence.all.mockReturnValueOnce([
        { order_id: '1', status: 'open' },
        { order_id: '2', status: 'partially_filled' },
      ]);

      const orders = logic.getOpenOrders();
      expect(orders).toHaveLength(2);
    });

    it('queries with correct status filter', () => {
      persistence.all.mockReturnValueOnce([]);

      logic.getOpenOrders();

      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('status IN'),
        ['open', 'partially_filled']
      );
    });
  });

  describe('getOrdersByWindow()', () => {
    it('queries by window_id', () => {
      persistence.all.mockReturnValueOnce([
        { order_id: '1', window_id: 'w1' },
      ]);

      const orders = logic.getOrdersByWindow('w1');

      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        ['w1']
      );
    });
  });

  describe('loadRecentOrders()', () => {
    it('loads open orders into cache', () => {
      persistence.all.mockReturnValueOnce([
        { order_id: 'recent-1', status: 'open' },
        { order_id: 'recent-2', status: 'partially_filled' },
      ]);

      logic.loadRecentOrders(mockLog);

      expect(state.getCachedOrder('recent-1')).toBeDefined();
      expect(state.getCachedOrder('recent-2')).toBeDefined();
    });

    it('logs count of loaded orders', () => {
      persistence.all.mockReturnValueOnce([
        { order_id: 'r1', status: 'open' },
      ]);

      logic.loadRecentOrders(mockLog);

      expect(mockLog.info).toHaveBeenCalledWith('orders_loaded_to_cache', { count: 1 });
    });
  });
});
