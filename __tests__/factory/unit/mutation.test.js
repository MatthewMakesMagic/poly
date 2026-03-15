/**
 * Unit tests for Mutation Engine (Stories 4.2, 4.3, 4.4, 4.5)
 *
 * Covers: FR10 (param perturbation), FR11 (structural mutation),
 *         FR12 (crossover), FR13 (batch generation), FR14 (lineage), FR15 (reasoning)
 *
 * What this tests:
 *   - Parameter perturbation generates valid variants
 *   - Semantic param bounds are enforced (prices in [0,1], thresholds in [0.2x,5x], integers stay positive)
 *   - Structural mutations add/remove signals and filters correctly
 *   - At least one signal is always preserved
 *   - Crossover combines elements from two strategies
 *   - Batch mutation produces the requested count and types
 *   - All variants pass parser validation
 *   - definitionToYaml round-trips correctly
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadBlocks } from '../../../src/factory/registry.js';
import { parseStrategyYaml } from '../../../src/factory/parser.js';
import {
  perturbParams,
  structuralMutate,
  crossover,
  batchMutate,
  definitionToYaml,
  collectNumericParams,
  getParamBounds,
  clampToBounds,
} from '../../../src/factory/mutation.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;

const EDGE_C_YAML = `
name: edge-c-asymmetry
description: "Exploits structural CL gap"
version: 1
hypothesis: "CL lag creates DOWN edge"

signals:
  - type: chainlink-deficit
    params:
      threshold: 80
  - type: ref-near-strike
    params:
      threshold: 100

combine: all-of

filters:
  - type: once-per-window
  - type: time-window
    params:
      entryWindowMs: 120000
  - type: max-price
    params:
      maxPrice: 0.65
      side: down

sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2
`;

const MOMENTUM_YAML = `
name: momentum-simple
description: "Momentum-based strategy"
version: 1

signals:
  - type: momentum
    params:
      threshold: 20

combine: all-of

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

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
});

// ─── Story 4.2: Parameter Perturbation ───

describe('Parameter Perturbation — Story 4.2', () => {

  describe('perturbParams() basic functionality', () => {
    it('generates the requested number of variants', async () => {
      const { variants, errors } = await perturbParams(EDGE_C_YAML, { count: 5, seed: 42 });

      expect(errors, 'Should not have critical errors').toHaveLength(0);
      expect(variants, 'Should generate 5 variants').toHaveLength(5);
    });

    it('each variant has a unique name following {base}-m{N} convention', async () => {
      const { variants } = await perturbParams(EDGE_C_YAML, { count: 3, seed: 42 });
      const names = variants.map(v => v.name);

      expect(names[0]).toBe('edge-c-asymmetry-m1');
      expect(names[1]).toBe('edge-c-asymmetry-m2');
      expect(names[2]).toBe('edge-c-asymmetry-m3');

      // All unique
      const uniqueNames = new Set(names);
      expect(uniqueNames.size, 'All variant names must be unique').toBe(3);
    });

    it('each variant includes change details', async () => {
      const { variants } = await perturbParams(EDGE_C_YAML, { count: 3, seed: 42 });

      for (const v of variants) {
        expect(v.changes, `Variant '${v.name}' should have at least one parameter change`).toBeTruthy();
        expect(v.changes.length, `Variant '${v.name}' should have at least one change`).toBeGreaterThanOrEqual(1);
        for (const change of v.changes) {
          expect(change.param, 'Change must have a param path').toBeTruthy();
          expect(typeof change.from, 'Change.from must be a number').toBe('number');
          expect(typeof change.to, 'Change.to must be a number').toBe('number');
          expect(change.from, 'Change must actually change the value').not.toBe(change.to);
        }
      }
    });

    it('each variant is valid YAML that passes parser validation', async () => {
      const { variants } = await perturbParams(EDGE_C_YAML, { count: 5, seed: 42 });

      for (const v of variants) {
        expect(() => parseStrategyYaml(v.yamlString),
          `Variant '${v.name}' should produce valid YAML that passes parser`
        ).not.toThrow();
      }
    });

    it('deterministic: same seed produces same variants', async () => {
      const result1 = await perturbParams(EDGE_C_YAML, { count: 3, seed: 123 });
      const result2 = await perturbParams(EDGE_C_YAML, { count: 3, seed: 123 });

      expect(result1.variants.length).toBe(result2.variants.length);
      for (let i = 0; i < result1.variants.length; i++) {
        expect(result1.variants[i].name).toBe(result2.variants[i].name);
        expect(result1.variants[i].changes).toEqual(result2.variants[i].changes);
      }
    });
  });

  // ─── Semantic Param Bounds (CRITICAL) ───

  describe('semantic param bounds (CRITICAL — Cassandra flagged)', () => {

    it('price params stay in [0, 1]', () => {
      const bounds = getParamBounds('maxPrice', 0.65);
      expect(bounds.min, 'Price min bound must be 0').toBe(0);
      expect(bounds.max, 'Price max bound must be 1').toBe(1);

      // Clamping works
      expect(clampToBounds(1.5, bounds), 'Must clamp to 1').toBe(1);
      expect(clampToBounds(-0.1, bounds), 'Must clamp to 0').toBe(0);
      expect(clampToBounds(0.7, bounds), 'Valid value should pass through').toBe(0.7);
    });

    it('threshold params stay in [0.2x, 5x] of original', () => {
      const bounds = getParamBounds('threshold', 80);
      expect(bounds.min, 'Threshold min should be 0.2x original').toBe(16); // 80 * 0.2
      expect(bounds.max, 'Threshold max should be 5x original').toBe(400); // 80 * 5

      expect(clampToBounds(10, bounds), 'Value below 0.2x should be clamped to 0.2x').toBe(16);
      expect(clampToBounds(500, bounds), 'Value above 5x should be clamped to 5x').toBe(400);
    });

    it('integer params stay as positive integers', () => {
      const bounds = getParamBounds('count', 5);
      expect(bounds.isInteger, 'Count should be classified as integer').toBe(true);
      expect(bounds.min, 'Integer min should be 1').toBe(1);

      expect(clampToBounds(2.7, bounds), 'Should round to nearest integer').toBe(3);
      expect(clampToBounds(0.3, bounds), 'Should clamp to at least 1').toBe(1);
      expect(clampToBounds(-1, bounds), 'Negative should clamp to 1').toBe(1);
    });

    it('time params (ms) stay positive', () => {
      const bounds = getParamBounds('entryWindowMs', 120000);
      expect(bounds.min, 'Time params must be positive').toBe(1);
      expect(bounds.isInteger, 'Time params should be integers').toBe(true);

      expect(clampToBounds(-100, bounds), 'Negative time should clamp to 1').toBe(1);
    });

    it('capital params stay positive', () => {
      const bounds = getParamBounds('capitalPerTrade', 2);
      expect(bounds.min, 'Capital params must be positive').toBeGreaterThan(0);

      expect(clampToBounds(-1, bounds), 'Negative capital should clamp to min').toBe(bounds.min);
    });

    it('perturbation never produces nonsense values in generated variants', async () => {
      // Generate many variants to stress-test bounds
      const { variants } = await perturbParams(EDGE_C_YAML, {
        count: 20,
        perturbPct: [0.1, 0.2, 0.5, 0.9], // Include aggressive perturbation
        seed: 42,
      });

      for (const v of variants) {
        const { definition } = parseStrategyYaml(v.yamlString);

        // Check maxPrice is in [0, 1]
        for (const f of definition.filters || []) {
          if (f.type === 'max-price' && f.params?.maxPrice != null) {
            expect(f.params.maxPrice,
              `maxPrice in variant '${v.name}' must be in [0, 1], got ${f.params.maxPrice}`
            ).toBeGreaterThanOrEqual(0);
            expect(f.params.maxPrice,
              `maxPrice in variant '${v.name}' must be in [0, 1], got ${f.params.maxPrice}`
            ).toBeLessThanOrEqual(1);
          }
        }

        // Check thresholds are positive
        for (const sig of definition.signals) {
          if (sig.params?.threshold != null) {
            expect(sig.params.threshold,
              `Signal threshold in variant '${v.name}' must be positive, got ${sig.params.threshold}`
            ).toBeGreaterThan(0);
          }
        }

        // Check time is positive
        for (const f of definition.filters || []) {
          if (f.params?.entryWindowMs != null) {
            expect(f.params.entryWindowMs,
              `entryWindowMs in variant '${v.name}' must be positive, got ${f.params.entryWindowMs}`
            ).toBeGreaterThan(0);
          }
        }

        // Check capital is positive
        if (definition.sizer?.params?.capitalPerTrade != null) {
          expect(definition.sizer.params.capitalPerTrade,
            `capitalPerTrade in variant '${v.name}' must be positive, got ${definition.sizer.params.capitalPerTrade}`
          ).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('collectNumericParams', () => {
    it('finds all numeric params across signals, filters, sizer', () => {
      const { definition } = parseStrategyYaml(EDGE_C_YAML);
      const params = collectNumericParams(definition);

      const paramNames = params.map(p => p.name);
      expect(paramNames, 'Should find signal threshold').toContain('threshold');
      expect(paramNames, 'Should find maxPrice').toContain('maxPrice');
      expect(paramNames, 'Should find entryWindowMs').toContain('entryWindowMs');
      expect(paramNames, 'Should find capitalPerTrade').toContain('capitalPerTrade');

      // Each param has path, name, value
      for (const p of params) {
        expect(typeof p.path).toBe('string');
        expect(typeof p.name).toBe('string');
        expect(typeof p.value).toBe('number');
      }
    });
  });
});

// ─── Story 4.3: Structural Mutations ───

describe('Structural Mutations — Story 4.3', () => {

  it('can add a signal to a strategy', async () => {
    const { variant, error } = await structuralMutate(EDGE_C_YAML, {
      action: 'add-signal',
      seed: 42,
    });

    expect(error, 'Should not produce an error').toBeNull();
    expect(variant, 'Should produce a variant').toBeTruthy();
    expect(variant.definition.signals.length,
      'Should have more signals than original (2)'
    ).toBeGreaterThan(2);
    expect(variant.action).toBe('add-signal');
    expect(variant.reasoning, 'Should have reasoning').toBeTruthy();
  });

  it('can remove a signal (if more than one)', async () => {
    const { variant, error } = await structuralMutate(EDGE_C_YAML, {
      action: 'remove-signal',
      seed: 42,
    });

    expect(error).toBeNull();
    expect(variant.definition.signals.length, 'Should have fewer signals than original (2)').toBe(1);
  });

  it('refuses to remove the last signal', async () => {
    // Strategy with only one signal
    const singleSignalYaml = `
name: single-signal
signals:
  - type: chainlink-deficit
    params:
      threshold: 80
sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2
`;
    const { variant, error } = await structuralMutate(singleSignalYaml, {
      action: 'remove-signal',
      seed: 42,
    });

    expect(variant, 'Should not produce a variant when removing last signal').toBeNull();
    expect(error, 'Should explain why removal failed').toContain('not possible');
  });

  it('can add a filter', async () => {
    const singleFilterYaml = `
name: minimal-strat
signals:
  - type: chainlink-deficit
    params:
      threshold: 80
sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2
`;
    const { variant, error } = await structuralMutate(singleFilterYaml, {
      action: 'add-filter',
      seed: 42,
    });

    expect(error).toBeNull();
    expect(variant.definition.filters.length, 'Should have at least one filter').toBeGreaterThanOrEqual(1);
  });

  it('can remove a filter', async () => {
    const { variant, error } = await structuralMutate(EDGE_C_YAML, {
      action: 'remove-filter',
      seed: 42,
    });

    expect(error).toBeNull();
    expect(variant.definition.filters.length, 'Should have fewer filters than original (3)').toBeLessThan(3);
  });

  it('structural variants pass parser validation', async () => {
    // Try multiple structural mutations
    for (const action of ['add-signal', 'remove-signal', 'add-filter', 'remove-filter']) {
      const { variant } = await structuralMutate(EDGE_C_YAML, { action, seed: 42 });
      if (variant) {
        expect(() => parseStrategyYaml(variant.yamlString),
          `Structural variant (${action}) should pass parser validation`
        ).not.toThrow();
      }
    }
  });

  it('structural variants have unique names', async () => {
    const { variant } = await structuralMutate(EDGE_C_YAML, { seed: 42 });
    expect(variant.name, 'Name should follow {base}-m{N} pattern').toMatch(/edge-c-asymmetry-m\d+/);
  });
});

// ─── Story 4.4: Strategy Crossover ───

describe('Strategy Crossover — Story 4.4', () => {

  it('crosses signals from A with filters from B', async () => {
    const { variant, error } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
      mode: 'signals-filters',
      seed: 42,
    });

    expect(error).toBeNull();
    expect(variant, 'Should produce a crossover variant').toBeTruthy();

    // Signals should come from A (edge-c-asymmetry)
    const signalTypes = variant.definition.signals.map(s => s.type);
    expect(signalTypes, 'Should have chainlink-deficit from A').toContain('chainlink-deficit');
    expect(signalTypes, 'Should have ref-near-strike from A').toContain('ref-near-strike');

    // Filters should come from B (momentum-simple has time-window)
    const filterTypes = variant.definition.filters.map(f => f.type);
    expect(filterTypes, 'Should have time-window from B').toContain('time-window');
  });

  it('crossover produces a valid YAML definition', async () => {
    const { variant } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
      mode: 'signals-filters',
      seed: 42,
    });

    expect(() => parseStrategyYaml(variant.yamlString),
      'Crossover variant should pass parser validation'
    ).not.toThrow();
  });

  it('crossover records both parents', async () => {
    const { variant } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
      mode: 'signals-filters',
      seed: 42,
    });

    expect(variant.parents, 'Should have both parent names').toHaveLength(2);
    expect(variant.parents).toContain('edge-c-asymmetry');
    expect(variant.parents).toContain('momentum-simple');
  });

  it('crossover variant gets a unique name', async () => {
    const { variant } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, { seed: 42 });
    expect(variant.name, 'Crossover name should be non-empty').toBeTruthy();
    expect(variant.name, 'Name should contain both strategy name fragments').toMatch(/edge-c.*momentum|momentum.*edge-c/);
  });

  it('sizer-swap mode swaps the sizer', async () => {
    const { variant, error } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
      mode: 'sizer-swap',
      seed: 42,
    });

    expect(error).toBeNull();
    // A has fixed-capital, B has kelly-fraction
    expect(variant.definition.sizer.type, 'Sizer should come from B').toBe('kelly-fraction');
    // Signals should still come from A
    expect(variant.definition.signals.map(s => s.type)).toContain('chainlink-deficit');
  });

  it('mix mode produces valid variant', async () => {
    const { variant, error } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
      mode: 'mix',
      seed: 42,
    });

    expect(error).toBeNull();
    expect(() => parseStrategyYaml(variant.yamlString)).not.toThrow();
  });

  it('rejects unknown crossover mode', async () => {
    const { variant, error } = await crossover(EDGE_C_YAML, MOMENTUM_YAML, {
      mode: 'nonexistent',
    });

    expect(variant).toBeNull();
    expect(error).toContain('Unknown crossover mode');
  });
});

// ─── Story 4.5: Batch Mutation Generation ───

describe('Batch Mutation Generation — Story 4.5', () => {

  it('batch perturb generates requested count', async () => {
    const { variants, errors } = await batchMutate(EDGE_C_YAML, {
      count: 10,
      type: 'perturb',
      seed: 42,
    });

    expect(errors).toHaveLength(0);
    expect(variants, 'Should generate 10 variants').toHaveLength(10);
  });

  it('batch structural generates variants', async () => {
    const { variants } = await batchMutate(EDGE_C_YAML, {
      count: 3,
      type: 'structural',
      seed: 42,
    });

    expect(variants.length, 'Should generate at least 1 structural variant').toBeGreaterThanOrEqual(1);
  });

  it('batch mixed generates a mix of types', async () => {
    const { variants, summary } = await batchMutate(EDGE_C_YAML, {
      count: 10,
      type: 'mixed',
      seed: 42,
    });

    expect(variants.length, 'Should generate variants').toBeGreaterThan(0);
    expect(summary.length, 'Summary should match variants count').toBe(variants.length);

    // Should have at least perturbation types
    const types = summary.map(s => s.mutationType);
    expect(types, 'Should include param_perturb variants').toContain('param_perturb');
  });

  it('summary table has required fields', async () => {
    const { summary } = await batchMutate(EDGE_C_YAML, {
      count: 5,
      type: 'perturb',
      seed: 42,
    });

    for (const row of summary) {
      expect(row.name, 'Summary row must have name').toBeTruthy();
      expect(row.mutationType, 'Summary row must have mutationType').toBeTruthy();
      expect(typeof row.keyChanges, 'Summary row must have keyChanges string').toBe('string');
    }
  });

  it('all batch variants pass parser validation', async () => {
    const { variants } = await batchMutate(EDGE_C_YAML, {
      count: 10,
      type: 'perturb',
      seed: 42,
    });

    for (const v of variants) {
      expect(() => parseStrategyYaml(v.yamlString),
        `Batch variant '${v.name}' should pass parser validation — mutation engine produced invalid YAML`
      ).not.toThrow();
    }
  });

  it('rejects unknown mutation type', async () => {
    const { errors } = await batchMutate(EDGE_C_YAML, { type: 'bogus' });
    expect(errors.length, 'Should have an error for unknown type').toBeGreaterThan(0);
    expect(errors[0]).toContain('Unknown mutation type');
  });
});

// ─── YAML Round-Trip ───

describe('definitionToYaml round-trip', () => {
  it('round-trips edge-c-asymmetry definition', () => {
    const { definition } = parseStrategyYaml(EDGE_C_YAML);
    const yamlOut = definitionToYaml(definition);

    // Parse the output
    const { definition: roundTripped } = parseStrategyYaml(yamlOut);

    expect(roundTripped.name).toBe(definition.name);
    expect(roundTripped.signals.length).toBe(definition.signals.length);
    expect(roundTripped.filters.length).toBe(definition.filters.length);
    expect(roundTripped.sizer.type).toBe(definition.sizer.type);
  });

  it('preserves numeric parameter values through round-trip', () => {
    const { definition } = parseStrategyYaml(EDGE_C_YAML);
    const yamlOut = definitionToYaml(definition);
    const { definition: rt } = parseStrategyYaml(yamlOut);

    // Check specific values
    expect(rt.signals[0].params.threshold).toBe(80);
    expect(rt.signals[1].params.threshold).toBe(100);
    expect(rt.sizer.params.capitalPerTrade).toBe(2);
  });
});
