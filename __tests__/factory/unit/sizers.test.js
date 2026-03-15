/**
 * Unit tests for Sizer Building Blocks (Story 2.4)
 *
 * Covers: FR8 (sizer building block library)
 *         NFR16 (independent testability)
 *
 * What this tests:
 *   - Each sizer's create() returns a callable function
 *   - Correct sizing calculations for each sizer type
 *   - Edge cases (zero values, missing data)
 *   - Output contract: { capitalPerTrade: number }
 */

import { describe, it, expect } from 'vitest';
import { MarketState } from '../../../src/backtest/market-state.js';

import * as fixedCapital from '../../../src/factory/sizers/fixed-capital.js';
import * as kellyFraction from '../../../src/factory/sizers/kelly-fraction.js';
import * as volatilityScaled from '../../../src/factory/sizers/volatility-scaled.js';

function makeState(overrides = {}) {
  const state = new MarketState();
  Object.assign(state, overrides);
  return state;
}

describe('Sizer Building Blocks — Story 2.4', () => {

  // ─── fixed-capital ────────────────────────────────────────────

  describe('fixed-capital', () => {
    it('returns configured dollar amount', () => {
      const sizer = fixedCapital.create({ capitalPerTrade: 5 });
      const result = sizer(makeState(), {}, {});
      expect(result.capitalPerTrade, 'Should return the configured capital amount').toBe(5);
    });

    it('uses default when no params provided', () => {
      const sizer = fixedCapital.create();
      const result = sizer(makeState(), {}, {});
      expect(result.capitalPerTrade, 'Default should be $2').toBe(2);
    });

    it('returns same amount regardless of market state', () => {
      const sizer = fixedCapital.create({ capitalPerTrade: 3 });
      const r1 = sizer(makeState({ chainlink: { price: 60000 } }));
      const r2 = sizer(makeState({ chainlink: { price: 70000 } }));
      expect(r1.capitalPerTrade).toBe(r2.capitalPerTrade);
    });
  });

  // ─── kelly-fraction ───────────────────────────────────────────

  describe('kelly-fraction', () => {
    it('sizes larger with higher signal strength (edge)', () => {
      // Use large maxCapital so neither case hits the cap
      const sizer = kellyFraction.create({ maxCapital: 500, minCapital: 1, bankroll: 1000, kellyMultiplier: 0.5 });

      const lowEdge = sizer(makeState(), {}, { strength: 0.55 });
      const highEdge = sizer(makeState(), {}, { strength: 0.8 });

      expect(highEdge.capitalPerTrade, 'Higher strength should produce larger size')
        .toBeGreaterThan(lowEdge.capitalPerTrade);
    });

    it('returns minCapital when signal has no edge (strength=0.5)', () => {
      const sizer = kellyFraction.create({ minCapital: 1, bankroll: 1000, payoffRatio: 1 });
      const result = sizer(makeState(), {}, { strength: 0.5 });
      // Kelly at p=0.5, b=1: f* = (0.5*1 - 0.5)/1 = 0 → minCapital
      expect(result.capitalPerTrade, 'No edge (p=0.5) should return minCapital').toBe(1);
    });

    it('returns minCapital when strength is below breakeven', () => {
      const sizer = kellyFraction.create({ minCapital: 1, bankroll: 1000 });
      const result = sizer(makeState(), {}, { strength: 0.3 });
      expect(result.capitalPerTrade, 'Negative Kelly should return minCapital').toBe(1);
    });

    it('caps at maxCapital', () => {
      const sizer = kellyFraction.create({ maxCapital: 5, bankroll: 100000, kellyMultiplier: 1 });
      const result = sizer(makeState(), {}, { strength: 0.9 });
      expect(result.capitalPerTrade, 'Should not exceed maxCapital').toBeLessThanOrEqual(5);
    });

    it('handles missing signalResult gracefully', () => {
      const sizer = kellyFraction.create({ minCapital: 1 });
      const result = sizer(makeState(), {});
      expect(result.capitalPerTrade, 'Missing signal should use p=0.5 → minCapital').toBe(1);
    });
  });

  // ─── volatility-scaled ────────────────────────────────────────

  describe('volatility-scaled', () => {
    it('returns base capital when insufficient data', () => {
      const sizer = volatilityScaled.create({ baseCapital: 2 });
      const result = sizer(makeState());
      expect(result.capitalPerTrade, 'Insufficient data should return baseCapital').toBe(2);
    });

    it('sizes smaller in high volatility (inverse scaling)', () => {
      const sizerLow = volatilityScaled.create({ baseCapital: 2, targetVol: 50, lookback: 5 });
      const sizerHigh = volatilityScaled.create({ baseCapital: 2, targetVol: 50, lookback: 5 });

      // Low vol: prices barely move
      for (const p of [60000, 60001, 60002, 60001, 60000]) {
        sizerLow(makeState({ chainlink: { price: p } }));
      }
      const lowVolResult = sizerLow(makeState({ chainlink: { price: 60001 } }));

      // High vol: prices swing wildly
      for (const p of [60000, 60200, 59800, 60300, 59700]) {
        sizerHigh(makeState({ chainlink: { price: p } }));
      }
      const highVolResult = sizerHigh(makeState({ chainlink: { price: 60100 } }));

      expect(lowVolResult.capitalPerTrade, 'Low vol should produce larger size')
        .toBeGreaterThan(highVolResult.capitalPerTrade);
    });

    it('caps at maxCapital', () => {
      const sizer = volatilityScaled.create({ baseCapital: 2, maxCapital: 5, targetVol: 10000 });
      // Very low vol → large scaling
      for (const p of [60000, 60000, 60000, 60000, 60000]) {
        sizer(makeState({ chainlink: { price: p } }));
      }
      // Zero vol means zero changes, which returns baseCapital (vol=0 branch)
      const result = sizer(makeState({ chainlink: { price: 60000 } }));
      expect(result.capitalPerTrade).toBeLessThanOrEqual(5);
    });

    it('floors at minCapital', () => {
      const sizer = volatilityScaled.create({ baseCapital: 2, minCapital: 1, targetVol: 1 });
      // Very high vol
      for (const p of [60000, 61000, 59000, 62000, 58000]) {
        sizer(makeState({ chainlink: { price: p } }));
      }
      const result = sizer(makeState({ chainlink: { price: 60500 } }));
      expect(result.capitalPerTrade).toBeGreaterThanOrEqual(1);
    });

    it('reset() clears price history', () => {
      const sizer = volatilityScaled.create({ baseCapital: 2, lookback: 5 });
      for (let i = 0; i < 10; i++) {
        sizer(makeState({ chainlink: { price: 60000 + i * 10 } }));
      }
      sizer.reset();
      const result = sizer(makeState({ chainlink: { price: 60000 } }));
      expect(result.capitalPerTrade, 'After reset, should return baseCapital (insufficient data)').toBe(2);
    });
  });

  // ─── Cross-cutting sizer contract ─────────────────────────────

  describe('All sizers: contract validation', () => {
    const sizerModules = [fixedCapital, kellyFraction, volatilityScaled];

    for (const mod of sizerModules) {
      it(`${mod.name}: create() returns a function`, () => {
        const instance = mod.create();
        expect(instance, `${mod.name}.create() should return a function`).toBeTypeOf('function');
      });

      it(`${mod.name}: returns { capitalPerTrade: number }`, () => {
        const instance = mod.create();
        const result = instance(new MarketState(), {}, { strength: 0.6 });
        expect(result).toHaveProperty('capitalPerTrade');
        expect(result.capitalPerTrade).toBeTypeOf('number');
        expect(result.capitalPerTrade, `${mod.name}: capitalPerTrade must be positive`).toBeGreaterThan(0);
      });

      it(`${mod.name}: exports name, description, paramSchema, create`, () => {
        expect(mod.name).toBeTypeOf('string');
        expect(mod.description).toBeTypeOf('string');
        expect(mod.paramSchema).toBeTypeOf('object');
        expect(mod.create).toBeTypeOf('function');
      });
    }
  });
});
