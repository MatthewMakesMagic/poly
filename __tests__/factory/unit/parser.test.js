/**
 * Unit tests for YAML Parser with Sweep Syntax (Story 2.5)
 *
 * Covers: FR3 (sweep syntax), FR4 (YAML parsing)
 *         NFR5 (<100ms performance), NFR17 (comprehensive test coverage)
 *
 * What this tests:
 *   - Valid YAML parsing into definition objects
 *   - Sweep syntax extraction into sweepGrid
 *   - Sweep defaults (first value)
 *   - Validation: required fields, unknown keys, type checking
 *   - Error messages include strategy name and all issues
 *   - Edge cases: empty input, malformed YAML, mixed sweep types
 */

import { describe, it, expect } from 'vitest';
import { parseStrategyYaml, validateStrategyYaml } from '../../../src/factory/parser.js';

const VALID_YAML = `
name: test-strategy-v1
description: "A test strategy"
version: 1
hypothesis: "Testing the parser"

signals:
  - type: chainlink-deficit
    params:
      threshold: 80

combine: all-of

filters:
  - type: time-window
    params:
      entryWindowMs: 120000

sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2

params:
  someParam: 42
`;

const SWEEP_YAML = `
name: sweep-test-v1
description: "Test sweep extraction"

signals:
  - type: chainlink-deficit
    params:
      threshold: {sweep: [60, 80, 100, 120]}

filters:
  - type: time-window
    params:
      entryWindowMs: {sweep: [60000, 120000]}

sizer:
  type: fixed-capital
  params:
    capitalPerTrade: 2

params:
  extraParam: {sweep: [1, 2, 3]}
`;

