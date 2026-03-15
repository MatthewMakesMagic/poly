/**
 * Fill Simulator Tests
 *
 * Tests L2 book walking, VWAP computation, slippage,
 * partial fills, and fee integration.
 */

import { describe, it, expect } from 'vitest';
import {
  simulateMarketFill,
  simulateExit,
  checkLimitFill,
  aggregateFillMetrics,
} from '../../../src/factory/fill-simulator.js';
import { FeeMode } from '../../../src/factory/fee-model.js';

// ─── Test Helpers ───

function makeBook({ asks = [], bids = [], bestAsk, bestBid }) {
  return {
    bestAsk: bestAsk ?? (asks.length > 0 ? asks[0][0] : null),
    bestBid: bestBid ?? (bids.length > 0 ? bids[0][0] : null),
    levels: {
      asks,
      bids,
    },
  };
}

function makeSimpleBook(bestAsk, askSize, bestBid, bidSize) {
  return makeBook({
    asks: [[bestAsk, askSize]],
    bids: [[bestBid, bidSize]],
  });
}

// ─── simulateMarketFill ───

describe('simulateMarketFill', () => {
  describe('basic L2 book walking', () => {
    it('fills entirely at best ask for sufficient single-level depth', () => {
      const book = makeBook({
        asks: [[0.55, 1000]],
        bestAsk: 0.55,
      });
      const result = simulateMarketFill(book, 10, { feeMode: FeeMode.ZERO });

      expect(result.success).toBe(true);
      expect(result.vwapPrice).toBeCloseTo(0.55, 5);
      expect(result.totalShares).toBeCloseTo(10 / 0.55, 3);
      expect(result.slippage).toBeCloseTo(0, 5);
      expect(result.levelsConsumed).toBe(1);
      expect(result.usedL2).toBe(true);
      expect(result.partialFill).toBe(false);
    });

    it('walks multiple ask levels for large orders', () => {
      const book = makeBook({
        asks: [
          [0.55, 10], // $5.50 available
          [0.56, 10], // $5.60 available
          [0.58, 10], // $5.80 available
        ],
        bestAsk: 0.55,
      });
      const result = simulateMarketFill(book, 12, { feeMode: FeeMode.ZERO });

      expect(result.success).toBe(true);
      expect(result.levelsConsumed).toBe(3);
      // VWAP should be > bestAsk (walked into higher levels)
      expect(result.vwapPrice).toBeGreaterThan(0.55);
      expect(result.slippage).toBeGreaterThan(0);
      expect(result.usedL2).toBe(true);
    });

    it('computes correct VWAP across levels', () => {
      const book = makeBook({
        asks: [
          [0.50, 100], // $50 available
          [0.60, 100], // $60 available
        ],
        bestAsk: 0.50,
      });
      // Buy $50 worth: fills entirely at 0.50
      const result1 = simulateMarketFill(book, 50, { feeMode: FeeMode.ZERO });
      expect(result1.vwapPrice).toBeCloseTo(0.50, 5);

      // Buy $80 worth: $50 at 0.50, $30 at 0.60
      const result2 = simulateMarketFill(book, 80, { feeMode: FeeMode.ZERO });
      // VWAP = total_cost / total_shares = 80 / (100 + 50) = 80/150 = 0.533...
      expect(result2.vwapPrice).toBeGreaterThan(0.50);
      expect(result2.vwapPrice).toBeLessThan(0.60);
      expect(result2.levelsConsumed).toBe(2);
    });

    it('reports partial fill when book depth is insufficient', () => {
      const book = makeBook({
        asks: [[0.55, 5]], // only $2.75 available
        bestAsk: 0.55,
      });
      const result = simulateMarketFill(book, 10, { feeMode: FeeMode.ZERO });

      expect(result.success).toBe(true);
      expect(result.partialFill).toBe(true);
      expect(result.unfilled).toBeGreaterThan(0);
      expect(result.totalCost).toBeCloseTo(2.75, 2);
    });

    it('computes market impact correctly', () => {
      const book = makeBook({
        asks: [
          [0.50, 20],
          [0.52, 20],
        ],
        bestAsk: 0.50,
      });
      const result = simulateMarketFill(book, 15, { feeMode: FeeMode.ZERO });

      expect(result.success).toBe(true);
      expect(result.marketImpact).toBeGreaterThanOrEqual(0);
      // marketImpact = slippage / bestAsk
      if (result.slippage > 0) {
        expect(result.marketImpact).toBeCloseTo(result.slippage / 0.50, 5);
      }
    });
  });

  describe('fallback when no L2 levels', () => {
    it('uses bestAsk + spread buffer as fill price', () => {
      const book = {
        bestAsk: 0.55,
        bestBid: 0.53,
        // No levels property
      };
      const result = simulateMarketFill(book, 10, {
        feeMode: FeeMode.ZERO,
        spreadBuffer: 0.005,
      });

      expect(result.success).toBe(true);
      expect(result.vwapPrice).toBeCloseTo(0.555, 3);
      expect(result.usedL2).toBe(false);
      expect(result.l2Fallback).toBe(true);
      expect(result.l2FallbackReason).toBeDefined();
    });

    it('sets l2Fallback flag when levels are empty', () => {
      const book = {
        bestAsk: 0.55,
        levels: { asks: [], bids: [] },
      };
      const result = simulateMarketFill(book, 10, { feeMode: FeeMode.ZERO });

      expect(result.success).toBe(true);
      expect(result.l2Fallback).toBe(true);
    });
  });

  describe('failure cases', () => {
    it('fails when no book data', () => {
      const result = simulateMarketFill(null, 10);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('no_book_data');
    });

    it('fails when no bestAsk', () => {
      const result = simulateMarketFill({ bestBid: 0.50 }, 10);
      expect(result.success).toBe(false);
    });
  });

  describe('fee integration', () => {
    it('applies taker fee by default', () => {
      const book = makeSimpleBook(0.55, 1000, 0.53, 1000);
      const result = simulateMarketFill(book, 10, { feeMode: FeeMode.TAKER_ONLY });

      expect(result.success).toBe(true);
      expect(result.feeDollars).toBeGreaterThan(0);
      expect(result.netCost).toBeGreaterThan(result.totalCost);
      expect(result.feeMode).toBe(FeeMode.TAKER_ONLY);
    });

    it('applies no fee in ZERO mode', () => {
      const book = makeSimpleBook(0.55, 1000, 0.53, 1000);
      const result = simulateMarketFill(book, 10, { feeMode: FeeMode.ZERO });

      expect(result.feeDollars).toBe(0);
      expect(result.netCost).toBe(result.totalCost);
    });

    it('maker rebate reduces cost', () => {
      const book = makeSimpleBook(0.55, 1000, 0.53, 1000);
      const result = simulateMarketFill(book, 10, { feeMode: FeeMode.MAKER_REBATE });

      expect(result.feeDollars).toBeLessThan(0); // negative = income
      expect(result.netCost).toBeLessThan(result.totalCost);
    });

    it('fee difference between modes is meaningful at p=0.50', () => {
      const book = makeSimpleBook(0.50, 10000, 0.48, 10000);

      const taker = simulateMarketFill(book, 100, { feeMode: FeeMode.TAKER_ONLY });
      const zero = simulateMarketFill(book, 100, { feeMode: FeeMode.ZERO });
      const maker = simulateMarketFill(book, 100, { feeMode: FeeMode.MAKER_REBATE });

      // Taker costs most, zero in middle, maker costs least
      expect(taker.netCost).toBeGreaterThan(zero.netCost);
      expect(zero.netCost).toBeGreaterThan(maker.netCost);

      // Fee impact should be ~1.56% at p=0.50
      const feeImpact = (taker.netCost - zero.netCost) / zero.netCost;
      expect(feeImpact).toBeCloseTo(0.015625, 3);
    });
  });
});

