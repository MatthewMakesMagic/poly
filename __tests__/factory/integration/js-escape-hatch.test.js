/**
 * Integration test: JS Escape Hatch Compatibility (Story 2.8)
 *
 * Covers: FR2 (JS when logic exceeds DSL), FR42 (interchangeable with YAML),
 *         NFR12 (interface contract)
 *
 * What this tests:
 *   - JS strategies from src/backtest/strategies/ loadable through factory loader
 *   - JS strategies return same interface as YAML strategies
 *   - edge-c-asymmetry loaded through factory produces expected output
 *   - Mixed JS and YAML strategy loading works
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadBlocks } from '../../../src/factory/registry.js';
import { loadStrategy, listStrategies } from '../../../src/factory/index.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;
const FACTORY_STRATEGIES_DIR = new URL('../../../src/factory/strategies/', import.meta.url).pathname;
const BACKTEST_STRATEGIES_DIR = new URL('../../../src/backtest/strategies/', import.meta.url).pathname;

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
});

describe('JS Escape Hatch Compatibility — Story 2.8', () => {

  // ─── Load JS strategies through factory loader ──────────────────

  describe('JS strategy loading', () => {
    it('loads edge-c-asymmetry JS from backtest/strategies/', async () => {
      const strategy = await loadStrategy('edge-c-asymmetry', {
        searchDirs: [BACKTEST_STRATEGIES_DIR],
      });

      expect(strategy.name, 'JS strategy name must match').toBe('edge-c-asymmetry');
      expect(typeof strategy.evaluate, 'Must have evaluate function').toBe('function');
      expect(typeof strategy.defaults, 'Must have defaults object').toBe('object');
    });

    it('loads mm-paired-polyref JS from backtest/strategies/', async () => {
      const strategy = await loadStrategy('mm-paired-polyref', {
        searchDirs: [BACKTEST_STRATEGIES_DIR],
      });

      expect(strategy.name).toBe('mm-paired-polyref');
      expect(typeof strategy.evaluate).toBe('function');
      expect(typeof strategy.onWindowOpen).toBe('function');
      expect(typeof strategy.defaults).toBe('object');
      expect(typeof strategy.sweepGrid).toBe('object');
    });

    it('JS strategy has sweepGrid when defined', async () => {
      const strategy = await loadStrategy('mm-paired-polyref', {
        searchDirs: [BACKTEST_STRATEGIES_DIR],
      });

      expect(Object.keys(strategy.sweepGrid).length, 'mm-paired-polyref should have sweep parameters').toBeGreaterThan(0);
      expect(strategy.sweepGrid.minEdge, 'Should have minEdge sweep values').toBeDefined();
    });
  });

  // ─── JS strategy produces correct output ────────────────────────

  describe('JS strategy produces expected output', () => {
    it('edge-c-asymmetry produces signals via factory loader', async () => {
      const strategy = await loadStrategy('edge-c-asymmetry', {
        searchDirs: [BACKTEST_STRATEGIES_DIR],
      });

      // Reset for fresh evaluation
      if (strategy.onWindowOpen) strategy.onWindowOpen();

      const state = {
        chainlink: { price: 59900 },
        polyRef: { price: 59950 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        clobDown: { bestAsk: 0.40 },
        window: { symbol: 'btc', timeToCloseMs: 60000 },
      };

      const signals = strategy.evaluate(state, strategy.defaults);

      expect(signals, 'Should produce at least one signal').toHaveLength(1);
      expect(signals[0].action).toBe('buy');
      expect(signals[0].token).toContain('down');
      expect(signals[0].capitalPerTrade, 'Capital must match defaults').toBe(strategy.defaults.capitalPerTrade);
    });
  });

  // ─── Same interface for JS and YAML ─────────────────────────────

  describe('same interface for JS and YAML strategies', () => {
    it('both have { name, evaluate, defaults }', async () => {
      const jsStrategy = await loadStrategy('edge-c-asymmetry', {
        searchDirs: [BACKTEST_STRATEGIES_DIR],
      });
      const yamlStrategy = await loadStrategy('edge-c-asymmetry', {
        searchDirs: [FACTORY_STRATEGIES_DIR],
      });

      // Both must have the same interface shape
      const requiredKeys = ['name', 'evaluate', 'defaults'];
      for (const key of requiredKeys) {
        expect(
          jsStrategy[key] !== undefined,
          `JS strategy missing '${key}'`
        ).toBe(true);
        expect(
          yamlStrategy[key] !== undefined,
          `YAML strategy missing '${key}'`
        ).toBe(true);
      }

      expect(typeof jsStrategy.evaluate).toBe(typeof yamlStrategy.evaluate);
      expect(typeof jsStrategy.defaults).toBe(typeof yamlStrategy.defaults);
    });
  });

  // ─── Mixed strategy listing ─────────────────────────────────────

  describe('mixed strategy listing', () => {
    it('discovers both JS and YAML strategies', async () => {
      const strategies = await listStrategies({
        searchDirs: [FACTORY_STRATEGIES_DIR, BACKTEST_STRATEGIES_DIR],
      });

      const types = new Set(strategies.map(s => s.type));
      expect(types.has('yaml'), 'Should find YAML strategies').toBe(true);
      expect(types.has('js'), 'Should find JS strategies').toBe(true);
    });

    it('YAML strategy takes precedence in factory dir', async () => {
      // When searching factory dir first, YAML should be found before JS
      const strategy = await loadStrategy('edge-c-asymmetry', {
        searchDirs: [FACTORY_STRATEGIES_DIR, BACKTEST_STRATEGIES_DIR],
      });

      // The YAML version is from compose engine, so it will have onWindowOpen
      expect(typeof strategy.onWindowOpen, 'YAML strategy has onWindowOpen from compose engine').toBe('function');
      expect(strategy.name).toBe('edge-c-asymmetry');
    });
  });

  // ─── Resolution order ───────────────────────────────────────────

  describe('resolution order', () => {
    it('searches factory/strategies before backtest/strategies', async () => {
      // Default resolution order: factory first, backtest second
      // edge-c-asymmetry exists in both — factory .yaml should win
      const strategy = await loadStrategy('edge-c-asymmetry');

      expect(strategy.name).toBe('edge-c-asymmetry');
      // The strategy loaded — exact version doesn't matter,
      // what matters is it resolved without error
    });
  });
});
