/**
 * Order Manager Module Tests
 *
 * Tests the public interface of the order manager module.
 * Uses vitest with mocked dependencies.
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
  INTENT_TYPES: { PLACE_ORDER: 'place_order', CANCEL_ORDER: 'cancel_order' },
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

vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import * as orderManager from '../index.js';
import * as polymarketClient from '../../../clients/polymarket/index.js';
import * as writeAhead from '../../../persistence/write-ahead.js';
import persistence from '../../../persistence/index.js';

describe('Order Manager Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state before each test
    await orderManager.shutdown();
  });

  afterEach(async () => {
    await orderManager.shutdown();
  });

  describe('init()', () => {
    it('initializes module and updates state', async () => {
      const stateBefore = orderManager.getState();
      expect(stateBefore.initialized).toBe(false);

      await orderManager.init({});

      const stateAfter = orderManager.getState();
      expect(stateAfter.initialized).toBe(true);
    });

    it('is idempotent - can be called multiple times', async () => {
      await orderManager.init({});
      await orderManager.init({});

      expect(orderManager.getState().initialized).toBe(true);
    });
  });

  describe('placeOrder()', () => {
    beforeEach(async () => {
      await orderManager.init({});
    });

    it('throws when called before init', async () => {
      await orderManager.shutdown();

      await expect(
        orderManager.placeOrder({
          tokenId: 'token-1',
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
        })
      ).rejects.toThrow('Order manager not initialized');
    });

    it('logs intent BEFORE API call', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      // Verify logIntent was called before buy
      const logIntentCallOrder = writeAhead.logIntent.mock.invocationCallOrder[0];
      const buyCallOrder = polymarketClient.buy.mock.invocationCallOrder[0];
      expect(logIntentCallOrder).toBeLessThan(buyCallOrder);

      // Verify intent was logged with correct type
      expect(writeAhead.logIntent).toHaveBeenCalledWith(
        'place_order',
        'window-1',
        expect.objectContaining({
          tokenId: 'token-1',
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'GTC',
        })
      );
    });

    it('marks intent as executing before API call', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(writeAhead.markExecuting).toHaveBeenCalledWith(1);

      // markExecuting should be called before buy
      const markExecutingOrder = writeAhead.markExecuting.mock.invocationCallOrder[0];
      const buyOrder = polymarketClient.buy.mock.invocationCallOrder[0];
      expect(markExecutingOrder).toBeLessThan(buyOrder);
    });

    it('records latency correctly', async () => {
      const result = await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('calls buy() for buy orders', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(polymarketClient.buy).toHaveBeenCalledWith('token-1', 100, 0.5, 'GTC');
      expect(polymarketClient.sell).not.toHaveBeenCalled();
    });

    it('calls sell() for sell orders', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'sell',
        size: 50,
        price: 0.75,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(polymarketClient.sell).toHaveBeenCalledWith('token-1', 50, 0.75, 'GTC');
      expect(polymarketClient.buy).not.toHaveBeenCalled();
    });

    it('persists order to database with correct fields', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO orders'),
        expect.arrayContaining([
          'order-123', // order_id
          1, // intent_id
          null, // position_id
          'window-1', // window_id
          'market-1', // market_id
          'token-1', // token_id
          'buy', // side
          'GTC', // order_type
          0.5, // price
          100, // size
        ])
      );
    });

    it('marks intent completed on success', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(writeAhead.markCompleted).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          orderId: 'order-123',
          status: 'open',
        })
      );
    });

    it('returns order result with orderId, status, latencyMs', async () => {
      const result = await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(result).toEqual(
        expect.objectContaining({
          orderId: 'order-123',
          status: 'open',
          latencyMs: expect.any(Number),
          intentId: 1,
        })
      );
    });

    it('maps matched status to filled', async () => {
      // sell returns matched status
      const result = await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'sell',
        size: 50,
        price: 0.75,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(result.status).toBe('filled');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await orderManager.init({});
    });

    it('marks intent as failed on API error', async () => {
      polymarketClient.buy.mockRejectedValueOnce(new Error('API error'));

      await expect(
        orderManager.placeOrder({
          tokenId: 'token-1',
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
        })
      ).rejects.toThrow('Order submission failed');

      expect(writeAhead.markFailed).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          message: 'API error',
        })
      );
    });

    it('throws validation error for missing tokenId', async () => {
      await expect(
        orderManager.placeOrder({
          side: 'buy',
          size: 100,
          price: 0.5,
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
        })
      ).rejects.toThrow('Order validation failed');
    });

    it('throws validation error for invalid side', async () => {
      await expect(
        orderManager.placeOrder({
          tokenId: 'token-1',
          side: 'invalid',
          size: 100,
          price: 0.5,
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
        })
      ).rejects.toThrow('Order validation failed');
    });

    it('throws validation error for invalid price', async () => {
      await expect(
        orderManager.placeOrder({
          tokenId: 'token-1',
          side: 'buy',
          size: 100,
          price: 1.5, // Invalid - must be 0.01-0.99
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
        })
      ).rejects.toThrow('Order validation failed');
    });

    it('throws validation error for negative size', async () => {
      await expect(
        orderManager.placeOrder({
          tokenId: 'token-1',
          side: 'buy',
          size: -100,
          price: 0.5,
          orderType: 'GTC',
          windowId: 'window-1',
          marketId: 'market-1',
        })
      ).rejects.toThrow('Order validation failed');
    });
  });

  describe('getOrder()', () => {
    beforeEach(async () => {
      await orderManager.init({});
    });

    it('throws when called before init', async () => {
      await orderManager.shutdown();

      expect(() => orderManager.getOrder('order-123')).toThrow(
        'Order manager not initialized'
      );
    });

    it('returns order from cache after placing', async () => {
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      const order = orderManager.getOrder('order-123');
      expect(order).toBeDefined();
      expect(order.order_id).toBe('order-123');
      expect(order.token_id).toBe('token-1');
    });

    it('falls back to database if not in cache', async () => {
      persistence.get.mockReturnValueOnce({
        order_id: 'order-db-1',
        token_id: 'token-1',
        status: 'filled',
      });

      const order = orderManager.getOrder('order-db-1');
      expect(order).toBeDefined();
      expect(order.order_id).toBe('order-db-1');
      expect(persistence.get).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM orders'),
        ['order-db-1']
      );
    });

    it('returns undefined for non-existent order', async () => {
      persistence.get.mockReturnValueOnce(undefined);

      const order = orderManager.getOrder('non-existent');
      expect(order).toBeUndefined();
    });
  });

  describe('getOpenOrders()', () => {
    beforeEach(async () => {
      await orderManager.init({});
    });

    it('throws when called before init', async () => {
      await orderManager.shutdown();

      expect(() => orderManager.getOpenOrders()).toThrow(
        'Order manager not initialized'
      );
    });

    it('returns open orders from database', async () => {
      persistence.all.mockReturnValueOnce([
        { order_id: 'order-1', status: 'open' },
        { order_id: 'order-2', status: 'partially_filled' },
      ]);

      const orders = orderManager.getOpenOrders();
      expect(orders).toHaveLength(2);
      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM orders'),
        ['open', 'partially_filled']
      );
    });

    it('filters by status correctly', async () => {
      // Place an order that will be open
      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      // Mock database to return the placed order
      persistence.all.mockReturnValueOnce([
        { order_id: 'order-123', status: 'open' },
      ]);

      const openOrders = orderManager.getOpenOrders();
      expect(openOrders.length).toBeGreaterThanOrEqual(1);
      expect(openOrders.every((o) => ['open', 'partially_filled'].includes(o.status))).toBe(true);
    });
  });

  describe('getOrdersByWindow()', () => {
    beforeEach(async () => {
      await orderManager.init({});
    });

    it('returns orders for a specific window', async () => {
      persistence.all.mockReturnValueOnce([
        { order_id: 'order-1', window_id: 'window-1' },
        { order_id: 'order-2', window_id: 'window-1' },
      ]);

      const orders = orderManager.getOrdersByWindow('window-1');
      expect(orders).toHaveLength(2);
      expect(orders.every((o) => o.window_id === 'window-1')).toBe(true);
    });
  });

  describe('getState()', () => {
    it('returns initialized false before init', () => {
      const state = orderManager.getState();
      expect(state.initialized).toBe(false);
    });

    it('returns initialized true after init', async () => {
      await orderManager.init({});
      const state = orderManager.getState();
      expect(state.initialized).toBe(true);
    });

    it('includes stats after placing orders', async () => {
      await orderManager.init({});

      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      const state = orderManager.getState();
      expect(state.ordersPlaced).toBe(1);
      expect(state.lastOrderTime).toBeDefined();
    });
  });

  describe('shutdown()', () => {
    it('cleans up resources and resets state', async () => {
      await orderManager.init({});
      expect(orderManager.getState().initialized).toBe(true);

      await orderManager.shutdown();
      expect(orderManager.getState().initialized).toBe(false);
    });

    it('is idempotent - can be called multiple times', async () => {
      await orderManager.init({});
      await orderManager.shutdown();
      await orderManager.shutdown();

      expect(orderManager.getState().initialized).toBe(false);
    });

    it('clears order cache', async () => {
      await orderManager.init({});

      await orderManager.placeOrder({
        tokenId: 'token-1',
        side: 'buy',
        size: 100,
        price: 0.5,
        orderType: 'GTC',
        windowId: 'window-1',
        marketId: 'market-1',
      });

      expect(orderManager.getState().cachedOrderCount).toBe(1);

      await orderManager.shutdown();

      expect(orderManager.getState().cachedOrderCount).toBe(0);
    });
  });
});
