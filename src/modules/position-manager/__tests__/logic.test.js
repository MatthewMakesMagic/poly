/**
 * Position Manager Logic Tests (V3 Stage 4: DB as single source of truth)
 *
 * Tests the business logic for position management.
 * Uses vitest with mocked dependencies.
 * All state queries now go through DB via persistence mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    runReturningId: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../persistence/write-ahead.js', () => ({
  logIntent: vi.fn().mockReturnValue(1),
  markExecuting: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  INTENT_TYPES: { OPEN_POSITION: 'open_position', CLOSE_POSITION: 'close_position' },
}));

// Import after mocks
import { calculateUnrealizedPnl, checkLimits } from '../logic.js';
import persistence from '../../../persistence/index.js';

describe('Position Manager Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock implementations
    persistence.get.mockResolvedValue(undefined);
    persistence.all.mockResolvedValue([]);
    persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });
    persistence.runReturningId.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateUnrealizedPnl()', () => {
    it('returns 0 when current_price is null', () => {
      const position = {
        entry_price: 0.5,
        current_price: null,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBe(0);
    });

    it('returns 0 when current_price is undefined', () => {
      const position = {
        entry_price: 0.5,
        current_price: undefined,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBe(0);
    });

    it('calculates profit for long position with price increase', () => {
      // Long BTC at 0.45, current 0.50, size 100: (0.50 - 0.45) * 100 * 1 = +5 profit
      const position = {
        entry_price: 0.45,
        current_price: 0.50,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(5, 5);
    });

    it('calculates loss for long position with price decrease', () => {
      // Long SOL at 0.30, current 0.25, size 200: (0.25 - 0.30) * 200 * 1 = -10 loss
      const position = {
        entry_price: 0.30,
        current_price: 0.25,
        size: 200,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(-10, 5);
    });

    it('calculates profit for short position with price decrease', () => {
      // Short ETH at 0.60, current 0.55, size 50: (0.55 - 0.60) * 50 * -1 = +2.5 profit
      const position = {
        entry_price: 0.60,
        current_price: 0.55,
        size: 50,
        side: 'short',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(2.5, 5);
    });

    it('calculates loss for short position with price increase', () => {
      // Short at 0.40, current 0.50, size 100: (0.50 - 0.40) * 100 * -1 = -10 loss
      const position = {
        entry_price: 0.40,
        current_price: 0.50,
        size: 100,
        side: 'short',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(-10, 5);
    });

    it('returns 0 when entry_price equals current_price', () => {
      const position = {
        entry_price: 0.5,
        current_price: 0.5,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBe(0);
    });

    it('handles small price differences correctly', () => {
      const position = {
        entry_price: 0.501,
        current_price: 0.502,
        size: 1000,
        side: 'long',
      };

      // (0.502 - 0.501) * 1000 * 1 = 1
      expect(calculateUnrealizedPnl(position)).toBeCloseTo(1, 5);
    });

    it('handles large positions correctly', () => {
      const position = {
        entry_price: 0.50,
        current_price: 0.51,
        size: 10000,
        side: 'long',
      };

      // (0.51 - 0.50) * 10000 * 1 = 100
      expect(calculateUnrealizedPnl(position)).toBeCloseTo(100, 5);
    });

    it('handles edge case with zero entry price', () => {
      const position = {
        entry_price: 0,
        current_price: 0.5,
        size: 100,
        side: 'long',
      };

      // (0.5 - 0) * 100 * 1 = 50
      expect(calculateUnrealizedPnl(position)).toBe(50);
    });

    it('handles fractional size', () => {
      const position = {
        entry_price: 0.50,
        current_price: 0.60,
        size: 10.5,
        side: 'long',
      };

      // (0.60 - 0.50) * 10.5 * 1 = 1.05
      expect(calculateUnrealizedPnl(position)).toBeCloseTo(1.05, 5);
    });
  });

  describe('checkLimits()', () => {
    const defaultRiskConfig = {
      maxPositionSize: 100,
      maxExposure: 500,
      positionLimitPerMarket: 1,
    };

    it('rejects position exceeding maxPositionSize', async () => {
      const params = { size: 150, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('maxPositionSize');
      expect(result.reason).toContain('150');
      expect(result.reason).toContain('100');
    });

    it('allows position within maxPositionSize', async () => {
      // Mock DB: no existing exposure
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      const params = { size: 50, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('allows position at exactly maxPositionSize', async () => {
      // Mock DB: no existing exposure
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      const params = { size: 100, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('rejects position exceeding maxExposure', async () => {
      // Mock DB: existing exposure of 400
      persistence.get.mockResolvedValueOnce({ total: 400 }); // calculateTotalExposure

      // New position size is within limit (100), but exposure would exceed max
      // Current exposure: 400
      // New position would add 100 * 1.5 = 150 exposure, total = 400 + 150 = 550 > 500
      const params = { size: 100, entryPrice: 1.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('maxExposure');
    });

    it('allows position within maxExposure', async () => {
      // Mock DB: existing exposure of 100
      persistence.get.mockResolvedValueOnce({ total: 100 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      // New position would add 50 * 0.5 = 25 exposure, total = 100 + 25 = 125 < 500
      const params = { size: 50, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('rejects position exceeding positionLimitPerMarket', async () => {
      // Mock DB: no exposure issue, but 1 existing position in market
      persistence.get.mockResolvedValueOnce({ total: 25 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 1 }); // countPositionsByMarket

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('positionLimitPerMarket');
      expect(result.reason).toContain('market-1');
    });

    it('allows position in different market even if other market has position', async () => {
      // Mock DB: no exposure issue, no positions in market-2
      persistence.get.mockResolvedValueOnce({ total: 25 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket for market-2

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-2' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('allows multiple positions when positionLimitPerMarket > 1', async () => {
      const config = { ...defaultRiskConfig, positionLimitPerMarket: 3 };

      // Mock DB: 1 existing position in market
      persistence.get.mockResolvedValueOnce({ total: 15 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 1 }); // countPositionsByMarket

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, config);

      expect(result.allowed).toBe(true);
    });

    it('ignores closed positions when counting market positions', async () => {
      // Mock DB: no open positions in market (closed ones are not counted by SQL)
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket (only counts open)

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };

      const result = await checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });
  });

  describe('calculateTotalExposure() via checkLimits', () => {
    const riskConfig = {
      maxPositionSize: 10000,
      maxExposure: 10000,
      positionLimitPerMarket: 10,
    };

    it('returns 0 when no positions exist', async () => {
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      const params = { size: 1, entryPrice: 0.5, marketId: 'market-1' };
      const result = await checkLimits(params, riskConfig);
      expect(result.allowed).toBe(true);
    });

    it('calculates exposure for open positions from DB', async () => {
      // DB returns total exposure of 50 (100 * 0.5)
      persistence.get.mockResolvedValueOnce({ total: 50 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      const params = { size: 100, entryPrice: 0.5, marketId: 'market-1' };
      const result = await checkLimits(params, riskConfig);
      expect(result.allowed).toBe(true);
    });

    it('sums exposure for multiple open positions from DB', async () => {
      // DB returns total exposure of 100 (100*0.5 + 200*0.25)
      persistence.get.mockResolvedValueOnce({ total: 100 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      const params = { size: 100, entryPrice: 0.5, marketId: 'market-1' };
      const result = await checkLimits(params, riskConfig);
      expect(result.allowed).toBe(true);
    });
  });

  describe('countPositionsByMarket() via checkLimits', () => {
    const riskConfig = {
      maxPositionSize: 10000,
      maxExposure: 10000,
      positionLimitPerMarket: 2,
    };

    it('returns 0 when no positions exist', async () => {
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 0 }); // countPositionsByMarket

      const params = { size: 10, entryPrice: 0.5, marketId: 'market-1' };
      const result = await checkLimits(params, riskConfig);
      expect(result.allowed).toBe(true);
    });

    it('counts positions for specific market from DB', async () => {
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 2 }); // countPositionsByMarket = 2 (at limit)

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };
      const result = await checkLimits(params, riskConfig);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('positionLimitPerMarket');
    });

    it('ignores closed positions in DB count', async () => {
      // DB WHERE clause only counts open, so closed are already excluded
      persistence.get.mockResolvedValueOnce({ total: 0 }); // calculateTotalExposure
      persistence.get.mockResolvedValueOnce({ count: 1 }); // countPositionsByMarket (only open)

      const params = { size: 10, entryPrice: 0.5, marketId: 'market-1' };
      const result = await checkLimits(params, riskConfig);
      expect(result.allowed).toBe(true);
    });
  });
});
