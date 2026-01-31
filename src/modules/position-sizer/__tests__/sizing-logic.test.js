/**
 * Position Sizing Logic Unit Tests
 *
 * Tests the core sizing calculation logic.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  calculateSize,
  analyzeOrderbookLiquidity,
  calculateBaseSize,
  checkExposureLimits,
} from '../sizing-logic.js';
import { AdjustmentReason, RejectionCode } from '../types.js';

// Mock logger
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Base configs
const defaultSizingConfig = {
  baseSizeDollars: 10,
  minSizeDollars: 1,
  maxSlippagePct: 0.01,
  confidenceMultiplier: 0.5,
};

const defaultRiskConfig = {
  maxPositionSize: 100,
  maxExposure: 500,
};

// Mock signal
const mockSignal = {
  window_id: 'btc-15m-2026-01-31',
  market_id: 'btc-market',
  token_id: 'btc-token',
  direction: 'long',
  confidence: 0.7,
};

// Good orderbook with plenty of liquidity
const goodOrderbook = {
  asks: [
    { price: '0.50', size: '100' }, // $50
    { price: '0.505', size: '200' }, // $101
  ],
  bids: [
    { price: '0.49', size: '100' },
    { price: '0.485', size: '200' },
  ],
};

describe('calculateSize', () => {
  it('returns successful result with no adjustment when all limits pass', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(true);
    expect(result.adjustment_reason).toBe(AdjustmentReason.NO_ADJUSTMENT);
    expect(result.requested_size).toBe(10);
    // With confidence 0.7 and multiplier 0.5: 10 * (1 + (0.7 - 0.5) * 0.5) = 10 * 1.1 = 11
    expect(result.actual_size).toBe(11);
  });

  it('applies confidence multiplier correctly', async () => {
    // High confidence signal
    const highConfidenceSignal = { ...mockSignal, confidence: 1.0 };

    const result = await calculateSize(highConfidenceSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    // With confidence 1.0 and multiplier 0.5: 10 * (1 + (1.0 - 0.5) * 0.5) = 10 * 1.25 = 12.5
    expect(result.actual_size).toBe(12.5);
  });

  it('skips confidence multiplier when set to 0', async () => {
    const noMultiplierConfig = { ...defaultSizingConfig, confidenceMultiplier: 0 };

    const result = await calculateSize(mockSignal, {
      sizingConfig: noMultiplierConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.actual_size).toBe(10);
  });

  it('caps size at maxPositionSize', async () => {
    const largeSizingConfig = { ...defaultSizingConfig, baseSizeDollars: 200, confidenceMultiplier: 0 };
    const smallMaxConfig = { ...defaultRiskConfig, maxPositionSize: 50 };

    const result = await calculateSize(mockSignal, {
      sizingConfig: largeSizingConfig,
      riskConfig: smallMaxConfig,
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(true);
    expect(result.actual_size).toBe(50);
    expect(result.adjustment_reason).toBe(AdjustmentReason.POSITION_LIMIT_CAPPED);
  });

  it('reduces size for exposure headroom', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: { ...defaultSizingConfig, confidenceMultiplier: 0 },
      riskConfig: { ...defaultRiskConfig, maxExposure: 100 },
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(95), // Only $5 headroom
      log: mockLog,
    });

    expect(result.success).toBe(true);
    expect(result.actual_size).toBe(5);
    expect(result.adjustment_reason).toBe(AdjustmentReason.EXPOSURE_CAPPED);
  });

  it('rejects when exposure headroom below minimum', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: { ...defaultRiskConfig, maxExposure: 100 },
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(99.5), // Only $0.50 headroom
      log: mockLog,
    });

    expect(result.success).toBe(false);
    expect(result.actual_size).toBe(0);
    expect(result.adjustment_reason).toBe(AdjustmentReason.REJECTED);
    expect(result.rejection_code).toBe(RejectionCode.EXPOSURE_CAP_EXCEEDED);
  });

  it('reduces size for liquidity constraint', async () => {
    const limitedOrderbook = {
      asks: [{ price: '0.50', size: '10' }], // Only $5 available
      bids: [],
    };

    const result = await calculateSize(mockSignal, {
      sizingConfig: { ...defaultSizingConfig, confidenceMultiplier: 0 },
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(limitedOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(true);
    expect(result.actual_size).toBe(5);
    expect(result.adjustment_reason).toBe(AdjustmentReason.LIQUIDITY_LIMITED);
  });

  it('rejects when liquidity below minimum', async () => {
    const tinyOrderbook = {
      asks: [{ price: '0.50', size: '1' }], // Only $0.50 available
      bids: [],
    };

    const result = await calculateSize(mockSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(tinyOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(false);
    expect(result.actual_size).toBe(0);
    expect(result.adjustment_reason).toBe(AdjustmentReason.REJECTED);
    expect(result.rejection_code).toBe(RejectionCode.INSUFFICIENT_LIQUIDITY);
  });

  it('handles orderbook fetch error gracefully', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockRejectedValue(new Error('API timeout')),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(false);
    expect(result.adjustment_reason).toBe(AdjustmentReason.REJECTED);
  });

  it('handles missing getOrderBook function', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: null,
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(false);
  });

  it('uses 0 exposure when getCurrentExposure not provided', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: { ...defaultSizingConfig, confidenceMultiplier: 0 },
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: null,
      log: mockLog,
    });

    expect(result.success).toBe(true);
    expect(result.current_exposure).toBe(0);
    expect(result.exposure_headroom).toBe(500);
  });

  it('includes all required fields in result', async () => {
    const result = await calculateSize(mockSignal, {
      sizingConfig: defaultSizingConfig,
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(goodOrderbook),
      getCurrentExposure: vi.fn().mockReturnValue(100),
      log: mockLog,
    });

    expect(result).toMatchObject({
      success: expect.any(Boolean),
      requested_size: expect.any(Number),
      actual_size: expect.any(Number),
      adjustment_reason: expect.any(String),
      window_id: 'btc-15m-2026-01-31',
      market_id: 'btc-market',
      token_id: 'btc-token',
      direction: 'long',
      confidence: 0.7,
      available_liquidity: expect.any(Number),
      estimated_slippage: expect.any(Number),
      current_exposure: 100,
      exposure_headroom: 400,
      sized_at: expect.any(String),
    });
  });

  it('looks at bids for sell orders', async () => {
    const shortSignal = { ...mockSignal, direction: 'short' };
    const orderbookWithBids = {
      asks: [],
      bids: [{ price: '0.50', size: '20' }], // $10 available on bids
    };

    const result = await calculateSize(shortSignal, {
      sizingConfig: { ...defaultSizingConfig, confidenceMultiplier: 0 },
      riskConfig: defaultRiskConfig,
      getOrderBook: vi.fn().mockResolvedValue(orderbookWithBids),
      getCurrentExposure: vi.fn().mockReturnValue(0),
      log: mockLog,
    });

    expect(result.success).toBe(true);
    expect(result.direction).toBe('short');
    expect(result.actual_size).toBe(10);
  });
});

describe('analyzeOrderbookLiquidity', () => {
  it('returns 0 liquidity when orderbook empty', async () => {
    const emptyOrderbook = { asks: [], bids: [] };

    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'buy',
      10,
      vi.fn().mockResolvedValue(emptyOrderbook),
      0.01,
      mockLog
    );

    expect(result.availableLiquidity).toBe(0);
    expect(result.estimatedSlippage).toBe(1.0);
    expect(result.depthAtPrice).toBe(0);
  });

  it('calculates liquidity within slippage threshold', async () => {
    const orderbook = {
      asks: [
        { price: '0.50', size: '20' },  // $10 at best price
        { price: '0.505', size: '40' }, // $20.20 at +1% (within threshold)
        { price: '0.51', size: '100' }, // Beyond 1% threshold
      ],
      bids: [],
    };

    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'buy',
      50,
      vi.fn().mockResolvedValue(orderbook),
      0.01, // 1% max slippage
      mockLog
    );

    // Should include first two levels: 10 + 20.2 = 30.2
    expect(result.availableLiquidity).toBeCloseTo(30.2, 1);
  });

  it('stops at desired size if reached before slippage limit', async () => {
    const orderbook = {
      asks: [
        { price: '0.50', size: '100' }, // $50 at best price
      ],
      bids: [],
    };

    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'buy',
      10, // Only want $10
      vi.fn().mockResolvedValue(orderbook),
      0.01,
      mockLog
    );

    // Should return full 50 since there's plenty of liquidity
    expect(result.availableLiquidity).toBe(50);
    expect(result.estimatedSlippage).toBe(0);
  });

  it('handles bid side for sells', async () => {
    const orderbook = {
      asks: [],
      bids: [
        { price: '0.50', size: '20' },  // $10
        { price: '0.495', size: '40' }, // $19.8 at -1%
        { price: '0.48', size: '100' }, // Beyond threshold
      ],
    };

    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'sell',
      50,
      vi.fn().mockResolvedValue(orderbook),
      0.01,
      mockLog
    );

    // Should include first two levels
    expect(result.availableLiquidity).toBeCloseTo(29.8, 1);
  });

  it('handles getOrderBook error', async () => {
    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'buy',
      10,
      vi.fn().mockRejectedValue(new Error('Network error')),
      0.01,
      mockLog
    );

    expect(result.availableLiquidity).toBe(0);
    expect(result.estimatedSlippage).toBe(1.0);
    expect(result.error).toBe('Network error');
  });

  it('handles null getOrderBook function', async () => {
    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'buy',
      10,
      null,
      0.01,
      mockLog
    );

    expect(result.availableLiquidity).toBe(0);
    expect(result.error).toBe('orderbook_not_available');
  });

  it('calculates slippage correctly', async () => {
    const orderbook = {
      asks: [
        { price: '0.50', size: '5' },   // $2.50
        { price: '0.505', size: '10' }, // Slippage = 1%
      ],
      bids: [],
    };

    const result = await analyzeOrderbookLiquidity(
      'token-id',
      'buy',
      10, // Need more than first level
      vi.fn().mockResolvedValue(orderbook),
      0.02, // 2% max slippage
      mockLog
    );

    // Slippage should be around 1% (from 0.50 to 0.505)
    expect(result.estimatedSlippage).toBeCloseTo(0.01, 2);
  });
});

describe('calculateBaseSize', () => {
  it('returns base size with no confidence adjustment when multiplier is 0', () => {
    const config = { baseSizeDollars: 10, confidenceMultiplier: 0 };
    const signal = { confidence: 0.8 };

    const size = calculateBaseSize(signal, config);

    expect(size).toBe(10);
  });

  it('increases size for high confidence', () => {
    const config = { baseSizeDollars: 10, confidenceMultiplier: 1.0 };
    const signal = { confidence: 1.0 };

    const size = calculateBaseSize(signal, config);

    // 10 * (1 + (1.0 - 0.5) * 1.0) = 10 * 1.5 = 15
    expect(size).toBe(15);
  });

  it('decreases size for low confidence', () => {
    const config = { baseSizeDollars: 10, confidenceMultiplier: 1.0 };
    const signal = { confidence: 0.3 };

    const size = calculateBaseSize(signal, config);

    // 10 * (1 + (0.3 - 0.5) * 1.0) = 10 * 0.8 = 8
    expect(size).toBe(8);
  });

  it('handles missing confidence in signal', () => {
    const config = { baseSizeDollars: 10, confidenceMultiplier: 0.5 };
    const signal = {};

    const size = calculateBaseSize(signal, config);

    expect(size).toBe(10);
  });
});

describe('checkExposureLimits', () => {
  it('allows full size when plenty of headroom', () => {
    const result = checkExposureLimits(100, 50, 500);

    expect(result.canProceed).toBe(true);
    expect(result.adjustedSize).toBe(50);
    expect(result.headroom).toBe(400);
    expect(result.reason).toBeNull();
  });

  it('reduces size to headroom when exceeds limit', () => {
    const result = checkExposureLimits(450, 100, 500);

    expect(result.canProceed).toBe(true);
    expect(result.adjustedSize).toBe(50);
    expect(result.headroom).toBe(50);
    expect(result.reason).toBe(AdjustmentReason.EXPOSURE_CAPPED);
  });

  it('rejects when no headroom available', () => {
    const result = checkExposureLimits(500, 50, 500);

    expect(result.canProceed).toBe(false);
    expect(result.adjustedSize).toBe(0);
    expect(result.headroom).toBe(0);
    expect(result.reason).toBe(AdjustmentReason.REJECTED);
  });

  it('rejects when over exposure limit', () => {
    const result = checkExposureLimits(550, 50, 500);

    expect(result.canProceed).toBe(false);
    expect(result.headroom).toBe(-50);
  });
});