// ─── simulateExit ───

describe('simulateExit', () => {
  it('walks bid levels for UP exit', () => {
    const book = makeBook({
      bids: [[0.60, 100], [0.58, 100]],
      bestBid: 0.60,
    });
    const result = simulateExit(book, 50, 'up', { feeMode: FeeMode.ZERO });

    expect(result.success).toBe(true);
    expect(result.fillPrice).toBeCloseTo(0.60, 2);
    expect(result.filled).toBe(50);
    expect(result.usedL2).toBe(true);
  });

  it('walks ask levels for DOWN exit (down-bid = 1 - upAsk)', () => {
    const book = makeBook({
      asks: [[0.40, 100]], // down-bid = 0.60
      bestBid: 0.58,
    });
    const result = simulateExit(book, 50, 'down', { feeMode: FeeMode.ZERO });

    expect(result.success).toBe(true);
    expect(result.fillPrice).toBeCloseTo(0.60, 2);
    expect(result.usedL2).toBe(true);
  });

  it('falls back to bestBid when no L2 levels for UP', () => {
    const book = { bestBid: 0.55 };
    const result = simulateExit(book, 50, 'up', {
      feeMode: FeeMode.ZERO,
      spreadBuffer: 0.005,
    });

    expect(result.success).toBe(true);
    expect(result.fillPrice).toBeCloseTo(0.545, 3);
    expect(result.usedL2).toBe(false);
  });

  it('fails with no book', () => {
    const result = simulateExit(null, 50, 'up');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('no_book_or_zero_shares');
  });

  it('applies taker fee on exit', () => {
    const book = makeBook({
      bids: [[0.60, 1000]],
      bestBid: 0.60,
    });
    const taker = simulateExit(book, 50, 'up', { feeMode: FeeMode.TAKER_ONLY });
    const zero = simulateExit(book, 50, 'up', { feeMode: FeeMode.ZERO });

    expect(taker.netProceeds).toBeLessThan(zero.netProceeds);
  });
});

// ─── checkLimitFill ───

