/**
 * Order Manager Logic Tests (V3 Stage 4: DB as single source of truth)
 *
 * Unit tests for order business logic functions.
 * All order state is now backed by DB mocks, no in-memory cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
  run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
  get: vi.fn().mockResolvedValue(undefined),
  all: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../persistence/write-ahead.js', () => ({
  logIntent: vi.fn().mockReturnValue(1),
  markExecuting: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  INTENT_TYPES: {
    PLACE_ORDER: 'place_order',
    CANCEL_ORDER: 'cancel_order',
  },
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
  cancelOrder: vi.fn().mockResolvedValue({
    success: true,
  }),
}));

// Import after mocks
import * as logic from '../logic.js';
import { clearStats, getStats } from '../state.js';
import * as writeAhead from '../../../persistence/write-ahead.js';
import * as polymarketClient from '../../../clients/polymarket/index.js';
import persistence from '../../../persistence/index.js';
import { OrderStatus } from '../types.js';

/**
 * Helper: configure persistence.get mock to return a specific order when queried by order_id.
 * This simulates the order existing in the DB.
 */
function mockDbOrder(order) {
  persistence.get.mockImplementation((sql, params) => {
    if (sql.includes('SELECT * FROM orders') && params[0] === order.order_id) {
      return Promise.resolve({ ...order });
    }
    return Promise.resolve(undefined);
  });
}

