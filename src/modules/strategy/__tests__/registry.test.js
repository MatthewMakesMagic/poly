/**
 * Strategy Registry Tests
 *
 * Tests for the strategy component registry logic:
 * version ID generation, component discovery, strategy registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateVersionId,
  parseVersionId,
  validateComponentInterface,
  registerStrategy,
  getStrategy,
  getComponent,
  listComponents,
  getStrategyComponents,
  listStrategies,
} from '../logic.js';
import { setCatalog, addToCatalog, resetState } from '../state.js';

// Mock the database
vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  get: vi.fn(),
  all: vi.fn(() => []),
}));

import { run, get, all } from '../../../persistence/database.js';

describe('Strategy Component Registry (Story 6.1)', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetState();
  });

  describe('AC2: Version ID Generation', () => {
    it('should generate correct format for probability component', () => {
      const id = generateVersionId('probability', 'spot-lag', 1);
      expect(id).toBe('prob-spot-lag-v1');
    });

    it('should generate correct format for entry component', () => {
      const id = generateVersionId('entry', 'threshold', 2);
      expect(id).toBe('entry-threshold-v2');
    });

    it('should generate correct format for exit component', () => {
      const id = generateVersionId('exit', 'stop-loss', 1);
      expect(id).toBe('exit-stop-loss-v1');
    });

    it('should generate correct format for sizing component', () => {
      const id = generateVersionId('sizing', 'liquidity-aware', 3);
      expect(id).toBe('sizing-liquidity-aware-v3');
    });

    it('should generate unique IDs for different versions', () => {
      const v1 = generateVersionId('entry', 'threshold', 1);
      const v2 = generateVersionId('entry', 'threshold', 2);
      expect(v1).not.toBe(v2);
      expect(v1).toBe('entry-threshold-v1');
      expect(v2).toBe('entry-threshold-v2');
    });

    it('should generate unique IDs for different names', () => {
      const a = generateVersionId('probability', 'spot-lag', 1);
      const b = generateVersionId('probability', 'moving-avg', 1);
      expect(a).not.toBe(b);
    });

    it('should handle kebab-case names correctly', () => {
      const id = generateVersionId('sizing', 'liquidity-aware-dynamic', 1);
      expect(id).toBe('sizing-liquidity-aware-dynamic-v1');
    });

    it('should throw for invalid component type', () => {
      expect(() => generateVersionId('invalid', 'test', 1)).toThrow('Invalid component type');
    });

    it('should handle version as string', () => {
      const id = generateVersionId('probability', 'test', '5');
      expect(id).toBe('prob-test-v5');
    });

    it('should default to version 1 for invalid version', () => {
      const id = generateVersionId('probability', 'test', null);
      expect(id).toBe('prob-test-v1');
    });
  });

  describe('AC2: Version ID Parsing', () => {
    it('should parse probability version ID', () => {
      const parsed = parseVersionId('prob-spot-lag-v1');
      expect(parsed).toEqual({
        type: 'probability',
        name: 'spot-lag',
        version: 1,
        prefix: 'prob',
      });
    });

    it('should parse entry version ID', () => {
      const parsed = parseVersionId('entry-threshold-v2');
      expect(parsed).toEqual({
        type: 'entry',
        name: 'threshold',
        version: 2,
        prefix: 'entry',
      });
    });

    it('should parse exit version ID', () => {
      const parsed = parseVersionId('exit-stop-loss-v3');
      expect(parsed).toEqual({
        type: 'exit',
        name: 'stop-loss',
        version: 3,
        prefix: 'exit',
      });
    });

    it('should parse sizing version ID', () => {
      const parsed = parseVersionId('sizing-fixed-v1');
      expect(parsed).toEqual({
        type: 'sizing',
        name: 'fixed',
        version: 1,
        prefix: 'sizing',
      });
    });

    it('should handle multi-part names', () => {
      const parsed = parseVersionId('prob-spot-lag-momentum-v2');
      expect(parsed).toEqual({
        type: 'probability',
        name: 'spot-lag-momentum',
        version: 2,
        prefix: 'prob',
      });
    });

    it('should return null for invalid format', () => {
      expect(parseVersionId('invalid')).toBeNull();
      expect(parseVersionId('prob-test')).toBeNull();
      expect(parseVersionId('unknown-test-v1')).toBeNull();
      expect(parseVersionId('')).toBeNull();
      expect(parseVersionId(null)).toBeNull();
      expect(parseVersionId(undefined)).toBeNull();
    });
  });

  describe('AC3: Strategy Instances Table', () => {
    it('should register strategy with all component fields', () => {
      const strategyId = registerStrategy({
        name: 'Test Strategy',
        components: {
          probability: 'prob-test-v1',
          entry: 'entry-test-v1',
          exit: 'exit-test-v1',
          sizing: 'sizing-test-v1',
        },
        config: { threshold: 0.5 },
      });

      expect(strategyId).toMatch(/^strat-/);
      expect(run).toHaveBeenCalledTimes(1);

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[1]).toBe('Test Strategy'); // name
      expect(callArgs[2]).toBeNull(); // base_strategy_id
      expect(callArgs[3]).toBe('prob-test-v1'); // probability_component
      expect(callArgs[4]).toBe('entry-test-v1'); // entry_component
      expect(callArgs[5]).toBe('exit-test-v1'); // exit_component
      expect(callArgs[6]).toBe('sizing-test-v1'); // sizing_component
    });

    it('should store base_strategy_id for forks', () => {
      registerStrategy({
        name: 'Forked Strategy',
        components: {
          probability: 'prob-test-v1',
          entry: 'entry-test-v2',
          exit: 'exit-test-v1',
          sizing: 'sizing-test-v1',
        },
        config: {},
        baseStrategyId: 'strat-parent-123',
      });

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[2]).toBe('strat-parent-123'); // base_strategy_id
    });

    it('should store config as JSON', () => {
      registerStrategy({
        name: 'Test',
        components: {
          probability: 'prob-test-v1',
          entry: 'entry-test-v1',
          exit: 'exit-test-v1',
          sizing: 'sizing-test-v1',
        },
        config: { threshold: 0.5, window: 30 },
      });

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[7]).toBe('{"threshold":0.5,"window":30}'); // config JSON
    });

    it('should throw if name is missing', () => {
      expect(() =>
        registerStrategy({
          components: {
            probability: 'prob-test-v1',
            entry: 'entry-test-v1',
            exit: 'exit-test-v1',
            sizing: 'sizing-test-v1',
          },
        })
      ).toThrow('Strategy name is required');
    });

    it('should throw if components are missing', () => {
      expect(() =>
        registerStrategy({
          name: 'Test',
        })
      ).toThrow('Components are required');
    });

    it('should throw if a component type is missing', () => {
      expect(() =>
        registerStrategy({
          name: 'Test',
          components: {
            probability: 'prob-test-v1',
            entry: 'entry-test-v1',
            // missing exit and sizing
          },
        })
      ).toThrow('Component exit is required');
    });
  });

  describe('AC5: Registry Query Operations', () => {
    beforeEach(() => {
      // Set up mock catalog
      setCatalog({
        probability: {
          'prob-test-v1': {
            versionId: 'prob-test-v1',
            name: 'test',
            version: 1,
            type: 'probability',
            createdAt: '2026-01-31',
          },
        },
        entry: {
          'entry-threshold-v1': {
            versionId: 'entry-threshold-v1',
            name: 'threshold',
            version: 1,
            type: 'entry',
            createdAt: '2026-01-31',
          },
        },
        exit: {},
        sizing: {},
      });
    });

    it('should get strategy by ID', () => {
      get.mockReturnValueOnce({
        id: 'strat-123',
        name: 'Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-v1',
        entry_component: 'entry-test-v1',
        exit_component: 'exit-test-v1',
        sizing_component: 'sizing-test-v1',
        config: '{"threshold":0.5}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      const strategy = getStrategy('strat-123');

      expect(strategy).toBeDefined();
      expect(strategy.id).toBe('strat-123');
      expect(strategy.name).toBe('Test Strategy');
      expect(strategy.components.probability).toBe('prob-test-v1');
      expect(strategy.config).toEqual({ threshold: 0.5 });
      expect(strategy.active).toBe(true);
    });

    it('should return null for non-existent strategy', () => {
      get.mockReturnValueOnce(undefined);

      const strategy = getStrategy('non-existent');
      expect(strategy).toBeNull();
    });

    it('should get component from catalog', () => {
      const component = getComponent('prob-test-v1');

      expect(component).toBeDefined();
      expect(component.versionId).toBe('prob-test-v1');
      expect(component.name).toBe('test');
      expect(component.type).toBe('probability');
    });

    it('should return null for non-existent component', () => {
      const component = getComponent('prob-nonexistent-v1');
      expect(component).toBeNull();
    });

    it('should list components by type', () => {
      const probComponents = listComponents('probability');
      expect(probComponents).toHaveLength(1);
      expect(probComponents[0].versionId).toBe('prob-test-v1');

      const entryComponents = listComponents('entry');
      expect(entryComponents).toHaveLength(1);

      const exitComponents = listComponents('exit');
      expect(exitComponents).toHaveLength(0);
    });

    it('should list all components when no type specified', () => {
      const allComponents = listComponents();
      expect(allComponents).toHaveLength(2);
    });

    it('should get strategy components with full details', () => {
      get.mockReturnValueOnce({
        id: 'strat-123',
        name: 'Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-v1',
        entry_component: 'entry-threshold-v1',
        exit_component: 'exit-stop-v1',
        sizing_component: 'sizing-fixed-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      const components = getStrategyComponents('strat-123');

      expect(components).toBeDefined();
      expect(components.probability.versionId).toBe('prob-test-v1');
      expect(components.probability.inCatalog).toBe(true);
      expect(components.entry.versionId).toBe('entry-threshold-v1');
      expect(components.entry.inCatalog).toBe(true);
      expect(components.exit.versionId).toBe('exit-stop-v1');
      expect(components.exit.inCatalog).toBe(false); // Not in mock catalog
    });

    it('should return null for strategy components when strategy not found', () => {
      get.mockReturnValueOnce(undefined);

      const components = getStrategyComponents('non-existent');
      expect(components).toBeNull();
    });
  });

  describe('AC6: Component Discovery', () => {
    it('should validate component interface correctly', () => {
      const validComponent = {
        metadata: { name: 'test', version: 1, type: 'probability' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(validComponent);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject component missing metadata', () => {
      const invalid = {
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing metadata export');
    });

    it('should reject component missing name', () => {
      const invalid = {
        metadata: { version: 1, type: 'probability' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing metadata.name');
    });

    it('should reject component missing version', () => {
      const invalid = {
        metadata: { name: 'test', type: 'probability' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing metadata.version');
    });

    it('should reject component missing type', () => {
      const invalid = {
        metadata: { name: 'test', version: 1 },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing metadata.type');
    });

    it('should reject component with invalid type', () => {
      const invalid = {
        metadata: { name: 'test', version: 1, type: 'invalid' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid metadata.type: invalid');
    });

    it('should reject component missing evaluate function', () => {
      const invalid = {
        metadata: { name: 'test', version: 1, type: 'probability' },
        validateConfig: () => ({ valid: true }),
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing or invalid evaluate function');
    });

    it('should reject component missing validateConfig function', () => {
      const invalid = {
        metadata: { name: 'test', version: 1, type: 'probability' },
        evaluate: () => {},
      };

      const result = validateComponentInterface(invalid);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing or invalid validateConfig function');
    });
  });

  describe('AC4: Version Immutability', () => {
    it('should generate consistent version ID for same inputs', () => {
      const id1 = generateVersionId('probability', 'spot-lag', 1);
      const id2 = generateVersionId('probability', 'spot-lag', 1);
      expect(id1).toBe(id2);
    });

    it('should generate different version ID for incremented version', () => {
      const v1 = generateVersionId('entry', 'threshold', 1);
      const v2 = generateVersionId('entry', 'threshold', 2);
      expect(v1).toBe('entry-threshold-v1');
      expect(v2).toBe('entry-threshold-v2');
      expect(v1).not.toBe(v2);
    });
  });
});
