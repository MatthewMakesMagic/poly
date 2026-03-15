/**
 * Unit tests for Compose Engine (Story 2.6)
 *
 * Covers: FR4 (YAML to runnable strategy), FR5 (signal combination operators),
 *         NFR5 (<100ms), NFR12 (strategy interface contract)
 *
 * What this tests:
 *   - composeFromDefinition produces correct strategy interface
 *   - evaluate() pipeline: signals → combine → filter → size → output
 *   - all-of and any-of combination operators
 *   - onWindowOpen resets stateful blocks
 *   - validateDefinition catches missing/invalid references
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadBlocks, resetRegistry } from '../../../src/factory/registry.js';
import { composeFromDefinition, validateDefinition } from '../../../src/factory/compose.js';
import { composeFromYaml } from '../../../src/factory/compose.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
});

describe('Compose Engine — Story 2.6', () => {

  // ─── Strategy Interface Contract ─────────────────────────────────

  describe('strategy interface contract (NFR12)', () => {
    it('produces object with { name, evaluate, onWindowOpen, defaults, sweepGrid }', () => {
      const strategy = composeFromDefinition({
        name: 'test-strategy',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
        params: {},
      });

      expect(strategy, 'Strategy object must exist').toBeDefined();
      expect(typeof strategy.name, 'name must be a string').toBe('string');
      expect(typeof strategy.evaluate, 'evaluate must be a function').toBe('function');
      expect(typeof strategy.onWindowOpen, 'onWindowOpen must be a function').toBe('function');
      expect(typeof strategy.defaults, 'defaults must be an object').toBe('object');
      expect(typeof strategy.sweepGrid, 'sweepGrid must be an object').toBe('object');
    });

    it('name matches definition name', () => {
      const strategy = composeFromDefinition({
        name: 'my-edge-strategy',
        signals: [{ type: 'chainlink-deficit' }],
        filters: [],
        sizer: { type: 'fixed-capital' },
        combine: 'all-of',
      });

      expect(strategy.name).toBe('my-edge-strategy');
    });
  });

  // ─── Evaluate Pipeline ───────────────────────────────────────────

  describe('evaluate() pipeline', () => {
    it('returns signal when all conditions met (all-of)', () => {
      const strategy = composeFromDefinition({
        name: 'test-all-of',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [
          { type: 'time-window', params: { entryWindowMs: 120000 } },
        ],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 5 } },
        combine: 'all-of',
      });

      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        polyRef: { price: 59950 },
        clobDown: { bestAsk: 0.40 },
        window: { symbol: 'btc', timeToCloseMs: 60000 },
      };

      const signals = strategy.evaluate(state, {});

      expect(signals, 'Should produce exactly one signal').toHaveLength(1);
      expect(signals[0].action, 'Action must be buy').toBe('buy');
      expect(signals[0].token, 'Token must be btc-down').toBe('btc-down');
      expect(signals[0].capitalPerTrade, 'Capital must be 5').toBe(5);
      expect(typeof signals[0].reason, 'Reason must be a string').toBe('string');
      expect(typeof signals[0].confidence, 'Confidence must be a number').toBe('number');
    });

    it('returns empty when signal does not fire', () => {
      const strategy = composeFromDefinition({
        name: 'test-no-signal',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      // Deficit is only 10, below threshold of 80
      const state = {
        chainlink: { price: 59990 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      const signals = strategy.evaluate(state, {});
      expect(signals, 'Should return empty array when signal does not trigger').toHaveLength(0);
    });

    it('returns empty when filter blocks entry', () => {
      const strategy = composeFromDefinition({
        name: 'test-filter-blocks',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [
          { type: 'time-window', params: { entryWindowMs: 120000 } },
        ],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      // Signal fires but time-window filter fails (too far from close)
      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc', timeToCloseMs: 300000 }, // 5 min, exceeds 2 min window
      };

      const signals = strategy.evaluate(state, {});
      expect(signals, 'Should return empty when filter blocks').toHaveLength(0);
    });

    it('max-price filter blocks when ask is too high', () => {
      const strategy = composeFromDefinition({
        name: 'test-max-price',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [
          { type: 'max-price', params: { maxPrice: 0.50, side: 'down' } },
        ],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        clobDown: { bestAsk: 0.60 }, // Above max of 0.50
        window: { symbol: 'btc', timeToCloseMs: 60000 },
      };

      const signals = strategy.evaluate(state, {});
      expect(signals, 'Should return empty when price exceeds max').toHaveLength(0);
    });
  });

  // ─── Combination Operators ───────────────────────────────────────

  describe('signal combination operators', () => {
    it('all-of requires all signals to fire with same direction', () => {
      const strategy = composeFromDefinition({
        name: 'test-all-of-multi',
        signals: [
          { type: 'chainlink-deficit', params: { threshold: 80 } },
          { type: 'ref-near-strike', params: { threshold: 100 } },
        ],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      // Both signals should fire DOWN
      const state = {
        chainlink: { price: 59900 },
        polyRef: { price: 59950 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      const signals = strategy.evaluate(state, {});
      expect(signals, 'Both signals fire → should produce signal').toHaveLength(1);
      expect(signals[0].token).toBe('btc-down');
    });

    it('all-of returns empty if one signal does not fire', () => {
      const strategy = composeFromDefinition({
        name: 'test-all-of-partial',
        signals: [
          { type: 'chainlink-deficit', params: { threshold: 80 } },
          { type: 'ref-near-strike', params: { threshold: 100 } },
        ],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      // CL deficit fires, but ref-near-strike fails (too far)
      const state = {
        chainlink: { price: 59900 },
        polyRef: { price: 60200 }, // 200 away from 60000, exceeds threshold of 100
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      const signals = strategy.evaluate(state, {});
      expect(signals, 'all-of: one signal inactive → no output').toHaveLength(0);
    });

    it('any-of fires when at least one signal fires', () => {
      const strategy = composeFromDefinition({
        name: 'test-any-of',
        signals: [
          { type: 'chainlink-deficit', params: { threshold: 80 } },
          { type: 'ref-near-strike', params: { threshold: 100 } },
        ],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'any-of',
      });

      // Only chainlink deficit fires (ref is too far)
      const state = {
        chainlink: { price: 59900 },
        polyRef: { price: 60200 }, // Too far from strike
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      const signals = strategy.evaluate(state, {});
      expect(signals, 'any-of: one signal fires → should produce output').toHaveLength(1);
      expect(signals[0].token).toBe('btc-down');
    });
  });

  // ─── onWindowOpen Reset ──────────────────────────────────────────

  describe('onWindowOpen resets stateful blocks', () => {
    it('resets once-per-window filter', () => {
      const strategy = composeFromDefinition({
        name: 'test-reset',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [{ type: 'once-per-window' }],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      // First call should produce a signal
      const signals1 = strategy.evaluate(state, {});
      expect(signals1, 'First call should fire').toHaveLength(1);

      // Second call should be blocked by once-per-window
      const signals2 = strategy.evaluate(state, {});
      expect(signals2, 'Second call should be blocked by once-per-window').toHaveLength(0);

      // Reset via onWindowOpen
      strategy.onWindowOpen(state, {});

      // Third call should fire again after reset
      const signals3 = strategy.evaluate(state, {});
      expect(signals3, 'After onWindowOpen, should fire again').toHaveLength(1);
    });
  });

  // ─── validateDefinition ──────────────────────────────────────────

  describe('validateDefinition', () => {
    it('passes for valid definition', () => {
      expect(() => validateDefinition({
        name: 'valid',
        signals: [{ type: 'chainlink-deficit' }],
        sizer: { type: 'fixed-capital' },
      })).not.toThrow();
    });

    it('throws for missing name', () => {
      expect(() => validateDefinition({
        signals: [{ type: 'chainlink-deficit' }],
        sizer: { type: 'fixed-capital' },
      })).toThrow(/name.*required/i);
    });

    it('throws for missing signals', () => {
      expect(() => validateDefinition({
        name: 'no-signals',
        signals: [],
        sizer: { type: 'fixed-capital' },
      })).toThrow(/signals.*required/i);
    });

    it('throws for missing sizer', () => {
      expect(() => validateDefinition({
        name: 'no-sizer',
        signals: [{ type: 'chainlink-deficit' }],
      })).toThrow(/sizer.*required/i);
    });

    it('throws for unknown signal block', () => {
      expect(() => validateDefinition({
        name: 'bad-signal',
        signals: [{ type: 'nonexistent-signal' }],
        sizer: { type: 'fixed-capital' },
      })).toThrow(/not found in registry/);
    });

    it('throws for unknown filter block', () => {
      expect(() => validateDefinition({
        name: 'bad-filter',
        signals: [{ type: 'chainlink-deficit' }],
        filters: [{ type: 'nonexistent-filter' }],
        sizer: { type: 'fixed-capital' },
      })).toThrow(/not found in registry/);
    });

    it('throws for invalid combine operator', () => {
      expect(() => validateDefinition({
        name: 'bad-combine',
        signals: [{ type: 'chainlink-deficit' }],
        sizer: { type: 'fixed-capital' },
        combine: 'weighted',
      })).toThrow(/combine.*all-of.*any-of/i);
    });
  });

  // ─── composeFromYaml ─────────────────────────────────────────────

  describe('composeFromYaml', () => {
    it('composes a strategy from YAML string', async () => {
      const yaml = `
name: yaml-test
signals:
  - type: chainlink-deficit
    params:
      threshold: 80
sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 3
`;
      const strategy = await composeFromYaml(yaml);
      expect(strategy.name).toBe('yaml-test');
      expect(typeof strategy.evaluate).toBe('function');
      expect(typeof strategy.onWindowOpen).toBe('function');
    });

    it('extracts sweep grid from YAML', async () => {
      const yaml = `
name: sweep-test
signals:
  - type: chainlink-deficit
    params:
      threshold:
        sweep: [60, 80, 100]
sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2
`;
      const strategy = await composeFromYaml(yaml);
      expect(strategy.sweepGrid.threshold, 'Sweep grid should contain threshold values').toEqual([60, 80, 100]);
      expect(strategy.defaults.threshold, 'Default should be first sweep value').toBe(60);
    });
  });

  // ─── Sweep / Config Override ──────────────────────────────────────

  describe('sweep params override via config at runtime', () => {
    it('different config.threshold values produce different signal results', () => {
      const strategy = composeFromDefinition({
        name: 'sweep-override-test',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      // Deficit is 100: fires at threshold=80, does NOT fire at threshold=120
      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      const signalsLow = strategy.evaluate(state, { threshold: 80 });
      const signalsHigh = strategy.evaluate(state, { threshold: 120 });

      expect(signalsLow, 'threshold=80 with deficit=100 → should fire').toHaveLength(1);
      expect(signalsHigh, 'threshold=120 with deficit=100 → should NOT fire').toHaveLength(0);
    });

    it('different config.maxPrice values produce different filter results', () => {
      const strategy = composeFromDefinition({
        name: 'sweep-maxprice-test',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [
          { type: 'max-price', params: { maxPrice: 0.65 } },
        ],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      // Signal fires (deficit=100 > threshold=80), ask=0.60
      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        clobDown: { bestAsk: 0.60 },
        window: { symbol: 'btc' },
      };

      const signalsAllow = strategy.evaluate(state, { maxPrice: 0.65 });
      const signalsBlock = strategy.evaluate(state, { maxPrice: 0.50 });

      expect(signalsAllow, 'maxPrice=0.65 with ask=0.60 → should pass').toHaveLength(1);
      expect(signalsBlock, 'maxPrice=0.50 with ask=0.60 → should block').toHaveLength(0);
    });

    it('different config.capitalPerTrade values produce different sizing', () => {
      const strategy = composeFromDefinition({
        name: 'sweep-sizer-test',
        signals: [{ type: 'chainlink-deficit', params: { threshold: 80 } }],
        filters: [],
        sizer: { type: 'fixed-capital', params: { capitalPerTrade: 2 } },
        combine: 'all-of',
      });

      const state = {
        chainlink: { price: 59900 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        window: { symbol: 'btc' },
      };

      const signalsSmall = strategy.evaluate(state, { capitalPerTrade: 2 });
      const signalsLarge = strategy.evaluate(state, { capitalPerTrade: 10 });

      expect(signalsSmall[0].capitalPerTrade).toBe(2);
      expect(signalsLarge[0].capitalPerTrade).toBe(10);
    });
  });

  // ─── Performance ─────────────────────────────────────────────────

  describe('performance (NFR5)', () => {
    it('composeFromYaml completes in <100ms', async () => {
      const yaml = `
name: perf-test
signals:
  - type: chainlink-deficit
    params:
      threshold: 80
  - type: ref-near-strike
    params:
      threshold: 100
filters:
  - type: once-per-window
  - type: time-window
    params:
      entryWindowMs: 120000
  - type: max-price
    params:
      maxPrice: 0.65
sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2
`;
      const start = performance.now();
      await composeFromYaml(yaml);
      const elapsed = performance.now() - start;
      expect(elapsed, `YAML composition took ${elapsed.toFixed(1)}ms, must be <100ms`).toBeLessThan(100);
    });
  });
});
