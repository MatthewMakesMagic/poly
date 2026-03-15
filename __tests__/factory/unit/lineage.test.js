/**
 * Unit tests for Strategy Lineage (Story 4.1)
 *
 * Covers: FR14 (version lineage tracking), FR15 (mutation reasoning capture)
 *
 * What this tests:
 *   - Lineage naming conventions ({base}-m{N})
 *   - generateMutationNames produces sequential names
 *   - nextMutationName finds the right successor
 *   - recordMutation validates mutation types
 *   - Schema creation is idempotent
 *
 * NOTE: DB-dependent tests (recordMutation, getLineage, getChildren) are
 * tested at integration level since they require PostgreSQL.
 * Unit tests cover the naming logic and validation that runs without DB.
 */

import { describe, it, expect } from 'vitest';
import {
  generateMutationNames,
  nextMutationName,
} from '../../../src/factory/lineage.js';

describe('Strategy Lineage — Story 4.1', () => {

  // ─── Naming Convention ───

  describe('naming convention ({base}-m{N})', () => {
    it('generates sequential mutation names from scratch', () => {
      const names = generateMutationNames('edge-c-asymmetry', 3, []);

      expect(names, 'Should generate 3 mutation names').toHaveLength(3);
      expect(names[0], 'First mutation should be -m1').toBe('edge-c-asymmetry-m1');
      expect(names[1], 'Second mutation should be -m2').toBe('edge-c-asymmetry-m2');
      expect(names[2], 'Third mutation should be -m3').toBe('edge-c-asymmetry-m3');
    });

    it('continues numbering from existing children', () => {
      const existing = [
        { strategy_name: 'edge-c-asymmetry-m1' },
        { strategy_name: 'edge-c-asymmetry-m2' },
        { strategy_name: 'edge-c-asymmetry-m3' },
      ];

      const names = generateMutationNames('edge-c-asymmetry', 2, existing);

      expect(names[0], 'Should continue from m4').toBe('edge-c-asymmetry-m4');
      expect(names[1], 'Should continue from m5').toBe('edge-c-asymmetry-m5');
    });

    it('handles string children (just names)', () => {
      const existing = ['my-strat-m1', 'my-strat-m5'];
      const names = generateMutationNames('my-strat', 2, existing);

      expect(names[0], 'Should continue from highest existing (m5) to m6').toBe('my-strat-m6');
      expect(names[1]).toBe('my-strat-m7');
    });

    it('handles empty existing children', () => {
      const name = nextMutationName('deficit-v1', []);
      expect(name, 'First mutation of new base should be -m1').toBe('deficit-v1-m1');
    });

    it('ignores children with different naming patterns', () => {
      const existing = [
        { strategy_name: 'edge-c-asymmetry-v2' }, // version, not mutation
        { strategy_name: 'edge-c-asymmetry-m1' }, // mutation
        { strategy_name: 'totally-different-m5' }, // different base
      ];

      const name = nextMutationName('edge-c-asymmetry', existing);
      expect(name, 'Should only consider -m{N} children of the same base').toBe('edge-c-asymmetry-m2');
    });

    it('handles base names with special regex characters', () => {
      const names = generateMutationNames('my-strat.v1', 2, []);
      expect(names[0]).toBe('my-strat.v1-m1');
      expect(names[1]).toBe('my-strat.v1-m2');
    });
  });

  // ─── Mutation Type Validation ───

  describe('mutation type validation', () => {
    it('recordMutation rejects invalid mutation type', async () => {
      // This test calls recordMutation which will throw on invalid type
      // before even trying the DB
      const { recordMutation } = await import('../../../src/factory/lineage.js');

      await expect(
        recordMutation('parent', 'child', { mutationType: 'invalid-type' }),
        'Should reject invalid mutation type with descriptive error'
      ).rejects.toThrow(/Invalid mutation type.*invalid-type/);
    });

    it('recordMutation rejects missing child name', async () => {
      const { recordMutation } = await import('../../../src/factory/lineage.js');

      await expect(
        recordMutation('parent', '', { mutationType: 'param_perturb' }),
        'Should reject empty child name'
      ).rejects.toThrow(/Child strategy name is required/);
    });

    it('recordMutation rejects null child name', async () => {
      const { recordMutation } = await import('../../../src/factory/lineage.js');

      await expect(
        recordMutation('parent', null, { mutationType: 'param_perturb' }),
        'Should reject null child name'
      ).rejects.toThrow(/Child strategy name is required/);
    });
  });
});