describe('Order Manager Logic', () => {
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearStats();
    // Reset persistence mocks to defaults
    persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });
    persistence.get.mockResolvedValue(undefined);
    persistence.all.mockResolvedValue([]);
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

    it('records order placement in stats (not cache)', async () => {
      await logic.placeOrder(validParams, mockLog);

      const stats = getStats();
      expect(stats.ordersPlaced).toBe(1);
      expect(stats.lastOrderTime).toBeDefined();
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
      const statsBefore = getStats();
      expect(statsBefore.ordersPlaced).toBe(0);

      await logic.placeOrder(validParams, mockLog);

      const statsAfter = getStats();
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

    it('does not record stats on failure', async () => {
      polymarketClient.buy.mockRejectedValueOnce(new Error('Failed'));

      await expect(logic.placeOrder(validParams, mockLog)).rejects.toThrow();

      const stats = getStats();
      expect(stats.ordersPlaced).toBe(0);
    });
  });

  describe('updateOrderStatus()', () => {
    beforeEach(async () => {
      // Set up a DB-backed order
      mockDbOrder({
        order_id: 'order-1',
        intent_id: 1,
        status: 'open',
        window_id: 'window-1',
      });
    });

    it('updates status in database', async () => {
      const updated = await logic.updateOrderStatus('order-1', OrderStatus.FILLED, {}, mockLog);

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders SET'),
        expect.arrayContaining(['filled', 'order-1'])
      );
    });

    it('returns updated order from DB after update', async () => {
      // After the update, the DB should return the updated order
      let callCount = 0;
      persistence.get.mockImplementation((sql, params) => {
        if (sql.includes('SELECT * FROM orders') && params[0] === 'order-1') {
          callCount++;
          // First call returns original, subsequent calls return updated
          if (callCount <= 1) {
            return Promise.resolve({
              order_id: 'order-1',
              intent_id: 1,
              status: 'open',
              window_id: 'window-1',
            });
          }
          return Promise.resolve({
            order_id: 'order-1',
            intent_id: 1,
            status: 'filled',
            window_id: 'window-1',
            filled_at: expect.any(String),
          });
        }
        return Promise.resolve(undefined);
      });

      const updated = await logic.updateOrderStatus('order-1', OrderStatus.FILLED, {}, mockLog);
      expect(updated).toBeDefined();
      expect(updated.order_id).toBe('order-1');
    });

    it('throws for non-existent order', async () => {
      persistence.get.mockResolvedValue(undefined);

      await expect(
        logic.updateOrderStatus('non-existent', OrderStatus.FILLED, {}, mockLog)
      ).rejects.toThrow('Order not found');
    });

    it('throws for invalid status transition', async () => {
      // open -> pending is not allowed
      await expect(
        logic.updateOrderStatus('order-1', OrderStatus.PENDING, {}, mockLog)
      ).rejects.toThrow('Invalid status transition');
    });

    it('sets filled_at timestamp when transitioning to filled', async () => {
      await logic.updateOrderStatus('order-1', OrderStatus.FILLED, {}, mockLog);

      // Check that the UPDATE call includes filled_at
      const updateCall = persistence.run.mock.calls.find((call) =>
        call[0].includes('UPDATE orders SET')
      );
      expect(updateCall).toBeDefined();
      // The SQL should contain filled_at
      expect(updateCall[0]).toContain('filled_at');
    });

    it('sets cancelled_at timestamp when transitioning to cancelled', async () => {
      await logic.updateOrderStatus('order-1', OrderStatus.CANCELLED, {}, mockLog);

      const updateCall = persistence.run.mock.calls.find((call) =>
        call[0].includes('UPDATE orders SET')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain('cancelled_at');
    });

    it('allows setting avg_fill_price on fill', async () => {
      await logic.updateOrderStatus(
        'order-1',
        OrderStatus.FILLED,
        { avg_fill_price: 0.55 },
        mockLog
      );

      const updateCall = persistence.run.mock.calls.find((call) =>
        call[0].includes('UPDATE orders SET')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toContain(0.55);
    });

    it('rejects invalid column names to prevent SQL injection', async () => {
      await expect(
        logic.updateOrderStatus(
          'order-1',
          OrderStatus.FILLED,
          { 'malicious_column; DROP TABLE orders;--': 'value' },
          mockLog
        )
      ).rejects.toThrow('Invalid update columns');
    });

    it('allows valid column names in updates', async () => {
      // Should not throw for valid columns
      await expect(
        logic.updateOrderStatus(
          'order-1',
          OrderStatus.FILLED,
          { filled_size: 100, avg_fill_price: 0.55 },
          mockLog
        )
      ).resolves.not.toThrow();
    });

    it('records status change in stats', async () => {
      await logic.updateOrderStatus('order-1', OrderStatus.FILLED, {}, mockLog);

      const stats = getStats();
      expect(stats.ordersFilled).toBe(1);
    });
  });

  describe('getOrder()', () => {
    it('queries database directly', async () => {
      persistence.get.mockResolvedValueOnce({
        order_id: 'db-1',
        status: 'filled',
      });

      const order = await logic.getOrder('db-1');
      expect(order).toBeDefined();
      expect(order.order_id).toBe('db-1');
      expect(persistence.get).toHaveBeenCalledWith(
        'SELECT * FROM orders WHERE order_id = $1',
        ['db-1']
      );
    });

    it('returns undefined for non-existent order', async () => {
      persistence.get.mockResolvedValueOnce(undefined);

      const order = await logic.getOrder('non-existent');
      expect(order).toBeUndefined();
    });
  });

  describe('getOpenOrders()', () => {
    it('returns open and partially_filled orders from DB', async () => {
      persistence.all.mockResolvedValueOnce([
        { order_id: '1', status: 'open' },
        { order_id: '2', status: 'partially_filled' },
      ]);

      const orders = await logic.getOpenOrders();
      expect(orders).toHaveLength(2);
    });

    it('queries with correct status filter', async () => {
      persistence.all.mockResolvedValueOnce([]);

      await logic.getOpenOrders();

      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('status IN'),
        ['open', 'partially_filled']
      );
    });
  });

  describe('getOrdersByWindow()', () => {
    it('queries by window_id directly from DB', async () => {
      persistence.all.mockResolvedValueOnce([
        { order_id: '1', window_id: 'w1' },
      ]);

      const orders = await logic.getOrdersByWindow('w1');

      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('window_id = $1'),
        ['w1']
      );
      expect(orders).toHaveLength(1);
    });
  });

  describe('cancelOrder()', () => {
    beforeEach(() => {
      // Set up a DB-backed open order
      mockDbOrder({
        order_id: 'cancel-1',
        intent_id: 1,
        status: 'open',
        window_id: 'window-1',
      });
    });

    it('throws for invalid orderId (null)', async () => {
      await expect(logic.cancelOrder(null, mockLog)).rejects.toThrow(
        'orderId is required and must be a string'
      );
    });

    it('throws for invalid orderId (empty string)', async () => {
      await expect(logic.cancelOrder('', mockLog)).rejects.toThrow(
        'orderId is required and must be a string'
      );
    });

    it('throws for non-existent order', async () => {
      persistence.get.mockResolvedValue(undefined);

      await expect(logic.cancelOrder('non-existent', mockLog)).rejects.toThrow(
        'Order not found'
      );
    });

    it('throws for order in terminal state (filled)', async () => {
      mockDbOrder({
        order_id: 'filled-1',
        status: 'filled',
        window_id: 'window-1',
      });

      await expect(logic.cancelOrder('filled-1', mockLog)).rejects.toThrow(
        'Cannot cancel order in filled state'
      );
    });

    it('throws for order in terminal state (cancelled)', async () => {
      mockDbOrder({
        order_id: 'cancelled-1',
        status: 'cancelled',
        window_id: 'window-1',
      });

      await expect(logic.cancelOrder('cancelled-1', mockLog)).rejects.toThrow(
        'Cannot cancel order in cancelled state'
      );
    });

    it('throws for order in terminal state (expired)', async () => {
      mockDbOrder({
        order_id: 'expired-1',
        status: 'expired',
        window_id: 'window-1',
      });

      await expect(logic.cancelOrder('expired-1', mockLog)).rejects.toThrow(
        'Cannot cancel order in expired state'
      );
    });

    it('throws for order in terminal state (rejected)', async () => {
      mockDbOrder({
        order_id: 'rejected-1',
        status: 'rejected',
        window_id: 'window-1',
      });

      await expect(logic.cancelOrder('rejected-1', mockLog)).rejects.toThrow(
        'Cannot cancel order in rejected state'
      );
    });

    it('allows cancelling open orders', async () => {
      const result = await logic.cancelOrder('cancel-1', mockLog);

      expect(result.orderId).toBe('cancel-1');
      expect(polymarketClient.cancelOrder).toHaveBeenCalledWith('cancel-1');
    });

    it('allows cancelling partially filled orders', async () => {
      mockDbOrder({
        order_id: 'partial-1',
        status: 'partially_filled',
        window_id: 'window-1',
      });

      const result = await logic.cancelOrder('partial-1', mockLog);

      expect(result.orderId).toBe('partial-1');
      expect(polymarketClient.cancelOrder).toHaveBeenCalledWith('partial-1');
    });

    it('logs intent BEFORE API call', async () => {
      await logic.cancelOrder('cancel-1', mockLog);

      // Check call order
      const intentOrder = writeAhead.logIntent.mock.invocationCallOrder[0];
      const executingOrder = writeAhead.markExecuting.mock.invocationCallOrder[0];
      const cancelOrder = polymarketClient.cancelOrder.mock.invocationCallOrder[0];

      expect(intentOrder).toBeLessThan(executingOrder);
      expect(executingOrder).toBeLessThan(cancelOrder);
    });

    it('logs intent with cancel_order type', async () => {
      await logic.cancelOrder('cancel-1', mockLog);

      expect(writeAhead.logIntent).toHaveBeenCalledWith(
        'cancel_order',
        'window-1',
        expect.objectContaining({
          orderId: 'cancel-1',
          orderStatus: 'open',
          requestedAt: expect.any(String),
        })
      );
    });

    it('updates order status to cancelled in DB', async () => {
      await logic.cancelOrder('cancel-1', mockLog);

      // Verify DB update was called with cancelled status
      const updateCall = persistence.run.mock.calls.find((call) =>
        call[0].includes('UPDATE orders SET')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toContain('cancelled');
    });

    it('records latency on success', async () => {
      const result = await logic.cancelOrder('cancel-1', mockLog);

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.intentId).toBe(1);
    });

    it('marks intent completed on success', async () => {
      await logic.cancelOrder('cancel-1', mockLog);

      expect(writeAhead.markCompleted).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          orderId: 'cancel-1',
          latencyMs: expect.any(Number),
        })
      );
    });

    it('marks intent failed on API error', async () => {
      polymarketClient.cancelOrder.mockRejectedValueOnce(new Error('API Error'));

      await expect(logic.cancelOrder('cancel-1', mockLog)).rejects.toThrow(
        'Cancel order failed'
      );

      expect(writeAhead.markFailed).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          message: 'API Error',
          latencyMs: expect.any(Number),
        })
      );
    });

    it('does not update order status on API error', async () => {
      polymarketClient.cancelOrder.mockRejectedValueOnce(new Error('API Error'));

      await expect(logic.cancelOrder('cancel-1', mockLog)).rejects.toThrow();

      // No UPDATE should have been issued
      const updateCalls = persistence.run.mock.calls.filter((call) =>
        call[0].includes('UPDATE orders SET')
      );
      expect(updateCalls).toHaveLength(0);
    });

    it('logs error on API failure', async () => {
      polymarketClient.cancelOrder.mockRejectedValueOnce(new Error('Network Error'));

      await expect(logic.cancelOrder('cancel-1', mockLog)).rejects.toThrow();

      expect(mockLog.error).toHaveBeenCalledWith(
        'order_cancel_failed',
        expect.objectContaining({
          orderId: 'cancel-1',
          error: 'Network Error',
        })
      );
    });

    it('records latency even on API failure', async () => {
      polymarketClient.cancelOrder.mockRejectedValueOnce(new Error('API Error'));

      await expect(logic.cancelOrder('cancel-1', mockLog)).rejects.toThrow();

      // Latency should still be recorded for monitoring failed operations
      const statsAfter = getStats();
      expect(statsAfter.avgCancelLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('handlePartialFill()', () => {
    beforeEach(() => {
      // Set up a DB-backed open order with no fills
      mockDbOrder({
        order_id: 'partial-order-1',
        intent_id: 1,
        status: 'open',
        window_id: 'window-1',
        size: 100,
        filled_size: 0,
        avg_fill_price: null,
      });
    });

    it('throws for invalid orderId (null)', async () => {
      await expect(
        logic.handlePartialFill(null, 10, 0.5, mockLog)
      ).rejects.toThrow('orderId is required and must be a string');
    });

    it('throws for invalid orderId (empty string)', async () => {
      await expect(
        logic.handlePartialFill('', 10, 0.5, mockLog)
      ).rejects.toThrow('orderId is required and must be a string');
    });

    it('throws for invalid fillSize (zero)', async () => {
      await expect(
        logic.handlePartialFill('partial-order-1', 0, 0.5, mockLog)
      ).rejects.toThrow('fillSize must be a positive number');
    });

    it('throws for invalid fillSize (negative)', async () => {
      await expect(
        logic.handlePartialFill('partial-order-1', -10, 0.5, mockLog)
      ).rejects.toThrow('fillSize must be a positive number');
    });

    it('throws for invalid fillPrice (too low)', async () => {
      await expect(
        logic.handlePartialFill('partial-order-1', 10, 0.001, mockLog)
      ).rejects.toThrow('fillPrice must be a number between 0.01 and 0.99');
    });

    it('throws for invalid fillPrice (too high)', async () => {
      await expect(
        logic.handlePartialFill('partial-order-1', 10, 1.0, mockLog)
      ).rejects.toThrow('fillPrice must be a number between 0.01 and 0.99');
    });

    it('throws for non-existent order', async () => {
      persistence.get.mockResolvedValue(undefined);

      await expect(
        logic.handlePartialFill('non-existent', 10, 0.5, mockLog)
      ).rejects.toThrow('Order not found');
    });

    it('throws for order in terminal state', async () => {
      mockDbOrder({
        order_id: 'filled-order',
        status: 'filled',
        window_id: 'window-1',
        size: 100,
      });

      await expect(
        logic.handlePartialFill('filled-order', 10, 0.5, mockLog)
      ).rejects.toThrow('Cannot fill order in filled state');
    });

    it('updates filled_size correctly for first fill', async () => {
      // After updateOrderStatus, getOrderFromDb is called to return the result
      // We need the mock to return updated data on subsequent calls
      let callCount = 0;
      persistence.get.mockImplementation((sql, params) => {
        if (sql.includes('SELECT * FROM orders') && params[0] === 'partial-order-1') {
          callCount++;
          if (callCount <= 2) {
            // First two calls: original order (one in handlePartialFill, one in updateOrderStatus)
            return Promise.resolve({
              order_id: 'partial-order-1',
              intent_id: 1,
              status: 'open',
              window_id: 'window-1',
              size: 100,
              filled_size: 0,
              avg_fill_price: null,
            });
          }
          // Third call: after update, return updated order
          return Promise.resolve({
            order_id: 'partial-order-1',
            intent_id: 1,
            status: 'partially_filled',
            window_id: 'window-1',
            size: 100,
            filled_size: 25,
            avg_fill_price: 0.5,
          });
        }
        return Promise.resolve(undefined);
      });

      const result = await logic.handlePartialFill('partial-order-1', 25, 0.5, mockLog);

      expect(result.filled_size).toBe(25);
    });

    it('transitions to partially_filled status', async () => {
      let callCount = 0;
      persistence.get.mockImplementation((sql, params) => {
        if (sql.includes('SELECT * FROM orders') && params[0] === 'partial-order-1') {
          callCount++;
          if (callCount <= 2) {
            return Promise.resolve({
              order_id: 'partial-order-1',
              intent_id: 1,
              status: 'open',
              window_id: 'window-1',
              size: 100,
              filled_size: 0,
              avg_fill_price: null,
            });
          }
          return Promise.resolve({
            order_id: 'partial-order-1',
            intent_id: 1,
            status: 'partially_filled',
            window_id: 'window-1',
            size: 100,
            filled_size: 25,
            avg_fill_price: 0.5,
          });
        }
        return Promise.resolve(undefined);
      });

      const result = await logic.handlePartialFill('partial-order-1', 25, 0.5, mockLog);

      expect(result.status).toBe('partially_filled');
    });

    it('transitions to filled when complete', async () => {
      let callCount = 0;
      persistence.get.mockImplementation((sql, params) => {
        if (sql.includes('SELECT * FROM orders') && params[0] === 'partial-order-1') {
          callCount++;
          if (callCount <= 2) {
            return Promise.resolve({
              order_id: 'partial-order-1',
              intent_id: 1,
              status: 'open',
              window_id: 'window-1',
              size: 100,
              filled_size: 0,
              avg_fill_price: null,
            });
          }
          return Promise.resolve({
            order_id: 'partial-order-1',
            intent_id: 1,
            status: 'filled',
            window_id: 'window-1',
            size: 100,
            filled_size: 100,
            avg_fill_price: 0.5,
            filled_at: '2024-01-01T00:00:00.000Z',
          });
        }
        return Promise.resolve(undefined);
      });

      const result = await logic.handlePartialFill('partial-order-1', 100, 0.5, mockLog);

      expect(result.status).toBe('filled');
      expect(result.filled_at).toBeDefined();
    });

    it('transitions to filled when fill exceeds size', async () => {
      let callCount = 0;
      persistence.get.mockImplementation((sql, params) => {
        if (sql.includes('SELECT * FROM orders') && params[0] === 'partial-order-1') {
          callCount++;
          if (callCount <= 2) {
            return Promise.resolve({
              order_id: 'partial-order-1',
              intent_id: 1,
              status: 'open',
              window_id: 'window-1',
              size: 100,
              filled_size: 0,
              avg_fill_price: null,
            });
          }
          return Promise.resolve({
            order_id: 'partial-order-1',
            intent_id: 1,
            status: 'filled',
            window_id: 'window-1',
            size: 100,
            filled_size: 120,
            avg_fill_price: 0.5,
          });
        }
        return Promise.resolve(undefined);
      });

      const result = await logic.handlePartialFill('partial-order-1', 120, 0.5, mockLog);

      expect(result.status).toBe('filled');
    });

    it('logs partial fill event', async () => {
      await logic.handlePartialFill('partial-order-1', 25, 0.5, mockLog);

      expect(mockLog.info).toHaveBeenCalledWith(
        'partial_fill_processed',
        expect.objectContaining({
          orderId: 'partial-order-1',
          fillSize: 25,
          fillPrice: 0.5,
          newFilledSize: 25,
          newAvgPrice: 0.5,
          newStatus: 'partially_filled',
        })
      );
    });

    it('persists updates to database', async () => {
      await logic.handlePartialFill('partial-order-1', 25, 0.5, mockLog);

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders SET'),
        expect.any(Array)
      );
    });
  });

  describe('getPartiallyFilledOrders()', () => {
    it('returns partially filled orders from database', async () => {
      persistence.all.mockResolvedValueOnce([
        { order_id: 'pf-1', status: 'partially_filled' },
        { order_id: 'pf-2', status: 'partially_filled' },
      ]);

      const orders = await logic.getPartiallyFilledOrders();

      expect(orders).toHaveLength(2);
      expect(orders[0].status).toBe('partially_filled');
    });

    it('queries with correct status filter', async () => {
      persistence.all.mockResolvedValueOnce([]);

      await logic.getPartiallyFilledOrders();

      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('status = $1'),
        ['partially_filled']
      );
    });
  });
});
