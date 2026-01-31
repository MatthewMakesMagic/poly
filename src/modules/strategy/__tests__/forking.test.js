/**
 * Strategy Forking Tests (Story 6.3)
 *
 * Tests for strategy forking functionality:
 * forkStrategy, getStrategyLineage, getStrategyForks, diffStrategies, diffFromParent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  forkStrategy,
  diffStrategies,
  diffFromParent,
  deepMerge,
} from '../composer.js';
import {
  getStrategyLineage,
  getStrategyForks,
} from '../logic.js';
import { setCatalog, resetState } from '../state.js';
import { StrategyErrorCodes } from '../types.js';

// Mock the database
vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  get: vi.fn(),
  all: vi.fn(() => []),
}));

import { run, get, all } from '../../../persistence/database.js';

// Mock component modules
const mockProbabilityModule = {
  metadata: { name: 'test-prob', version: 1, type: 'probability' },
  evaluate: vi.fn(() => ({ probability: 0.75, confidence: 0.8 })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

const mockEntryModule = {
  metadata: { name: 'test-entry', version: 1, type: 'entry' },
  evaluate: vi.fn(() => ({ shouldEnter: true, direction: 'long' })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

const mockSizingModule = {
  metadata: { name: 'test-sizing', version: 1, type: 'sizing' },
  evaluate: vi.fn(() => ({ size: 100, adjustedSize: 85 })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

const mockExitModule = {
  metadata: { name: 'test-exit', version: 1, type: 'exit' },
  evaluate: vi.fn(() => ({ shouldExit: false, stopLoss: { price: 0.38 } })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

// Additional entry component for modifications
const mockEntryModuleV2 = {
  metadata: { name: 'test-entry-v2', version: 2, type: 'entry' },
  evaluate: vi.fn(() => ({ shouldEnter: true, direction: 'short' })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

// Helper to set up mock catalog
function setupMockCatalog() {
  setCatalog({
    probability: {
      'prob-test-prob-v1': {
        versionId: 'prob-test-prob-v1',
        name: 'test-prob',
        version: 1,
        type: 'probability',
        module: mockProbabilityModule,
      },
    },
    entry: {
      'entry-test-entry-v1': {
        versionId: 'entry-test-entry-v1',
        name: 'test-entry',
        version: 1,
        type: 'entry',
        module: mockEntryModule,
      },
      'entry-test-entry-v2-v2': {
        versionId: 'entry-test-entry-v2-v2',
        name: 'test-entry-v2',
        version: 2,
        type: 'entry',
        module: mockEntryModuleV2,
      },
    },
    exit: {
      'exit-test-exit-v1': {
        versionId: 'exit-test-exit-v1',
        name: 'test-exit',
        version: 1,
        type: 'exit',
        module: mockExitModule,
      },
    },
    sizing: {
      'sizing-test-sizing-v1': {
        versionId: 'sizing-test-sizing-v1',
        name: 'test-sizing',
        version: 1,
        type: 'sizing',
        module: mockSizingModule,
      },
    },
  });
}

// Mock parent strategy
const parentStrategyId = 'strat-parent-123';
const parentStrategy = {
  id: parentStrategyId,
  name: 'Parent Strategy',
  base_strategy_id: null,
  probability_component: 'prob-test-prob-v1',
  entry_component: 'entry-test-entry-v1',
  exit_component: 'exit-test-exit-v1',
  sizing_component: 'sizing-test-sizing-v1',
  config: JSON.stringify({ threshold: 0.5, param1: 'value1', nested: { a: 1, b: 2 } }),
  created_at: '2026-01-30T08:00:00Z',
  active: 1,
};

describe('Strategy Forking (Story 6.3)', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    setupMockCatalog();
  });

  afterEach(() => {
    resetState();
  });

  describe('deepMerge utility', () => {
    it('should merge flat objects', () => {
      const base = { a: 1, b: 2 };
      const override = { b: 3, c: 4 };
      const result = deepMerge(base, override);

      expect(result).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should deep merge nested objects', () => {
      const base = { nested: { a: 1, b: 2 }, top: 'value' };
      const override = { nested: { b: 3, c: 4 } };
      const result = deepMerge(base, override);

      expect(result).toEqual({
        nested: { a: 1, b: 3, c: 4 },
        top: 'value',
      });
    });

    it('should override arrays rather than merge', () => {
      const base = { arr: [1, 2, 3] };
      const override = { arr: [4, 5] };
      const result = deepMerge(base, override);

      expect(result).toEqual({ arr: [4, 5] });
    });

    it('should handle null override', () => {
      const base = { a: 1 };
      const result = deepMerge(base, null);

      expect(result).toEqual({ a: 1 });
    });

    it('should handle null base', () => {
      const override = { a: 1 };
      const result = deepMerge(null, override);

      expect(result).toEqual({ a: 1 });
    });
  });

  describe('AC1: Fork Strategy Creates New Instance', () => {
    beforeEach(() => {
      get.mockReturnValue(parentStrategy);
    });

    it('should create fork with base_strategy_id pointing to parent', () => {
      const forkId = forkStrategy(parentStrategyId, 'Test Fork', {});

      expect(forkId).toMatch(/^strat-/);
      expect(run).toHaveBeenCalledTimes(1);

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[2]).toBe(parentStrategyId); // base_strategy_id
    });

    it('should create fork with unique ID different from parent', () => {
      const forkId = forkStrategy(parentStrategyId, 'Test Fork', {});

      expect(forkId).not.toBe(parentStrategyId);
    });

    it('should persist fork to strategy_instances table', () => {
      forkStrategy(parentStrategyId, 'Forked Strategy', {});

      expect(run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO strategy_instances'),
        expect.any(Array)
      );

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[1]).toBe('Forked Strategy'); // name
    });
  });

  describe('AC2: Fork with Modified Component', () => {
    beforeEach(() => {
      get.mockReturnValue(parentStrategy);
    });

    it('should use modified component only in fork', () => {
      forkStrategy(parentStrategyId, 'Modified Fork', {
        components: {
          entry: 'entry-test-entry-v2-v2',
        },
      });

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[4]).toBe('entry-test-entry-v2-v2'); // entry_component - modified
      expect(callArgs[3]).toBe('prob-test-prob-v1'); // probability - inherited
      expect(callArgs[5]).toBe('exit-test-exit-v1'); // exit - inherited
      expect(callArgs[6]).toBe('sizing-test-sizing-v1'); // sizing - inherited
    });

    it('should inherit unmodified components from parent', () => {
      forkStrategy(parentStrategyId, 'Partial Mod Fork', {
        components: {
          entry: 'entry-test-entry-v2-v2',
        },
      });

      const callArgs = run.mock.calls[0][1];
      // Only entry was modified, others should be inherited
      expect(callArgs[3]).toBe(parentStrategy.probability_component);
      expect(callArgs[5]).toBe(parentStrategy.exit_component);
      expect(callArgs[6]).toBe(parentStrategy.sizing_component);
    });
  });

  describe('AC3: Fork Inherits Configuration', () => {
    beforeEach(() => {
      get.mockReturnValue(parentStrategy);
    });

    it('should inherit parent config when not modified', () => {
      forkStrategy(parentStrategyId, 'Inherit Fork', {});

      const callArgs = run.mock.calls[0][1];
      const config = JSON.parse(callArgs[7]);

      expect(config.threshold).toBe(0.5);
      expect(config.param1).toBe('value1');
    });

    it('should deep merge config modifications', () => {
      forkStrategy(parentStrategyId, 'Config Fork', {
        config: { threshold: 0.7, param2: 'new' },
      });

      const callArgs = run.mock.calls[0][1];
      const config = JSON.parse(callArgs[7]);

      expect(config.threshold).toBe(0.7); // Overridden
      expect(config.param1).toBe('value1'); // Inherited
      expect(config.param2).toBe('new'); // Added
    });

    it('should deep merge nested config', () => {
      forkStrategy(parentStrategyId, 'Nested Config Fork', {
        config: { nested: { b: 20, c: 30 } },
      });

      const callArgs = run.mock.calls[0][1];
      const config = JSON.parse(callArgs[7]);

      expect(config.nested.a).toBe(1); // Inherited
      expect(config.nested.b).toBe(20); // Overridden
      expect(config.nested.c).toBe(30); // Added
    });
  });

  describe('AC4: Fork Lineage Tracking', () => {
    it('should return correct ancestry chain', () => {
      // Setup chain: grandparent -> parent -> fork
      const grandparent = {
        id: 'strat-grandparent',
        name: 'Grandparent',
        base_strategy_id: null,
        created_at: '2026-01-28T08:00:00Z',
      };
      const parent = {
        id: 'strat-parent',
        name: 'Parent',
        base_strategy_id: 'strat-grandparent',
        created_at: '2026-01-29T08:00:00Z',
      };
      const fork = {
        id: 'strat-fork',
        name: 'Fork',
        base_strategy_id: 'strat-parent',
        created_at: '2026-01-30T08:00:00Z',
      };

      get.mockImplementation((_, params) => {
        const id = params[0];
        if (id === 'strat-fork') return fork;
        if (id === 'strat-parent') return parent;
        if (id === 'strat-grandparent') return grandparent;
        return null;
      });

      const lineage = getStrategyLineage('strat-fork');

      expect(lineage).toHaveLength(3);
      expect(lineage[0].id).toBe('strat-fork');
      expect(lineage[0].depth).toBe(0);
      expect(lineage[1].id).toBe('strat-parent');
      expect(lineage[1].depth).toBe(1);
      expect(lineage[2].id).toBe('strat-grandparent');
      expect(lineage[2].depth).toBe(2);
    });

    it('should return empty array for non-existent strategy', () => {
      get.mockReturnValue(null);

      const lineage = getStrategyLineage('strat-nonexistent');

      expect(lineage).toEqual([]);
    });

    it('should return single-element array for root strategy', () => {
      get.mockReturnValue({
        id: 'strat-root',
        name: 'Root',
        base_strategy_id: null,
        created_at: '2026-01-30T08:00:00Z',
      });

      const lineage = getStrategyLineage('strat-root');

      expect(lineage).toHaveLength(1);
      expect(lineage[0].id).toBe('strat-root');
      expect(lineage[0].depth).toBe(0);
    });

    it('should handle circular references defensively', () => {
      // Setup circular: A -> B -> A
      get.mockImplementation((_, params) => {
        const id = params[0];
        if (id === 'strat-a') return { id: 'strat-a', name: 'A', base_strategy_id: 'strat-b', created_at: '2026-01-30T08:00:00Z' };
        if (id === 'strat-b') return { id: 'strat-b', name: 'B', base_strategy_id: 'strat-a', created_at: '2026-01-29T08:00:00Z' };
        return null;
      });

      const lineage = getStrategyLineage('strat-a');

      // Should stop when circular reference detected
      expect(lineage.length).toBe(2);
      expect(lineage[0].id).toBe('strat-a');
      expect(lineage[1].id).toBe('strat-b');
    });
  });

  describe('AC5: Multiple Forks from Same Parent', () => {
    beforeEach(() => {
      get.mockReturnValue(parentStrategy);
    });

    it('should create independent sibling forks', () => {
      const forkAId = forkStrategy(parentStrategyId, 'Fork A', {});

      vi.clearAllMocks();
      get.mockReturnValue(parentStrategy);

      const forkBId = forkStrategy(parentStrategyId, 'Fork B', {});

      expect(forkAId).not.toBe(forkBId);

      // Both should reference same parent
      const callArgsB = run.mock.calls[0][1];
      expect(callArgsB[2]).toBe(parentStrategyId);
    });

    it('should list all forks of parent', () => {
      all.mockReturnValue([
        { id: 'strat-fork-a', name: 'Fork A', created_at: '2026-01-31T10:00:00Z', active: 1 },
        { id: 'strat-fork-b', name: 'Fork B', created_at: '2026-01-31T11:00:00Z', active: 1 },
        { id: 'strat-fork-c', name: 'Fork C', created_at: '2026-01-31T12:00:00Z', active: 0 },
      ]);

      const forks = getStrategyForks(parentStrategyId);

      expect(forks).toHaveLength(3);
      expect(forks.map(f => f.id)).toContain('strat-fork-a');
      expect(forks.map(f => f.id)).toContain('strat-fork-b');
      expect(forks.map(f => f.id)).toContain('strat-fork-c');
    });

    it('should support activeOnly filter', () => {
      all.mockReturnValue([
        { id: 'strat-fork-a', name: 'Fork A', created_at: '2026-01-31T10:00:00Z', active: 1 },
      ]);

      const forks = getStrategyForks(parentStrategyId, { activeOnly: true });

      expect(all).toHaveBeenCalledWith(
        expect.stringContaining('AND active = 1'),
        expect.any(Array)
      );
    });
  });

  describe('AC6: Diff Between Fork and Parent', () => {
    it('should show component differences', () => {
      const parentData = {
        id: parentStrategyId,
        name: 'Parent',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.5}',
        created_at: '2026-01-30T08:00:00Z',
        active: 1,
      };

      const forkData = {
        id: 'strat-fork-diff',
        name: 'Diff Fork',
        base_strategy_id: parentStrategyId,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v2-v2', // Different
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.5}',
        created_at: '2026-01-31T08:00:00Z',
        active: 1,
      };

      get.mockImplementation((_, params) => {
        if (params[0] === parentStrategyId) return parentData;
        if (params[0] === 'strat-fork-diff') return forkData;
        return null;
      });

      const diff = diffStrategies(parentStrategyId, 'strat-fork-diff');

      expect(diff.components.entry.match).toBe(false);
      expect(diff.components.entry.a).toBe('entry-test-entry-v1');
      expect(diff.components.entry.b).toBe('entry-test-entry-v2-v2');
      expect(diff.components.probability.match).toBe(true);
      expect(diff.components.exit.match).toBe(true);
      expect(diff.components.sizing.match).toBe(true);
    });

    it('should show config differences', () => {
      const parentData = {
        id: parentStrategyId,
        name: 'Parent',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.5,"oldParam":10}',
        created_at: '2026-01-30T08:00:00Z',
        active: 1,
      };

      const forkData = {
        id: 'strat-fork-config',
        name: 'Config Fork',
        base_strategy_id: parentStrategyId,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.7,"newParam":42}',
        created_at: '2026-01-31T08:00:00Z',
        active: 1,
      };

      get.mockImplementation((_, params) => {
        if (params[0] === parentStrategyId) return parentData;
        if (params[0] === 'strat-fork-config') return forkData;
        return null;
      });

      const diff = diffStrategies(parentStrategyId, 'strat-fork-config');

      expect(diff.config.changed.threshold.from).toBe(0.5);
      expect(diff.config.changed.threshold.to).toBe(0.7);
      expect(diff.config.added.newParam).toBe(42);
      expect(diff.config.removed.oldParam).toBe(10);
    });

    it('should detect same base ancestor', () => {
      const root = {
        id: 'strat-root',
        name: 'Root',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-28T08:00:00Z',
        active: 1,
      };

      const forkA = {
        id: 'strat-fork-a',
        name: 'Fork A',
        base_strategy_id: 'strat-root',
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-30T08:00:00Z',
        active: 1,
      };

      const forkB = {
        id: 'strat-fork-b',
        name: 'Fork B',
        base_strategy_id: 'strat-root',
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T08:00:00Z',
        active: 1,
      };

      get.mockImplementation((_, params) => {
        if (params[0] === 'strat-root') return root;
        if (params[0] === 'strat-fork-a') return forkA;
        if (params[0] === 'strat-fork-b') return forkB;
        return null;
      });

      const diff = diffStrategies('strat-fork-a', 'strat-fork-b');

      expect(diff.sameBase).toBe(true);
    });

    it('should use diffFromParent convenience wrapper', () => {
      const parent = {
        id: parentStrategyId,
        name: 'Parent',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.5}',
        created_at: '2026-01-30T08:00:00Z',
        active: 1,
      };

      const fork = {
        id: 'strat-fork',
        name: 'Fork',
        base_strategy_id: parentStrategyId,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v2-v2',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.8}',
        created_at: '2026-01-31T08:00:00Z',
        active: 1,
      };

      get.mockImplementation((_, params) => {
        if (params[0] === parentStrategyId) return parent;
        if (params[0] === 'strat-fork') return fork;
        return null;
      });

      const diff = diffFromParent('strat-fork');

      expect(diff.components.entry.match).toBe(false);
      expect(diff.config.changed.threshold.from).toBe(0.5);
      expect(diff.config.changed.threshold.to).toBe(0.8);
    });

    it('should throw for diffFromParent on non-fork strategy', () => {
      const nonFork = {
        id: 'strat-non-fork',
        name: 'Non Fork',
        base_strategy_id: null, // Not a fork
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-30T08:00:00Z',
        active: 1,
      };

      get.mockReturnValue(nonFork);

      expect(() => diffFromParent('strat-non-fork'))
        .toThrow('has no parent');
    });
  });

  describe('AC7: Fork Validation', () => {
    beforeEach(() => {
      get.mockReturnValue(parentStrategy);
    });

    it('should reject fork with non-existent parent', () => {
      get.mockReturnValue(null);

      expect(() => forkStrategy('non-existent-id', 'Bad Fork', {}))
        .toThrow('Parent strategy non-existent-id not found');
    });

    it('should reject fork of inactive parent', () => {
      get.mockReturnValue({
        ...parentStrategy,
        active: 0,
      });

      expect(() => forkStrategy(parentStrategyId, 'Inactive Fork', {}))
        .toThrow('Cannot fork inactive strategy');
    });

    it('should reject fork with invalid component', () => {
      expect(() => forkStrategy(parentStrategyId, 'Invalid Fork', {
        components: { entry: 'non-existent-component' },
      })).toThrow('not found in catalog');
    });

    it('should reject fork with wrong component type', () => {
      expect(() => forkStrategy(parentStrategyId, 'Wrong Type Fork', {
        components: { entry: 'prob-test-prob-v1' }, // Probability in entry slot
      })).toThrow("type 'probability', expected 'entry'");
    });

    it('should reject fork if config validation fails', () => {
      mockEntryModule.validateConfig.mockReturnValueOnce({
        valid: false,
        errors: ['Invalid config for entry'],
      });

      expect(() => forkStrategy(parentStrategyId, 'Bad Config Fork', {
        config: { badParam: 'invalid' },
      })).toThrow('Config validation failed');
    });
  });

  describe('Integration: Fork → Modify → Execute Flow', () => {
    it('should create fork and maintain parent relationship', () => {
      get.mockReturnValue(parentStrategy);

      // Create fork
      const forkId = forkStrategy(parentStrategyId, 'Integration Fork', {
        components: { entry: 'entry-test-entry-v2-v2' },
        config: { threshold: 0.8 },
      });

      expect(forkId).toMatch(/^strat-/);

      // Verify fork has parent reference
      const callArgs = run.mock.calls[0][1];
      expect(callArgs[2]).toBe(parentStrategyId);

      // Verify modified component
      expect(callArgs[4]).toBe('entry-test-entry-v2-v2');

      // Verify merged config
      const config = JSON.parse(callArgs[7]);
      expect(config.threshold).toBe(0.8); // Overridden
      expect(config.param1).toBe('value1'); // Inherited
      expect(config.nested).toEqual({ a: 1, b: 2 }); // Inherited nested
    });
  });
});
