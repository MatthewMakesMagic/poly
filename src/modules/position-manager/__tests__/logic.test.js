/**
 * Position Manager Logic Tests
 *
 * Tests the business logic for position management.
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
import {
  clearCache,
  cachePosition,
  calculateTotalExposure,
  countPositionsByMarket,
} from '../state.js';

describe('Position Manager Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  afterEach(() => {
    clearCache();
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

    it('rejects position exceeding maxPositionSize', () => {
      const params = { size: 150, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('maxPositionSize');
      expect(result.reason).toContain('150');
      expect(result.reason).toContain('100');
    });

    it('allows position within maxPositionSize', () => {
      const params = { size: 50, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('allows position at exactly maxPositionSize', () => {
      const params = { size: 100, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('rejects position exceeding maxExposure', () => {
      // First add a position to create existing exposure
      cachePosition({
        id: 1,
        market_id: 'market-other',
        size: 400,
        entry_price: 1.0,
        status: 'open',
      });

      // New position size is within limit (100), but exposure would exceed max
      // Current exposure: 400 * 1.0 = 400
      // New position would add 100 * 1.5 = 150 exposure, total = 400 + 150 = 550 > 500
      const params = { size: 100, entryPrice: 1.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('maxExposure');
    });

    it('allows position within maxExposure', () => {
      // First add a position to create existing exposure
      cachePosition({
        id: 1,
        market_id: 'market-other',
        size: 100,
        entry_price: 1.0,
        status: 'open',
      });

      // New position would add 50 * 0.5 = 25 exposure, total = 100 + 25 = 125 < 500
      const params = { size: 50, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('rejects position exceeding positionLimitPerMarket', () => {
      // Add existing position in the same market
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 50,
        entry_price: 0.5,
        status: 'open',
      });

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe('positionLimitPerMarket');
      expect(result.reason).toContain('market-1');
    });

    it('allows position in different market even if other market has position', () => {
      // Add existing position in different market
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 50,
        entry_price: 0.5,
        status: 'open',
      });

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-2' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });

    it('allows multiple positions when positionLimitPerMarket > 1', () => {
      const config = { ...defaultRiskConfig, positionLimitPerMarket: 3 };

      // Add existing position
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 30,
        entry_price: 0.5,
        status: 'open',
      });

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, config);

      expect(result.allowed).toBe(true);
    });

    it('ignores closed positions when counting market positions', () => {
      // Add closed position in same market
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 50,
        entry_price: 0.5,
        status: 'closed',
      });

      const params = { size: 30, entryPrice: 0.5, marketId: 'market-1' };

      const result = checkLimits(params, defaultRiskConfig);

      expect(result.allowed).toBe(true);
    });
  });

  describe('calculateTotalExposure()', () => {
    it('returns 0 when no positions exist', () => {
      expect(calculateTotalExposure()).toBe(0);
    });

    it('calculates exposure for single open position', () => {
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 100,
        entry_price: 0.5,
        status: 'open',
      });

      // 100 * 0.5 = 50
      expect(calculateTotalExposure()).toBe(50);
    });

    it('sums exposure for multiple open positions', () => {
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 100,
        entry_price: 0.5,
        status: 'open',
      });
      cachePosition({
        id: 2,
        market_id: 'market-2',
        size: 200,
        entry_price: 0.25,
        status: 'open',
      });

      // 100 * 0.5 + 200 * 0.25 = 50 + 50 = 100
      expect(calculateTotalExposure()).toBe(100);
    });

    it('ignores closed positions', () => {
      cachePosition({
        id: 1,
        market_id: 'market-1',
        size: 100,
        entry_price: 0.5,
        status: 'open',
      });
      cachePosition({
        id: 2,
        market_id: 'market-2',
        size: 200,
        entry_price: 0.5,
        status: 'closed',
      });

      // Only counts open: 100 * 0.5 = 50
      expect(calculateTotalExposure()).toBe(50);
    });
  });

  describe('countPositionsByMarket()', () => {
    it('returns 0 when no positions exist', () => {
      expect(countPositionsByMarket('market-1')).toBe(0);
    });

    it('counts positions for specific market', () => {
      cachePosition({ id: 1, market_id: 'market-1', status: 'open', size: 10, entry_price: 0.5 });
      cachePosition({ id: 2, market_id: 'market-1', status: 'open', size: 20, entry_price: 0.5 });
      cachePosition({ id: 3, market_id: 'market-2', status: 'open', size: 30, entry_price: 0.5 });

      expect(countPositionsByMarket('market-1')).toBe(2);
      expect(countPositionsByMarket('market-2')).toBe(1);
    });

    it('ignores closed positions', () => {
      cachePosition({ id: 1, market_id: 'market-1', status: 'open', size: 10, entry_price: 0.5 });
      cachePosition({ id: 2, market_id: 'market-1', status: 'closed', size: 20, entry_price: 0.5 });

      expect(countPositionsByMarket('market-1')).toBe(1);
    });
  });
});