describe('YAML Parser — Story 2.5', () => {

  // ─── Valid parsing ────────────────────────────────────────────

  describe('Valid YAML parsing', () => {
    it('parses a complete strategy definition', () => {
      const { definition, sweepGrid, defaults } = parseStrategyYaml(VALID_YAML);

      expect(definition.name).toBe('test-strategy-v1');
      expect(definition.description).toBe('A test strategy');
      expect(definition.version).toBe(1);
      expect(definition.hypothesis).toBe('Testing the parser');
      expect(definition.signals).toHaveLength(1);
      expect(definition.signals[0].type).toBe('chainlink-deficit');
      expect(definition.filters).toHaveLength(1);
      expect(definition.sizer.type).toBe('fixed-capital');
      expect(definition.combine).toBe('all-of');
    });

    it('defaults combine to all-of when not specified', () => {
      const yaml = `
name: minimal
signals:
  - type: chainlink-deficit
sizer:
  type: fixed-capital
`;
      const { definition } = parseStrategyYaml(yaml);
      expect(definition.combine, 'Default combine should be all-of').toBe('all-of');
    });

    it('defaults filters to empty array when not specified', () => {
      const yaml = `
name: no-filters
signals:
  - type: chainlink-deficit
sizer:
  type: fixed-capital
`;
      const { definition } = parseStrategyYaml(yaml);
      expect(definition.filters).toEqual([]);
    });
  });

  // ─── Sweep extraction ─────────────────────────────────────────

  describe('Sweep syntax extraction', () => {
    it('extracts {sweep: [...]} into sweepGrid', () => {
      const { sweepGrid } = parseStrategyYaml(SWEEP_YAML);

      expect(sweepGrid.threshold, 'Signal param sweep should be extracted').toEqual([60, 80, 100, 120]);
      expect(sweepGrid.entryWindowMs, 'Filter param sweep should be extracted').toEqual([60000, 120000]);
      expect(sweepGrid.extraParam, 'Top-level param sweep should be extracted').toEqual([1, 2, 3]);
    });

    it('sets sweep defaults to first value', () => {
      const { defaults } = parseStrategyYaml(SWEEP_YAML);

      expect(defaults.threshold, 'Default should be first sweep value').toBe(60);
      expect(defaults.entryWindowMs).toBe(60000);
      expect(defaults.extraParam).toBe(1);
    });

    it('replaces sweep syntax with default value in definition', () => {
      const { definition } = parseStrategyYaml(SWEEP_YAML);

      expect(definition.signals[0].params.threshold,
        'Sweep in signal params should be replaced with first value').toBe(60);
    });

    it('preserves non-sweep params as-is', () => {
      const { defaults } = parseStrategyYaml(SWEEP_YAML);
      // capitalPerTrade is not a sweep, should be in defaults
      expect(defaults.capitalPerTrade).toBe(2);
    });
  });

  // ─── Validation errors ────────────────────────────────────────

  describe('Validation errors', () => {
    it('rejects empty input', () => {
      expect(() => parseStrategyYaml('')).toThrow(/non-empty string/);
      expect(() => parseStrategyYaml('   ')).toThrow(/non-empty string/);
    });

    it('rejects non-string input', () => {
      expect(() => parseStrategyYaml(null)).toThrow(/non-empty string/);
      expect(() => parseStrategyYaml(123)).toThrow(/non-empty string/);
    });

    it('rejects malformed YAML', () => {
      expect(() => parseStrategyYaml('{ invalid: yaml: syntax }')).toThrow(/syntax error/);
    });

    it('rejects YAML that parses to a scalar', () => {
      expect(() => parseStrategyYaml('just a string')).toThrow(/YAML mapping/);
    });

    it('rejects missing name', () => {
      const yaml = `
signals:
  - type: chainlink-deficit
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/'name' is required/);
    });

    it('rejects missing signals', () => {
      const yaml = `
name: no-signals
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/'signals' is required/);
    });

    it('rejects empty signals array', () => {
      const yaml = `
name: empty-signals
signals: []
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/'signals' is required.*non-empty/);
    });

    it('rejects missing sizer', () => {
      const yaml = `
name: no-sizer
signals:
  - type: chainlink-deficit
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/'sizer' is required/);
    });

    it('rejects sizer without type', () => {
      const yaml = `
name: bad-sizer
signals:
  - type: chainlink-deficit
sizer:
  params:
    capitalPerTrade: 2
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/'sizer.type' is required/);
    });

    it('rejects unknown top-level keys (typo detection)', () => {
      const yaml = `
name: typo-test
signalz:
  - type: chainlink-deficit
signals:
  - type: chainlink-deficit
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/Unknown top-level key 'signalz'/);
    });

    it('rejects invalid combine operator', () => {
      const yaml = `
name: bad-combine
signals:
  - type: chainlink-deficit
sizer:
  type: fixed-capital
combine: weighted
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/'combine' must be 'all-of' or 'any-of'/);
    });

    it('rejects signal without type', () => {
      const yaml = `
name: bad-signal
signals:
  - params:
      threshold: 80
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/signals\[0\].type is required/);
    });

    it('reports ALL validation errors, not just the first', () => {
      const yaml = `
signalz: oops
filterz: oops
`;
      // Should mention both unknown keys AND missing required fields
      try {
        parseStrategyYaml(yaml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message, 'Error should contain multiple issues').toContain('signalz');
        expect(err.message).toContain("'name' is required");
        expect(err.message).toContain("'signals' is required");
        expect(err.message).toContain("'sizer' is required");
      }
    });

    it('includes strategy name in error message', () => {
      const yaml = `
name: broken-strategy
signals: "not an array"
sizer:
  type: fixed-capital
`;
      try {
        parseStrategyYaml(yaml);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).toContain("'broken-strategy'");
      }
    });
  });

  // ─── Sweep validation ─────────────────────────────────────────

  describe('Sweep validation', () => {
    it('rejects sweep with non-array value', () => {
      const yaml = `
name: bad-sweep
signals:
  - type: chainlink-deficit
    params:
      threshold: {sweep: "not-array"}
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/not an array/);
    });

    it('rejects empty sweep array', () => {
      const yaml = `
name: empty-sweep
signals:
  - type: chainlink-deficit
    params:
      threshold: {sweep: []}
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/empty sweep array/);
    });

    it('rejects mixed-type sweep values', () => {
      const yaml = `
name: mixed-sweep
signals:
  - type: chainlink-deficit
    params:
      threshold: {sweep: [80, "high", 120]}
sizer:
  type: fixed-capital
`;
      expect(() => parseStrategyYaml(yaml)).toThrow(/same type.*mixed types/);
    });

    it('accepts string sweep values', () => {
      const yaml = `
name: string-sweep
signals:
  - type: chainlink-deficit
    params:
      mode: {sweep: ["fast", "slow", "normal"]}
sizer:
  type: fixed-capital
`;
      const { sweepGrid } = parseStrategyYaml(yaml);
      expect(sweepGrid.mode).toEqual(['fast', 'slow', 'normal']);
    });
  });

  // ─── validateStrategyYaml (non-throwing) ──────────────────────

  describe('validateStrategyYaml()', () => {
    it('returns valid=true for valid YAML', () => {
      const result = validateStrategyYaml(VALID_YAML);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.definition).toBeDefined();
    });

    it('returns valid=false with errors for invalid YAML', () => {
      const result = validateStrategyYaml('name: broken');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ─── Performance (NFR5) ───────────────────────────────────────

  describe('Performance', () => {
    it('parses YAML in under 100ms (NFR5)', () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        parseStrategyYaml(SWEEP_YAML);
      }
      const elapsed = performance.now() - start;
      const perParse = elapsed / 100;
      expect(perParse, `Average parse time ${perParse.toFixed(2)}ms should be under 100ms`).toBeLessThan(100);
    });
  });
});
