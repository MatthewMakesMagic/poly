/**
 * Integration tests for Mutation Engine (Epic 4)
 *
 * Covers: FR10-FR15 (mutation + versioning), NFR9 (deterministic reproducibility)
 *
 * What this tests:
 *   - Full pipeline: load YAML -> mutate -> validate -> compose -> evaluate
 *   - Mutated strategies actually work (produce signals from composed output)
 *   - Crossover strategies compose and execute correctly
 *   - Batch mutation produces variants that all compose successfully
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadBlocks } from '../../../src/factory/registry.js';
import { composeFromYaml } from '../../../src/factory/compose.js';
import { perturbParams, structuralMutate, crossover, batchMutate } from '../../../src/factory/mutation.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;

// Load the real edge-c-asymmetry YAML
const EDGE_C_PATH = new URL('../../../src/factory/strategies/edge-c-asymmetry.yaml', import.meta.url).pathname;
const EDGE_C_YAML = readFileSync(EDGE_C_PATH, 'utf8');

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
});

describe('Mutation Pipeline Integration — Epic 4', () => {

  // ─── Perturbed variants compose and evaluate ───

  describe('perturbed variants are fully functional', () => {
    it('perturbed variants compose into working strategies', async () => {
      const { variants } = await perturbParams(EDGE_C_YAML, { count: 5, seed: 42 });

      for (const v of variants) {
        // Each variant should compose without error
        const strategy = await composeFromYaml(v.yamlString);

        expect(strategy.name, `Variant '${v.name}' should compose with correct name`).toBe(v.name);
        expect(typeof strategy.evaluate, `Variant '${v.name}' evaluate must be a function`).toBe('function');
        expect(typeof strategy.onWindowOpen, `Variant '${v.name}' onWindowOpen must be a function`).toBe('function');
      }
    });

    it('perturbed variants produce signals against market state', async () => {
      const { variants } = await perturbParams(EDGE_C_YAML, { count: 3, seed: 42 });

      // State that should trigger the edge-c-asymmetry strategy (large CL deficit)
      const state = {
        chainlink: { price: 59900 },
        polyRef: { price: 59950 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        clobDown: { bestAsk: 0.40 },
        window: { symbol: 'btc', timeToCloseMs: 60000 },
      };

      let signalCount = 0;
      for (const v of variants) {
        const strategy = await composeFromYaml(v.yamlString);
        const signals = strategy.evaluate(state, {});
        // Some variants may not fire (due to different thresholds), but the evaluate function should work
        expect(Array.isArray(signals), `Variant '${v.name}' evaluate() must return an array`).toBe(true);
        if (signals.length > 0) signalCount++;
      }

      // At least some variants should fire on this extreme market state
      expect(signalCount, 'At least some perturbed variants should fire on extreme state').toBeGreaterThan(0);
    });
  });

  // ─── Structural variants compose and evaluate ───

  describe('structural variants are fully functional', () => {
    it('structural variants compose into working strategies', async () => {
      const actions = ['add-signal', 'remove-signal', 'add-filter', 'remove-filter'];

      for (const action of actions) {
        const { variant } = await structuralMutate(EDGE_C_YAML, { action, seed: 42 });
        if (!variant) continue; // Some actions may not be possible

        const strategy = await composeFromYaml(variant.yamlString);
        expect(typeof strategy.evaluate, `Structural variant (${action}) evaluate must be a function`).toBe('function');

        // Evaluate against a basic state
        const signals = strategy.evaluate({
          chainlink: { price: 59900 },
          polyRef: { price: 59950 },
          oraclePriceAtOpen: 60000,
          strike: 60000,
          clobDown: { bestAsk: 0.40 },
          window: { symbol: 'btc', timeToCloseMs: 60000 },
        }, {});

        expect(Array.isArray(signals), 'evaluate() must return an array').toBe(true);
      }
    });
  });

  // ─── Crossover variants compose and evaluate ───

  describe('crossover variants are fully functional', () => {
    it('crossover variant composes and evaluates', async () => {
      const MOMENTUM_YAML = `
name: momentum-simple
signals:
  - type: momentum
    params:
      threshold: 20
filters:
  - type: time-window
    params:
      entryWindowMs: 90000
sizer:
  type: kelly-fraction
  params:
    maxCapital: 10
    minCapital: 1
    kellyMultiplier: 0.5
    bankroll: 1000
`;

      const { variant, error } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
        mode: 'signals-filters',
        seed: 42,
      });

      expect(error, 'Crossover should not produce an error').toBeNull();

      const strategy = await composeFromYaml(variant.yamlString);
      expect(typeof strategy.evaluate).toBe('function');

      // Should be able to evaluate
      const signals = strategy.evaluate({
        chainlink: { price: 59900 },
        polyRef: { price: 59950 },
        oraclePriceAtOpen: 60000,
        strike: 60000,
        clobDown: { bestAsk: 0.40 },
        window: { symbol: 'btc', timeToCloseMs: 60000 },
      }, {});

      expect(Array.isArray(signals)).toBe(true);
    });
  });

  // ─── Batch mutation pipeline ───

  describe('batch mutation full pipeline', () => {
    it('batch of 10 perturbations all compose successfully', async () => {
      const { variants } = await batchMutate(EDGE_C_YAML, {
        count: 10,
        type: 'perturb',
        seed: 42,
      });

      expect(variants.length, 'Should produce 10 variants').toBe(10);

      for (const v of variants) {
        const strategy = await composeFromYaml(v.yamlString);
        expect(strategy.name).toBe(v.name);
        expect(typeof strategy.evaluate).toBe('function');
      }
    });

    it('deterministic: same seed same variants', async () => {
      const r1 = await batchMutate(EDGE_C_YAML, { count: 5, type: 'perturb', seed: 99 });
      const r2 = await batchMutate(EDGE_C_YAML, { count: 5, type: 'perturb', seed: 99 });

      expect(r1.variants.length).toBe(r2.variants.length);
      for (let i = 0; i < r1.variants.length; i++) {
        expect(r1.variants[i].yamlString, `Variant ${i} YAML should be deterministic`).toBe(r2.variants[i].yamlString);
      }
    });
  });
});
