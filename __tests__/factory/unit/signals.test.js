/**
 * Unit tests for Signal Building Blocks (Story 2.2)
 *
 * Covers: FR6 (signal building block library)
 *         NFR16 (independent testability)
 *
 * What this tests:
 *   - Each signal's create() returns an evaluate function
 *   - Correct directional output given market conditions
 *   - Graceful handling of missing/null data (returns direction: null)
 *   - Signal strength is in [0, 1] range
 *   - Reason strings are informative
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MarketState } from '../../../src/backtest/market-state.js';

// Import signal modules directly for isolated testing
import * as chainlinkDeficit from '../../../src/factory/signals/chainlink-deficit.js';
import * as bsFairValue from '../../../src/factory/signals/bs-fair-value.js';
import * as exchangeConsensus from '../../../src/factory/signals/exchange-consensus.js';
import * as clobImbalance from '../../../src/factory/signals/clob-imbalance.js';
import * as momentum from '../../../src/factory/signals/momentum.js';
import * as meanReversion from '../../../src/factory/signals/mean-reversion.js';

/**
 * Helper: create a MarketState with specified properties set.
 */
function makeState(overrides = {}) {
  const state = new MarketState();
  Object.assign(state, overrides);
  return state;
}

describe('Signal Building Blocks — Story 2.2', () => {

  // ─── chainlink-deficit ─────────────────────────────────────────

  describe('chainlink-deficit', () => {
    it('signals DOWN when chainlink is significantly below strike', () => {
      const signal = chainlinkDeficit.create({ threshold: 80 });
      const state = makeState({
        chainlink: { price: 60000, ts: '2026-01-01T00:00:00Z' },
        oraclePriceAtOpen: 60100,
        strike: 60100,
      });

      const result = signal.evaluate(state);
      expect(result.direction, 'Should signal DOWN when CL deficit exceeds threshold').toBe('DOWN');
      expect(result.strength, 'Strength should be between 0 and 1').toBeGreaterThan(0);
      expect(result.strength).toBeLessThanOrEqual(1);
      expect(result.reason).toContain('chainlink-deficit');
    });

    it('returns null direction when deficit is below threshold', () => {
      const signal = chainlinkDeficit.create({ threshold: 80 });
      const state = makeState({
        chainlink: { price: 60050, ts: '2026-01-01T00:00:00Z' },
        oraclePriceAtOpen: 60100,
        strike: 60100,
      });

      const result = signal.evaluate(state);
      expect(result.direction, 'Should return null when deficit is small').toBeNull();
    });

    it('handles missing chainlink data gracefully', () => {
      const signal = chainlinkDeficit.create();
      const state = makeState({ strike: 60000 });

      const result = signal.evaluate(state);
      expect(result.direction, 'Should return null when chainlink data is missing').toBeNull();
      expect(result.reason).toContain('no chainlink price');
    });

    it('handles missing strike gracefully', () => {
      const signal = chainlinkDeficit.create();
      const state = makeState({ chainlink: { price: 60000 } });

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('no strike');
    });
  });

  // ─── bs-fair-value ─────────────────────────────────────────────

  describe('bs-fair-value', () => {
    it('returns null when insufficient vol data', () => {
      const signal = bsFairValue.create({ minVolSamples: 10 });
      const state = makeState({
        polyRef: { price: 60000 },
        chainlink: { price: 60000 },
        window: { timeToCloseMs: 60000 },
        timestamp: '2026-01-01T00:05:00Z',
        clobUp: { bestAsk: 0.5 },
      });

      const result = signal.evaluate(state);
      expect(result.direction, 'Should return null with insufficient CL history').toBeNull();
      expect(result.reason).toContain('insufficient vol data');
    });

    it('handles missing polyRef gracefully', () => {
      const signal = bsFairValue.create();
      const state = makeState({});

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('no polyRef');
    });

    it('handles missing window data gracefully', () => {
      const signal = bsFairValue.create();
      const state = makeState({ polyRef: { price: 60000 } });

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('no window');
    });

    it('reset() clears internal CL history', () => {
      const signal = bsFairValue.create();
      // Feed some data
      signal.evaluate(makeState({
        polyRef: { price: 60000 },
        chainlink: { price: 60000 },
        window: { timeToCloseMs: 60000 },
        timestamp: '2026-01-01T00:05:00Z',
        clobUp: { bestAsk: 0.5 },
      }));

      signal.reset();

      // After reset, should still need data
      const result = signal.evaluate(makeState({
        polyRef: { price: 60000 },
        window: { timeToCloseMs: 60000 },
        clobUp: { bestAsk: 0.5 },
      }));
      expect(result.direction).toBeNull();
    });
  });

  // ─── exchange-consensus ────────────────────────────────────────

  describe('exchange-consensus', () => {
    it('signals UP when median exchange price is above strike', () => {
      const signal = exchangeConsensus.create({ threshold: 50, minExchanges: 2 });
      const state = new MarketState();
      state.oraclePriceAtOpen = 60000;
      state.strike = 60000;

      // Add exchange data via processEvent
      state.processEvent({ source: 'exchange_binance', price: '60100', timestamp: '2026-01-01T00:00:00Z' });
      state.processEvent({ source: 'exchange_coinbase', price: '60120', timestamp: '2026-01-01T00:00:01Z' });

      const result = signal.evaluate(state);
      expect(result.direction, 'Median above strike should signal UP').toBe('UP');
      expect(result.strength).toBeGreaterThan(0);
    });

    it('signals DOWN when median exchange price is below strike', () => {
      const signal = exchangeConsensus.create({ threshold: 50, minExchanges: 2 });
      const state = new MarketState();
      state.oraclePriceAtOpen = 60000;

      state.processEvent({ source: 'exchange_binance', price: '59900', timestamp: '2026-01-01T00:00:00Z' });
      state.processEvent({ source: 'exchange_coinbase', price: '59920', timestamp: '2026-01-01T00:00:01Z' });

      const result = signal.evaluate(state);
      expect(result.direction, 'Median below strike should signal DOWN').toBe('DOWN');
    });

    it('returns null when too few exchanges', () => {
      const signal = exchangeConsensus.create({ threshold: 50, minExchanges: 3 });
      const state = new MarketState();
      state.oraclePriceAtOpen = 60000;
      state.processEvent({ source: 'exchange_binance', price: '60200', timestamp: '2026-01-01T00:00:00Z' });

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('only 1 exchanges');
    });

    it('handles missing strike gracefully', () => {
      const signal = exchangeConsensus.create();
      const state = new MarketState();

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('no strike reference');
    });
  });

  // ─── clob-imbalance ────────────────────────────────────────────

  describe('clob-imbalance', () => {
    it('signals UP when UP book is bid-heavy', () => {
      const signal = clobImbalance.create({ imbalanceThreshold: 0.3, side: 'up' });
      const state = makeState({
        clobUp: { bidSize: 1000, askSize: 200, bestBid: 0.5, bestAsk: 0.52 },
      });

      const result = signal.evaluate(state);
      expect(result.direction, 'Bid-heavy UP book should signal UP').toBe('UP');
    });

    it('signals DOWN when UP book is ask-heavy', () => {
      const signal = clobImbalance.create({ imbalanceThreshold: 0.3, side: 'up' });
      const state = makeState({
        clobUp: { bidSize: 200, askSize: 1000, bestBid: 0.5, bestAsk: 0.52 },
      });

      const result = signal.evaluate(state);
      expect(result.direction, 'Ask-heavy UP book should signal DOWN').toBe('DOWN');
    });

    it('signals DOWN when DOWN book is bid-heavy', () => {
      const signal = clobImbalance.create({ imbalanceThreshold: 0.3, side: 'down' });
      const state = makeState({
        clobDown: { bidSize: 1000, askSize: 200, bestBid: 0.5, bestAsk: 0.52 },
      });

      const result = signal.evaluate(state);
      expect(result.direction, 'Bid-heavy DOWN book = people buying DOWN = DOWN signal').toBe('DOWN');
    });

    it('returns null when book data is missing', () => {
      const signal = clobImbalance.create();
      const state = makeState({});

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
    });

    it('returns null when imbalance is below threshold', () => {
      const signal = clobImbalance.create({ imbalanceThreshold: 0.5 });
      const state = makeState({
        clobUp: { bidSize: 600, askSize: 400, bestBid: 0.5, bestAsk: 0.52 },
      });

      const result = signal.evaluate(state);
      expect(result.direction).toBeNull();
    });
  });

  // ─── momentum ──────────────────────────────────────────────────

  describe('momentum', () => {
    it('signals UP when price is rising', () => {
      const signal = momentum.create({ threshold: 20 });

      // First call establishes baseline
      signal.evaluate(makeState({ chainlink: { price: 60000 } }));

      // Second call sees price increase
      const result = signal.evaluate(makeState({ chainlink: { price: 60050 } }));
      expect(result.direction, 'Rising price should signal UP').toBe('UP');
    });

    it('signals DOWN when price is falling', () => {
      const signal = momentum.create({ threshold: 20 });

      signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      const result = signal.evaluate(makeState({ chainlink: { price: 59970 } }));
      expect(result.direction, 'Falling price should signal DOWN').toBe('DOWN');
    });

    it('returns null on first tick (establishing baseline)', () => {
      const signal = momentum.create();
      const result = signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('establishing baseline');
    });

    it('returns null when change is below threshold', () => {
      const signal = momentum.create({ threshold: 50 });
      signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      const result = signal.evaluate(makeState({ chainlink: { price: 60010 } }));
      expect(result.direction).toBeNull();
    });

    it('handles missing chainlink gracefully', () => {
      const signal = momentum.create();
      const result = signal.evaluate(makeState({}));
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('no chainlink');
    });

    it('reset() clears baseline', () => {
      const signal = momentum.create({ threshold: 20 });
      signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      signal.reset();

      const result = signal.evaluate(makeState({ chainlink: { price: 60050 } }));
      expect(result.direction, 'After reset, first tick re-establishes baseline').toBeNull();
    });
  });

  // ─── mean-reversion ────────────────────────────────────────────

  describe('mean-reversion', () => {
    it('signals DOWN when price is above rolling mean (expect reversion down)', () => {
      const signal = meanReversion.create({ lookback: 5, deviationThreshold: 10 });

      // Build up buffer: 5 prices around 60000
      for (let i = 0; i < 5; i++) {
        signal.evaluate(makeState({ chainlink: { price: 60000 + i } }));
      }

      // Price spikes above mean
      const result = signal.evaluate(makeState({ chainlink: { price: 60050 } }));
      expect(result.direction, 'Price above mean should signal DOWN (expect reversion)').toBe('DOWN');
    });

    it('signals UP when price is below rolling mean (expect reversion up)', () => {
      const signal = meanReversion.create({ lookback: 5, deviationThreshold: 10 });

      for (let i = 0; i < 5; i++) {
        signal.evaluate(makeState({ chainlink: { price: 60000 + i } }));
      }

      const result = signal.evaluate(makeState({ chainlink: { price: 59950 } }));
      expect(result.direction, 'Price below mean should signal UP (expect reversion)').toBe('UP');
    });

    it('returns null while building buffer', () => {
      const signal = meanReversion.create({ lookback: 10 });
      const result = signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      expect(result.direction).toBeNull();
      expect(result.reason).toContain('building buffer');
    });

    it('handles missing chainlink gracefully', () => {
      const signal = meanReversion.create();
      const result = signal.evaluate(makeState({}));
      expect(result.direction).toBeNull();
    });

    it('reset() clears price buffer', () => {
      const signal = meanReversion.create({ lookback: 3, deviationThreshold: 10 });
      for (let i = 0; i < 3; i++) {
        signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      }
      signal.reset();

      const result = signal.evaluate(makeState({ chainlink: { price: 60000 } }));
      expect(result.reason, 'After reset, buffer should be rebuilding').toContain('building buffer');
    });
  });

  // ─── Cross-cutting signal contract ─────────────────────────────

  describe('All signals: contract validation', () => {
    const signalModules = [
      chainlinkDeficit, bsFairValue, exchangeConsensus,
      clobImbalance, momentum, meanReversion,
    ];

    for (const mod of signalModules) {
      it(`${mod.name}: create() returns object with evaluate function`, () => {
        const instance = mod.create();
        expect(instance.evaluate, `${mod.name}.create() should return { evaluate: Function }`).toBeTypeOf('function');
      });

      it(`${mod.name}: evaluate returns { direction, strength, reason } on empty state`, () => {
        const instance = mod.create();
        const result = instance.evaluate(new MarketState());
        expect(result).toHaveProperty('direction');
        expect(result).toHaveProperty('strength');
        expect(result).toHaveProperty('reason');
        expect(result.reason, `${mod.name}: reason should be a non-empty string`).toBeTruthy();
      });
    }
  });
});