describe('checkLimitFill', () => {
  it('fills limit buy when bestAsk <= order price', () => {
    const book = { bestAsk: 0.50, bestBid: 0.48 };
    const order = { side: 'buy', price: 0.52, size: 100 };
    const result = checkLimitFill(order, book);

    expect(result.filled).toBe(true);
    expect(result.price).toBe(0.52); // fills at limit price
    expect(result.feeMode).toBe(FeeMode.MAKER_REBATE); // default for limit
  });

  it('does not fill limit buy when bestAsk > order price', () => {
    const book = { bestAsk: 0.55, bestBid: 0.53 };
    const order = { side: 'buy', price: 0.52, size: 100 };
    const result = checkLimitFill(order, book);

    expect(result.filled).toBe(false);
    expect(result.reason).toContain('limit_not_crossed');
  });

  it('fills limit sell when bestBid >= order price', () => {
    const book = { bestAsk: 0.55, bestBid: 0.53 };
    const order = { side: 'sell', price: 0.50, size: 100 };
    const result = checkLimitFill(order, book);

    expect(result.filled).toBe(true);
    expect(result.price).toBe(0.50);
  });

  it('includes maker rebate for limit fills', () => {
    const book = { bestAsk: 0.50, bestBid: 0.48 };
    const order = { side: 'buy', price: 0.52, size: 100 };
    const result = checkLimitFill(order, book, { feeMode: FeeMode.MAKER_REBATE });

    expect(result.filled).toBe(true);
    expect(result.rebateDollars).toBeGreaterThan(0);
    expect(result.feeDollars).toBeLessThan(0); // income
  });

  it('handles null book gracefully', () => {
    const result = checkLimitFill({ side: 'buy', price: 0.50, size: 100 }, null);
    expect(result.filled).toBe(false);
  });
});

// ─── aggregateFillMetrics ───

describe('aggregateFillMetrics', () => {
  it('computes averages for multiple fills', () => {
    const fills = [
      { success: true, slippage: 0.01, marketImpact: 0.02, feeDollars: 0.5, usedL2: true, levelsConsumed: 2, partialFill: false },
      { success: true, slippage: 0.02, marketImpact: 0.04, feeDollars: 0.3, usedL2: true, levelsConsumed: 3, partialFill: false },
      { success: true, slippage: 0.005, marketImpact: 0.01, feeDollars: 0.2, usedL2: false, levelsConsumed: 1, partialFill: true },
    ];
    const metrics = aggregateFillMetrics(fills);

    expect(metrics.count).toBe(3);
    expect(metrics.avgSlippage).toBeCloseTo(0.01167, 3);
    expect(metrics.totalFees).toBeCloseTo(1.0, 2);
    expect(metrics.l2CoverageRate).toBeCloseTo(2 / 3, 3);
    expect(metrics.avgLevelsConsumed).toBe(2);
    expect(metrics.partialFillRate).toBeCloseTo(1 / 3, 3);
  });

  it('returns zeros for empty fills', () => {
    const metrics = aggregateFillMetrics([]);
    expect(metrics.count).toBe(0);
    expect(metrics.avgSlippage).toBe(0);
    expect(metrics.totalFees).toBe(0);
  });

  it('filters out failed fills', () => {
    const fills = [
      { success: false },
      { success: true, slippage: 0.01, marketImpact: 0.02, feeDollars: 0.5, usedL2: true, levelsConsumed: 1, partialFill: false },
    ];
    const metrics = aggregateFillMetrics(fills);
    expect(metrics.count).toBe(1);
  });
});

// ─── Edge cases ───

describe('edge cases', () => {
  it('handles book with asks at invalid prices (>= 1.0)', () => {
    const book = makeBook({
      asks: [[1.0, 100], [0.99, 50]],
      bestAsk: 0.99,
    });
    const result = simulateMarketFill(book, 10, { feeMode: FeeMode.ZERO });
    // Should skip the 1.0 level and fill at 0.99
    expect(result.success).toBe(true);
    expect(result.vwapPrice).toBeCloseTo(0.99, 2);
  });

  it('handles very small dollar amounts', () => {
    const book = makeSimpleBook(0.55, 1000, 0.53, 1000);
    const result = simulateMarketFill(book, 0.01, { feeMode: FeeMode.TAKER_ONLY });
    expect(result.success).toBe(true);
    expect(result.totalShares).toBeGreaterThan(0);
  });

  it('handles large order eating through entire book', () => {
    const book = makeBook({
      asks: [
        [0.50, 10],
        [0.55, 10],
        [0.60, 10],
      ],
      bestAsk: 0.50,
    });
    // Total available: 5 + 5.5 + 6 = 16.5
    const result = simulateMarketFill(book, 100, { feeMode: FeeMode.ZERO });
    expect(result.partialFill).toBe(true);
    expect(result.totalCost).toBeCloseTo(16.5, 1);
    expect(result.levelsConsumed).toBe(3);
  });
});
