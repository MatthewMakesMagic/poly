/**
 * Unit tests for Filter Building Blocks (Story 2.3)
 *
 * Covers: FR7 (filter building block library)
 *         NFR16 (independent testability)
 *
 * What this tests:
 *   - Each filter's create() returns a callable function
 *   - Pass/fail conditions for each filter type
 *   - Stateful filters (once-per-window, cooldown) reset correctly
 *   - Graceful handling of missing state data
 */

import { describe, it, expect } from 'vitest';
import { MarketState } from '../../../src/backtest/market-state.js';

import * as timeWindow from '../../../src/factory/filters/time-window.js';
import * as maxPrice from '../../../src/factory/filters/max-price.js';
import * as oncePerWindow from '../../../src/factory/filters/once-per-window.js';
import * as cooldown from '../../../src/factory/filters/cooldown.js';
import * as minData from '../../../src/factory/filters/min-data.js';

function makeState(overrides = {}) {
  const state = new MarketState();
  Object.assign(state, overrides);
  return state;
}

describe('Filter Building Blocks — Story 2.3', () => {

  // ─── time-window ──────────────────────────────────────────────

  describe('time-window', () => {
    it('passes when within entry window (time-to-close <= entryWindowMs)', () => {
      const filter = timeWindow.create({ entryWindowMs: 120000 });
      const state = makeState({ window: { timeToCloseMs: 60000 } });
      expect(filter(state), 'Should pass: 60s remaining < 120s window').toBe(true);
    });

    it('fails when outside entry window (time-to-close > entryWindowMs)', () => {
      const filter = timeWindow.create({ entryWindowMs: 120000 });
      const state = makeState({ window: { timeToCloseMs: 300000 } });
      expect(filter(state), 'Should fail: 300s remaining > 120s window').toBe(false);
    });

    it('passes at exact boundary', () => {
      const filter = timeWindow.create({ entryWindowMs: 120000 });
      const state = makeState({ window: { timeToCloseMs: 120000 } });
      expect(filter(state), 'Should pass at exact boundary').toBe(true);
    });

    it('fails when window data is missing', () => {
      const filter = timeWindow.create();
      const state = makeState({});
      expect(filter(state), 'Should fail with no window data').toBe(false);
    });

    it('fails when timeToCloseMs is null', () => {
      const filter = timeWindow.create();
      const state = makeState({ window: { timeToCloseMs: null } });
      expect(filter(state)).toBe(false);
    });
  });

  // ─── max-price ────────────────────────────────────────────────

  describe('max-price', () => {
    it('passes when ask price is below maxPrice', () => {
      const filter = maxPrice.create({ maxPrice: 0.65, side: 'down' });
      const state = makeState({
        clobDown: { bestAsk: 0.50 },
      });
      expect(filter(state, {}, {}), 'Should pass: ask 0.50 < max 0.65').toBe(true);
    });

    it('fails when ask price exceeds maxPrice', () => {
      const filter = maxPrice.create({ maxPrice: 0.65, side: 'down' });
      const state = makeState({
        clobDown: { bestAsk: 0.70 },
      });
      expect(filter(state, {}, {}), 'Should fail: ask 0.70 > max 0.65').toBe(false);
    });

    it('uses signalResult.direction to pick side when available', () => {
      const filter = maxPrice.create({ maxPrice: 0.65 });
      const state = makeState({
        clobUp: { bestAsk: 0.40 },
        clobDown: { bestAsk: 0.80 },
      });

      expect(filter(state, {}, { direction: 'UP' }), 'Should check UP side: ask 0.40 < 0.65').toBe(true);
      expect(filter(state, {}, { direction: 'DOWN' }), 'Should check DOWN side: ask 0.80 > 0.65').toBe(false);
    });

    it('fails when CLOB data is missing', () => {
      const filter = maxPrice.create({ side: 'up' });
      const state = makeState({});
      expect(filter(state, {}, {})).toBe(false);
    });
  });

  // ─── once-per-window ──────────────────────────────────────────

  describe('once-per-window', () => {
    it('passes on first call, fails on subsequent calls', () => {
      const filter = oncePerWindow.create();

      expect(filter(), 'First call should pass').toBe(true);
      expect(filter(), 'Second call should fail — already fired').toBe(false);
      expect(filter(), 'Third call should also fail').toBe(false);
    });

    it('reset() allows another entry', () => {
      const filter = oncePerWindow.create();

      filter(); // first entry
      expect(filter(), 'Should fail after first entry').toBe(false);

      filter.reset();
      expect(filter(), 'Should pass after reset (new window)').toBe(true);
      expect(filter(), 'Should fail again after second entry').toBe(false);
    });
  });

  // ─── cooldown ─────────────────────────────────────────────────

  describe('cooldown', () => {
    it('passes on first call', () => {
      const filter = cooldown.create({ cooldownMs: 10000 });
      const state = makeState({ timestamp: '2026-01-01T00:00:00Z' });
      expect(filter(state), 'First call should always pass').toBe(true);
    });

    it('fails when called within cooldown period', () => {
      const filter = cooldown.create({ cooldownMs: 10000 });

      filter(makeState({ timestamp: '2026-01-01T00:00:00Z' })); // entry at T+0
      const result = filter(makeState({ timestamp: '2026-01-01T00:00:05Z' })); // T+5s
      expect(result, 'Should fail: 5s < 10s cooldown').toBe(false);
    });

    it('passes after cooldown period has elapsed', () => {
      const filter = cooldown.create({ cooldownMs: 10000 });

      filter(makeState({ timestamp: '2026-01-01T00:00:00Z' }));
      const result = filter(makeState({ timestamp: '2026-01-01T00:00:15Z' })); // T+15s
      expect(result, 'Should pass: 15s > 10s cooldown').toBe(true);
    });

    it('fails when timestamp is missing', () => {
      const filter = cooldown.create();
      const state = makeState({});
      expect(filter(state), 'Should fail with no timestamp').toBe(false);
    });

    it('reset() clears last entry time', () => {
      const filter = cooldown.create({ cooldownMs: 60000 });
      filter(makeState({ timestamp: '2026-01-01T00:00:00Z' }));

      filter.reset();
      const result = filter(makeState({ timestamp: '2026-01-01T00:00:05Z' }));
      expect(result, 'After reset, should pass immediately').toBe(true);
    });
  });

  // ─── min-data ─────────────────────────────────────────────────

  describe('min-data', () => {
    it('passes when tick count meets minimum', () => {
      const filter = minData.create({ minTicks: 50 });
      const state = new MarketState();
      state._tickCount = 100;
      expect(filter(state), 'Should pass: 100 ticks >= 50 min').toBe(true);
    });

    it('fails when tick count is below minimum', () => {
      const filter = minData.create({ minTicks: 50 });
      const state = new MarketState();
      state._tickCount = 10;
      expect(filter(state), 'Should fail: 10 ticks < 50 min').toBe(false);
    });

    it('passes at exact minimum', () => {
      const filter = minData.create({ minTicks: 50 });
      const state = new MarketState();
      state._tickCount = 50;
      expect(filter(state), 'Should pass at exact boundary').toBe(true);
    });

    it('works with fresh MarketState (0 ticks)', () => {
      const filter = minData.create({ minTicks: 1 });
      const state = new MarketState();
      expect(filter(state), 'Fresh state has 0 ticks, should fail with minTicks=1').toBe(false);
    });
  });

  // ─── Cross-cutting filter contract ────────────────────────────

  describe('All filters: contract validation', () => {
    const filterModules = [timeWindow, maxPrice, oncePerWindow, cooldown, minData];

    for (const mod of filterModules) {
      it(`${mod.name}: create() returns a function`, () => {
        const instance = mod.create();
        expect(instance, `${mod.name}.create() should return a function`).toBeTypeOf('function');
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
