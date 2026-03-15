/**
 * Fee Model Tests
 *
 * Validates Polymarket fee calculations match known values
 * at various price points.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateTakerFeeRate,
  calculateTakerFee,
  estimateMakerRebate,
  applyFeeToFill,
  parseFeeMode,
  FeeMode,
} from '../../../src/factory/fee-model.js';

describe('FeeMode enum', () => {
  it('has expected values', () => {
    expect(FeeMode.TAKER_ONLY).toBe('taker');
    expect(FeeMode.MAKER_REBATE).toBe('maker');
    expect(FeeMode.ZERO).toBe('zero');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FeeMode)).toBe(true);
  });
});

describe('calculateTakerFeeRate', () => {
  it('returns max fee at p=0.50 (~1.5625%)', () => {
    const rate = calculateTakerFeeRate(0.50);
    expect(rate).toBeCloseTo(0.015625, 5);
  });

  it('returns lower fee at p=0.90 (~0.20%)', () => {
    const rate = calculateTakerFeeRate(0.90);
    // C * 0.90 * 0.25 * (0.90 * 0.10)^2 = 2.0 * 0.90 * 0.25 * 0.0081 = 0.00365
    expect(rate).toBeLessThan(0.005);
    expect(rate).toBeGreaterThan(0.001);
  });

  it('returns lower fee at p=0.10', () => {
    const rate = calculateTakerFeeRate(0.10);
    // C * 0.10 * 0.25 * (0.10 * 0.90)^2 = 2.0 * 0.10 * 0.25 * 0.0081 = 0.000405
    expect(rate).toBeLessThan(0.001);
    expect(rate).toBeGreaterThan(0);
  });

  it('returns 0 for out-of-range prices', () => {
    expect(calculateTakerFeeRate(0)).toBe(0);
    expect(calculateTakerFeeRate(1)).toBe(0);
    expect(calculateTakerFeeRate(-0.5)).toBe(0);
    expect(calculateTakerFeeRate(1.5)).toBe(0);
  });

  it('fee is symmetric property: higher at mid, lower at extremes', () => {
    const rateMid = calculateTakerFeeRate(0.50);
    const rate30 = calculateTakerFeeRate(0.30);
    const rate70 = calculateTakerFeeRate(0.70);
    const rate10 = calculateTakerFeeRate(0.10);
    const rate90 = calculateTakerFeeRate(0.90);

    // Mid should be highest
    expect(rateMid).toBeGreaterThan(rate30);
    expect(rateMid).toBeGreaterThan(rate70);

    // Extremes should be lowest
    expect(rate10).toBeLessThan(rate30);
    expect(rate90).toBeLessThan(rate70);
  });

  it('fee rate is non-negative for all valid prices', () => {
    for (let p = 0.01; p < 1.0; p += 0.01) {
      expect(calculateTakerFeeRate(p)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('calculateTakerFee', () => {
  it('computes fee in dollars at p=0.50', () => {
    const result = calculateTakerFee(0.50, 100);
    // grossCost = 0.50 * 100 = 50
    // feeRate = 0.015625
    // feeDollars = 50 * 0.015625 = 0.78125
    expect(result.feeDollars).toBeCloseTo(0.78125, 4);
    expect(result.feeRate).toBeCloseTo(0.015625, 5);
    expect(result.netCostPerToken).toBeCloseTo(0.50 * 1.015625, 5);
  });

  it('computes fee for small size', () => {
    const result = calculateTakerFee(0.55, 10);
    expect(result.feeDollars).toBeGreaterThan(0);
    expect(result.feeRate).toBeGreaterThan(0);
  });
});

describe('estimateMakerRebate', () => {
  it('returns positive rebate for valid inputs', () => {
    const result = estimateMakerRebate(0.50, 100, 0.01);
    expect(result.rebateDollars).toBeGreaterThan(0);
    expect(result.feeEquivalent).toBeGreaterThan(0);
    expect(result.rebateRate).toBeGreaterThan(0);
  });

  it('scales with market share estimate', () => {
    const small = estimateMakerRebate(0.50, 100, 0.01);
    const large = estimateMakerRebate(0.50, 100, 0.10);
    expect(large.rebateDollars).toBeGreaterThan(small.rebateDollars);
    expect(large.rebateDollars / small.rebateDollars).toBeCloseTo(10, 1);
  });

  it('returns zero for invalid inputs', () => {
    expect(estimateMakerRebate(0, 100).rebateDollars).toBe(0);
    expect(estimateMakerRebate(0.50, 0).rebateDollars).toBe(0);
    expect(estimateMakerRebate(1, 100).rebateDollars).toBe(0);
  });
});

describe('applyFeeToFill', () => {
  const baseFill = {
    success: true,
    vwapPrice: 0.55,
    totalShares: 100,
    totalCost: 55,
  };

  it('adds taker fee in TAKER_ONLY mode', () => {
    const result = applyFeeToFill(baseFill, FeeMode.TAKER_ONLY);
    expect(result.feeDollars).toBeGreaterThan(0);
    expect(result.netCost).toBeGreaterThan(baseFill.totalCost);
    expect(result.feeMode).toBe(FeeMode.TAKER_ONLY);
  });

  it('applies maker rebate in MAKER_REBATE mode', () => {
    const result = applyFeeToFill(baseFill, FeeMode.MAKER_REBATE);
    expect(result.rebateDollars).toBeGreaterThan(0);
    expect(result.feeDollars).toBe(0);
    expect(result.netCost).toBeLessThan(baseFill.totalCost);
    expect(result.feeMode).toBe(FeeMode.MAKER_REBATE);
  });

  it('applies no fee in ZERO mode', () => {
    const result = applyFeeToFill(baseFill, FeeMode.ZERO);
    expect(result.feeDollars).toBe(0);
    expect(result.rebateDollars).toBe(0);
    expect(result.netCost).toBe(baseFill.totalCost);
    expect(result.feeMode).toBe(FeeMode.ZERO);
  });

  it('passes through failed fills unchanged', () => {
    const failed = { success: false, vwapPrice: null };
    const result = applyFeeToFill(failed, FeeMode.TAKER_ONLY);
    expect(result.success).toBe(false);
  });
});

describe('parseFeeMode', () => {
  it('defaults to TAKER_ONLY for null/undefined', () => {
    expect(parseFeeMode(null)).toBe(FeeMode.TAKER_ONLY);
    expect(parseFeeMode(undefined)).toBe(FeeMode.TAKER_ONLY);
    expect(parseFeeMode('')).toBe(FeeMode.TAKER_ONLY);
  });

  it('parses valid modes case-insensitively', () => {
    expect(parseFeeMode('taker')).toBe(FeeMode.TAKER_ONLY);
    expect(parseFeeMode('TAKER')).toBe(FeeMode.TAKER_ONLY);
    expect(parseFeeMode('maker')).toBe(FeeMode.MAKER_REBATE);
    expect(parseFeeMode('MAKER')).toBe(FeeMode.MAKER_REBATE);
    expect(parseFeeMode('maker_rebate')).toBe(FeeMode.MAKER_REBATE);
    expect(parseFeeMode('zero')).toBe(FeeMode.ZERO);
    expect(parseFeeMode('none')).toBe(FeeMode.ZERO);
  });

  it('defaults to TAKER_ONLY for unknown values', () => {
    expect(parseFeeMode('invalid')).toBe(FeeMode.TAKER_ONLY);
    expect(parseFeeMode('free')).toBe(FeeMode.TAKER_ONLY);
  });
});

describe('fee economics sanity checks', () => {
  it('taker fee at mid-price 0.50 on $100 should be ~$1.56', () => {
    const fee = calculateTakerFee(0.50, 200); // 200 tokens at 0.50 = $100
    // feeRate = 0.015625, grossCost = 100, feeDollars = 1.5625
    expect(fee.feeDollars).toBeCloseTo(1.5625, 3);
  });

  it('taker fee at extreme price 0.95 on $100 should be < $0.15', () => {
    const tokens = 100 / 0.95;
    const fee = calculateTakerFee(0.95, tokens);
    // At p=0.95: rate = 2.0 * 0.95 * 0.25 * (0.95 * 0.05)^2 = 2*0.95*0.25*0.002256 ≈ 0.001072
    // feeDollars = 100 * 0.001072 ≈ 0.107
    expect(fee.feeDollars).toBeLessThan(0.15);
  });

  it('maker rebate is much smaller than taker fee (conservative estimate)', () => {
    const fee = calculateTakerFee(0.50, 100);
    const rebate = estimateMakerRebate(0.50, 100, 0.01);
    // Rebate = fee * 0.20 * 0.01 = a tiny fraction
    expect(rebate.rebateDollars).toBeLessThan(fee.feeDollars);
    expect(rebate.rebateDollars).toBeLessThan(fee.feeDollars * 0.01);
  });
});
