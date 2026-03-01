/**
 * Phase 0.7: Unified execute() Tests
 *
 * Tests for the unified OrderManager.execute(signal, mode) entry point
 * that routes to different fill sources based on mode.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
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
    orderId: 'order-live-123',
    status: 'matched',
    priceFilled: 0.52,
    shares: 9.61,
    cost: 5,
    success: true,
  }),
  sell: vi.fn().mockResolvedValue({
    orderId: 'order-live-456',
    status: 'matched',
    success: true,
  }),
  cancelOrder: vi.fn().mockResolvedValue({ success: true }),
  getUSDCBalance: vi.fn().mockResolvedValue(1000),
  getOrder: vi.fn().mockResolvedValue({ status: 'matched', size_matched: '10' }),
  getBestPrices: vi.fn().mockResolvedValue({
    bid: 0.48,
    ask: 0.52,
    spread: 0.04,
    midpoint: 0.50,
  }),
}));

// Import after mocks
import * as logic from '../logic.js';
import { clearStats } from '../state.js';
import persistence from '../../../persistence/index.js';

const validSignal = {
  tokenId: 'token-123',
  side: 'buy',
  size: 3,
  price: 0.52,
  orderType: 'IOC',
  windowId: 'btc-15m-1000',
  marketId: 'market-123',
  signalContext: {
    edge: 0.05,
    modelProbability: 0.55,
    symbol: 'btc',
    strategyId: 'vwap-contrarian',
    sideToken: 'UP',
  },
};

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('OrderManager.execute (Phase 0.7 unified pipeline)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStats();
    // Reset window order cap check to return 0 existing orders
    persistence.get.mockResolvedValue({ count: 0 });
  });

  describe('mode routing', () => {
    it('routes LIVE mode to placeOrder (Polymarket API)', async () => {
      const result = await logic.execute(validSignal, 'LIVE', mockLog);

      expect(result.orderId).toBe('order-live-123');
      expect(result.orderSubmittedToExchange).toBe(true);
      expect(result.status).toBe('filled');
    });

    it('routes DRY_RUN mode to placeDryRunOrder', async () => {
      const result = await logic.execute(validSignal, 'DRY_RUN', mockLog);

      expect(result.orderId).toMatch(/^dryrun-/);
      expect(result.orderSubmittedToExchange).toBe(false);
      expect(result.mode).toBe('DRY_RUN');
      expect(result.status).toBe('filled');
    });

    it('routes PAPER mode to placePaperOrder', async () => {
      const result = await logic.execute(validSignal, 'PAPER', mockLog);

      expect(result.orderId).toMatch(/^paper-/);
      expect(result.orderSubmittedToExchange).toBe(false);
      expect(result.mode).toBe('PAPER');
      expect(result.status).toBe('filled');
    });

    it('throws on unknown mode', async () => {
      await expect(
        logic.execute(validSignal, 'INVALID', mockLog)
      ).rejects.toThrow('Unknown trading mode: INVALID');
    });
  });

  describe('placePaperOrder', () => {
    it('produces a filled order with synthetic ID', async () => {
      const result = await logic.placePaperOrder(validSignal, mockLog);

      expect(result.orderId).toMatch(/^paper-/);
      expect(result.status).toBe('filled');
      expect(result.orderSubmittedToExchange).toBe(false);
      expect(result.mode).toBe('PAPER');
    });

    it('uses CLOB best ask for buy fill price', async () => {
      const result = await logic.placePaperOrder(validSignal, mockLog);

      // Best ask is 0.52 from mock
      expect(result.fillPrice).toBe(0.52);
    });

    it('persists order with mode=PAPER to database', async () => {
      await logic.placePaperOrder(validSignal, mockLog);

      // Check that persistence.run was called with PAPER mode
      const insertCall = persistence.run.mock.calls.find(
        call => call[0].includes('INSERT INTO orders')
      );
      expect(insertCall).toBeDefined();
      // mode is the 25th parameter
      const params = insertCall[1];
      expect(params).toContain('PAPER');
    });

    it('validates parameters identically to live', async () => {
      const invalidSignal = { ...validSignal, tokenId: '' };

      await expect(
        logic.placePaperOrder(invalidSignal, mockLog)
      ).rejects.toThrow('Order validation failed');
    });

    it('enforces window order cap', async () => {
      // Return cap-exceeded count
      persistence.get.mockResolvedValue({ count: 2 });

      await expect(
        logic.placePaperOrder(validSignal, mockLog)
      ).rejects.toThrow(/Max.*orders per window/);
    });

    it('includes order book snapshot', async () => {
      const result = await logic.placePaperOrder(validSignal, mockLog);

      expect(result.orderBookSnapshot).toBeDefined();
      expect(result.orderBookSnapshot.bid).toBe(0.48);
      expect(result.orderBookSnapshot.ask).toBe(0.52);
      expect(result.orderBookSnapshot.spread).toBe(0.04);
    });

    it('calculates filled size as dollars / fill price for buys', async () => {
      const result = await logic.placePaperOrder(validSignal, mockLog);

      // size=3, fillPrice=0.52 -> filledSize = 3/0.52 ~= 5.769...
      expect(result.filledSize).toBeCloseTo(3 / 0.52, 4);
    });

    it('returns zero fee amount', async () => {
      const result = await logic.placePaperOrder(validSignal, mockLog);

      expect(result.feeAmount).toBe(0);
    });

    it('includes timestamps in the result', async () => {
      const result = await logic.placePaperOrder(validSignal, mockLog);

      expect(result.timestamps).toBeDefined();
      expect(result.timestamps.orderSubmittedAt).toBeDefined();
      expect(result.timestamps.orderAckedAt).toBeDefined();
      expect(result.timestamps.orderFilledAt).toBeDefined();
    });
  });

  describe('uniform result shape', () => {
    it('LIVE, DRY_RUN, and PAPER all return orderId + status + fillPrice', async () => {
      const liveResult = await logic.execute(validSignal, 'LIVE', mockLog);
      persistence.get.mockResolvedValue({ count: 0 }); // reset cap
      const dryResult = await logic.execute(validSignal, 'DRY_RUN', mockLog);
      persistence.get.mockResolvedValue({ count: 0 }); // reset cap
      const paperResult = await logic.execute(validSignal, 'PAPER', mockLog);

      // All have the core result fields
      for (const result of [liveResult, dryResult, paperResult]) {
        expect(result).toHaveProperty('orderId');
        expect(result).toHaveProperty('status');
        expect(result).toHaveProperty('latencyMs');
        expect(result).toHaveProperty('intentId');
        expect(typeof result.orderSubmittedToExchange).toBe('boolean');
      }

      // Only LIVE has orderSubmittedToExchange=true
      expect(liveResult.orderSubmittedToExchange).toBe(true);
      expect(dryResult.orderSubmittedToExchange).toBe(false);
      expect(paperResult.orderSubmittedToExchange).toBe(false);
    });
  });
});
