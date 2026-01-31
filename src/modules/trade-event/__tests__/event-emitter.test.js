/**
 * Trade Event Module - EventEmitter Integration Tests
 *
 * Tests for the event subscription system used by Scout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as tradeEvent from '../index.js';
import { subscribe, subscribeAll } from '../index.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock database functions
vi.mock('../logic.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    insertTradeEvent: vi.fn(() => 1),
    positionExists: vi.fn(() => true),
    queryDivergenceSummary: vi.fn(() => ({
      eventsWithDivergence: 0,
      divergenceRate: 0,
      flagCounts: {},
    })),
  };
});

describe('Trade Event EventEmitter', () => {
  beforeEach(async () => {
    await tradeEvent.shutdown().catch(() => {});
    await tradeEvent.init({});
  });

  afterEach(async () => {
    await tradeEvent.shutdown().catch(() => {});
    vi.clearAllMocks();
  });

  describe('subscribe', () => {
    it('should receive signal events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('signal', callback);

      await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        windowId: 'window-123',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      }));

      unsubscribe();
    });

    it('should receive entry events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('entry', callback);

      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 'order-1',
        strategyId: 'strategy-1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00Z',
          orderSubmittedAt: '2026-01-31T10:00:00.100Z',
          orderFilledAt: '2026-01-31T10:00:00.300Z',
        },
        prices: {
          priceAtSignal: 0.42,
          priceAtFill: 0.421,
          expectedPrice: 0.42,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        windowId: 'window-123',
        positionId: 1,
        orderId: 'order-1',
        strategyId: 'strategy-1',
      }));

      unsubscribe();
    });

    it('should receive exit events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('exit', callback);

      await tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 1,
        exitReason: 'take_profit',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        windowId: 'window-123',
        positionId: 1,
        exitReason: 'take_profit',
      }));

      unsubscribe();
    });

    it('should receive alert events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('alert', callback);

      await tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'latency',
        data: { message: 'High latency detected' },
        level: 'warn',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        windowId: 'window-123',
        alertType: 'latency',
        level: 'warn',
      }));

      unsubscribe();
    });

    it('should receive divergence events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('divergence', callback);

      await tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'divergence',
        data: { message: 'State divergence detected' },
        level: 'error',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        windowId: 'window-123',
        alertType: 'divergence',
        level: 'error',
      }));

      unsubscribe();
    });

    it('should unsubscribe correctly', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('signal', callback);

      // First event should be received
      await tradeEvent.recordSignal({
        windowId: 'window-1',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      });

      expect(callback).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Second event should not be received
      await tradeEvent.recordSignal({
        windowId: 'window-2',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.43,
      });

      expect(callback).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('subscribeAll', () => {
    it('should receive all event types', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribeAll(callback);

      // Signal
      await tradeEvent.recordSignal({
        windowId: 'window-1',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      });

      // Entry
      await tradeEvent.recordEntry({
        windowId: 'window-1',
        positionId: 1,
        orderId: 'order-1',
        strategyId: 'strategy-1',
        timestamps: {},
        prices: { priceAtFill: 0.42 },
        sizes: { requestedSize: 100, filledSize: 100 },
      });

      // Exit
      await tradeEvent.recordExit({
        windowId: 'window-1',
        positionId: 1,
        exitReason: 'take_profit',
      });

      // Alert
      await tradeEvent.recordAlert({
        windowId: 'window-1',
        alertType: 'latency',
        data: {},
        level: 'warn',
      });

      expect(callback).toHaveBeenCalledTimes(4);

      // Verify each event type was received
      const calls = callback.mock.calls;
      expect(calls[0][0].type).toBe('signal');
      expect(calls[1][0].type).toBe('entry');
      expect(calls[2][0].type).toBe('exit');
      expect(calls[3][0].type).toBe('alert');

      unsubscribe();
    });

    it('should unsubscribe from all event types', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribeAll(callback);

      await tradeEvent.recordSignal({
        windowId: 'window-1',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      });

      expect(callback).toHaveBeenCalledTimes(1);

      unsubscribe();

      // More events should not be received
      await tradeEvent.recordSignal({
        windowId: 'window-2',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.43,
      });

      await tradeEvent.recordAlert({
        windowId: 'window-2',
        alertType: 'latency',
        data: {},
        level: 'warn',
      });

      expect(callback).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('event data', () => {
    it('should include eventId in emitted events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('signal', callback);

      await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      });

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        eventId: expect.any(Number),
      }));

      unsubscribe();
    });

    it('should include timestamp in signal events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('signal', callback);

      await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'strategy-1',
        signalType: 'entry',
        priceAtSignal: 0.42,
      });

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        timestamp: expect.any(String),
      }));

      unsubscribe();
    });

    it('should include hasDivergence in entry events', async () => {
      const callback = vi.fn();
      const unsubscribe = subscribe('entry', callback);

      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 'order-1',
        strategyId: 'strategy-1',
        timestamps: {},
        prices: { priceAtFill: 0.42 },
        sizes: { requestedSize: 100, filledSize: 100 },
      });

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        hasDivergence: expect.any(Boolean),
      }));

      unsubscribe();
    });
  });
});
