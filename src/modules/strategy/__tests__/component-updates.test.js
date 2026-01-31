/**
 * Component Updates Tests (Story 6.4)
 *
 * Tests for central component update functionality including:
 * - Finding strategies using components
 * - Upgrading strategy components
 * - Batch upgrading components
 * - Component version history
 * - Upgrade preview
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getStrategiesUsingComponent,
  getComponentVersionHistory,
  updateStrategyComponent,
  parseVersionId,
} from '../logic.js';
import {
  upgradeStrategyComponent,
  batchUpgradeComponent,
  previewComponentUpgrade,
} from '../composer.js';
import { setCatalog, resetState, addToCatalog } from '../state.js';
import { StrategyErrorCodes } from '../types.js';

// Mock the database
vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  get: vi.fn(),
  all: vi.fn(() => []),
}));

import { run, get, all } from '../../../persistence/database.js';

// Create mock component with validate function
function createMockComponent(type, name, version) {
  return {
    versionId: `${type === 'probability' ? 'prob' : type}-${name}-v${version}`,
    name,
    version,
    type,
    description: `${name} component v${version}`,
    createdAt: new Date().toISOString(),
    module: {
      metadata: { name, version, type },
      evaluate: vi.fn(() => ({ result: 'test' })),
      validateConfig: vi.fn(() => ({ valid: true })),
    },
  };
}

describe('Central Component Updates (Story 6.4)', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();

    // Set up mock catalog with template components v1 and v2
    const probV1 = createMockComponent('probability', 'template', 1);
    const probV2 = createMockComponent('probability', 'template', 2);
    const entryV1 = createMockComponent('entry', 'template', 1);
    const exitV1 = createMockComponent('exit', 'template', 1);
    const sizingV1 = createMockComponent('sizing', 'template', 1);

    setCatalog({
      probability: {
        [probV1.versionId]: probV1,
        [probV2.versionId]: probV2,
      },
      entry: {
        [entryV1.versionId]: entryV1,
      },
      exit: {
        [exitV1.versionId]: exitV1,
      },
      sizing: {
        [sizingV1.versionId]: sizingV1,
      },
    });
  });

  afterEach(() => {
    resetState();
  });

  describe('AC2: List Strategies Using Component', () => {
    it('should return all strategies using the component', () => {
      // Mock database to return strategies using the component
      all.mockReturnValue([
        { id: 'strat-001', name: 'Strategy A', active: 1, component_slot: 'probability' },
        { id: 'strat-002', name: 'Strategy B', active: 1, component_slot: 'probability' },
      ]);

      const strategies = getStrategiesUsingComponent('prob-template-v1');

      expect(strategies.length).toBe(2);
      expect(strategies[0].id).toBe('strat-001');
      expect(strategies[1].id).toBe('strat-002');
    });

    it('should include component slot in results', () => {
      all.mockReturnValue([
        { id: 'strat-001', name: 'Strategy A', active: 1, component_slot: 'probability' },
      ]);

      const strategies = getStrategiesUsingComponent('prob-template-v1');
      expect(strategies[0].componentSlot).toBe('probability');
    });

    it('should filter by activeOnly when specified', () => {
      all.mockReturnValue([
        { id: 'strat-001', name: 'Active Strategy', active: 1, component_slot: 'probability' },
      ]);

      const strategies = getStrategiesUsingComponent('prob-template-v1', { activeOnly: true });
      expect(all).toHaveBeenCalled();
      expect(strategies.every(s => s.active)).toBe(true);
    });

    it('should return empty array for non-existent component', () => {
      all.mockReturnValue([]);
      const strategies = getStrategiesUsingComponent('prob-nonexistent-v99');
      expect(strategies).toEqual([]);
    });

    it('should return empty array for null/undefined versionId', () => {
      const strategies = getStrategiesUsingComponent(null);
      expect(strategies).toEqual([]);
    });
  });

  describe('AC3: Upgrade Strategy Component', () => {
    it('should upgrade single strategy to new version', () => {
      // Mock getting the strategy
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        created_at: '2026-01-31',
        active: 1,
      });
      run.mockReturnValue({ changes: 1 });

      const result = upgradeStrategyComponent('strat-001', 'probability', 'prob-template-v2');

      expect(result.previousVersion).toBe('prob-template-v1');
      expect(result.newVersion).toBe('prob-template-v2');
      expect(result.componentType).toBe('probability');
      expect(run).toHaveBeenCalled();
    });

    it('should reject upgrade for wrong component type', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      expect(() => upgradeStrategyComponent(
        'strat-001',
        'probability',
        'entry-template-v1' // Wrong type - this is an entry component
      )).toThrow();
    });

    it('should reject upgrade for non-existent component', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      expect(() => upgradeStrategyComponent(
        'strat-001',
        'probability',
        'prob-nonexistent-v99'
      )).toThrow();
    });

    it('should reject upgrade for non-existent strategy', () => {
      get.mockReturnValue(null);

      expect(() => upgradeStrategyComponent(
        'strat-nonexistent',
        'probability',
        'prob-template-v2'
      )).toThrow();
    });

    it('should reject upgrade for inactive strategy', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Inactive Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 0, // Inactive
      });

      expect(() => upgradeStrategyComponent(
        'strat-001',
        'probability',
        'prob-template-v2'
      )).toThrow();
    });
  });

  describe('AC4: Batch Upgrade Strategies', () => {
    it('should upgrade all matching strategies', () => {
      // Mock finding strategies
      all.mockReturnValue([
        { id: 'strat-001', name: 'Strategy A', active: 1, component_slot: 'probability' },
        { id: 'strat-002', name: 'Strategy B', active: 1, component_slot: 'probability' },
      ]);

      // Mock get for each strategy
      get.mockImplementation((sql, params) => {
        const id = params[0];
        return {
          id,
          name: `Strategy ${id}`,
          probability_component: 'prob-template-v1',
          entry_component: 'entry-template-v1',
          exit_component: 'exit-template-v1',
          sizing_component: 'sizing-template-v1',
          config: '{}',
          active: 1,
        };
      });

      run.mockReturnValue({ changes: 1 });

      const result = batchUpgradeComponent('prob-template-v1', 'prob-template-v2');

      expect(result.total).toBe(2);
      expect(result.successCount).toBe(2);
      expect(result.failCount).toBe(0);
      expect(result.upgraded.length).toBe(2);
    });

    it('should continue on partial failure', () => {
      all.mockReturnValue([
        { id: 'strat-001', name: 'Strategy A', active: 1, component_slot: 'probability' },
        { id: 'strat-002', name: 'Strategy B', active: 1, component_slot: 'probability' },
      ]);

      // First strategy succeeds, second fails
      let callCount = 0;
      get.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            id: 'strat-001',
            name: 'Strategy A',
            probability_component: 'prob-template-v1',
            entry_component: 'entry-template-v1',
            exit_component: 'exit-template-v1',
            sizing_component: 'sizing-template-v1',
            config: '{}',
            active: 1,
          };
        } else if (callCount === 2) {
          // Return null to simulate strategy not found
          return null;
        }
        // Subsequent calls for upgraded strategy
        return {
          id: 'strat-001',
          name: 'Strategy A',
          probability_component: 'prob-template-v2',
          entry_component: 'entry-template-v1',
          exit_component: 'exit-template-v1',
          sizing_component: 'sizing-template-v1',
          config: '{}',
          active: 1,
        };
      });

      run.mockReturnValue({ changes: 1 });

      const result = batchUpgradeComponent('prob-template-v1', 'prob-template-v2');

      expect(result.successCount).toBe(1);
      expect(result.failCount).toBe(1);
      expect(result.upgraded.length).toBe(1);
      expect(result.failed.length).toBe(1);
    });

    it('should filter by strategyIds option', () => {
      all.mockReturnValue([
        { id: 'strat-001', name: 'Strategy A', active: 1, component_slot: 'probability' },
        { id: 'strat-002', name: 'Strategy B', active: 1, component_slot: 'probability' },
        { id: 'strat-003', name: 'Strategy C', active: 1, component_slot: 'probability' },
      ]);

      get.mockImplementation((sql, params) => {
        const id = params[0];
        return {
          id,
          name: `Strategy ${id}`,
          probability_component: 'prob-template-v1',
          entry_component: 'entry-template-v1',
          exit_component: 'exit-template-v1',
          sizing_component: 'sizing-template-v1',
          config: '{}',
          active: 1,
        };
      });

      run.mockReturnValue({ changes: 1 });

      const result = batchUpgradeComponent('prob-template-v1', 'prob-template-v2', {
        strategyIds: ['strat-001', 'strat-003'],
      });

      expect(result.total).toBe(2);
      expect(result.successCount).toBe(2);
    });

    it('should throw for invalid version ID format', () => {
      expect(() => batchUpgradeComponent(
        'invalid-format',
        'prob-template-v2'
      )).toThrow();
    });
  });

  describe('AC5: Component Version History', () => {
    it('should return versions sorted by version descending', () => {
      const history = getComponentVersionHistory('probability', 'template');

      expect(history.length).toBe(2);
      expect(history[0].version).toBe(2);
      expect(history[1].version).toBe(1);
    });

    it('should include version ID and version number', () => {
      const history = getComponentVersionHistory('probability', 'template');

      history.forEach(entry => {
        expect(entry.versionId).toBeDefined();
        expect(entry.version).toBeDefined();
        expect(typeof entry.version).toBe('number');
      });
    });

    it('should return empty array for non-existent component', () => {
      const history = getComponentVersionHistory('probability', 'nonexistent');
      expect(history).toEqual([]);
    });

    it('should return empty array for invalid type', () => {
      const history = getComponentVersionHistory('invalid', 'template');
      expect(history).toEqual([]);
    });

    it('should return empty array for null/undefined params', () => {
      expect(getComponentVersionHistory(null, 'template')).toEqual([]);
      expect(getComponentVersionHistory('probability', null)).toEqual([]);
    });
  });

  describe('AC6: Preview Component Upgrade', () => {
    it('should return preview without making changes', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      const preview = previewComponentUpgrade('strat-001', 'probability', 'prob-template-v2');

      expect(preview.strategyId).toBe('strat-001');
      expect(preview.componentType).toBe('probability');
      expect(preview.currentVersion).toBe('prob-template-v1');
      expect(preview.newVersion).toBe('prob-template-v2');
      expect(preview.canUpgrade).toBe(true);

      // Verify no database write was attempted
      expect(run).not.toHaveBeenCalled();
    });

    it('should return canUpgrade=false for non-existent component', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      const preview = previewComponentUpgrade('strat-001', 'probability', 'prob-nonexistent-v99');

      expect(preview.canUpgrade).toBe(false);
      expect(preview.validationResult.valid).toBe(false);
    });

    it('should return canUpgrade=false for wrong component type', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      const preview = previewComponentUpgrade('strat-001', 'probability', 'entry-template-v1');

      expect(preview.canUpgrade).toBe(false);
      expect(preview.validationResult.valid).toBe(false);
    });

    it('should throw for non-existent strategy', () => {
      get.mockReturnValue(null);

      expect(() => previewComponentUpgrade(
        'strat-nonexistent',
        'probability',
        'prob-template-v2'
      )).toThrow();
    });

    it('should include component diff in preview', () => {
      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      const preview = previewComponentUpgrade('strat-001', 'probability', 'prob-template-v2');

      expect(preview.componentDiff).toBeDefined();
      expect(preview.componentDiff.name).toBeDefined();
      expect(preview.componentDiff.version).toBeDefined();
      expect(preview.componentDiff.version.current).toBe(1);
      expect(preview.componentDiff.version.new).toBe(2);
    });
  });

  describe('AC7: Upgrade Validation', () => {
    it('should validate config against new component', () => {
      // Add a component that will fail config validation
      const strictComponent = createMockComponent('probability', 'strict', 1);
      strictComponent.module.validateConfig = vi.fn(() => ({
        valid: false,
        errors: ['Missing required field: strictField'],
      }));
      addToCatalog('probability', 'prob-strict-v1', strictComponent);

      get.mockReturnValue({
        id: 'strat-001',
        name: 'Test Strategy',
        probability_component: 'prob-template-v1',
        entry_component: 'entry-template-v1',
        exit_component: 'exit-template-v1',
        sizing_component: 'sizing-template-v1',
        config: '{}',
        active: 1,
      });

      expect(() => upgradeStrategyComponent(
        'strat-001',
        'probability',
        'prob-strict-v1'
      )).toThrow();
    });
  });

  describe('Internal Functions', () => {
    describe('updateStrategyComponent', () => {
      it('should update the correct component column', () => {
        run.mockReturnValue({ changes: 1 });

        const result = updateStrategyComponent('strat-001', 'probability', 'prob-template-v2');

        expect(result).toBe(true);
        expect(run).toHaveBeenCalledWith(
          'UPDATE strategy_instances SET probability_component = ? WHERE id = ?',
          ['prob-template-v2', 'strat-001']
        );
      });

      it('should throw for invalid component type', () => {
        expect(() => updateStrategyComponent(
          'strat-001',
          'invalid',
          'prob-template-v2'
        )).toThrow();
      });
    });

    describe('parseVersionId', () => {
      it('should parse valid probability version ID', () => {
        const parsed = parseVersionId('prob-spot-lag-v1');

        expect(parsed.type).toBe('probability');
        expect(parsed.name).toBe('spot-lag');
        expect(parsed.version).toBe(1);
        expect(parsed.prefix).toBe('prob');
      });

      it('should parse valid entry version ID', () => {
        const parsed = parseVersionId('entry-threshold-v2');

        expect(parsed.type).toBe('entry');
        expect(parsed.name).toBe('threshold');
        expect(parsed.version).toBe(2);
      });

      it('should return null for invalid format', () => {
        expect(parseVersionId('invalid-format')).toBeNull();
        expect(parseVersionId('')).toBeNull();
        expect(parseVersionId(null)).toBeNull();
      });
    });
  });

  describe('Error Codes', () => {
    it('should have COMPONENT_VERSION_EXISTS error code', () => {
      expect(StrategyErrorCodes.COMPONENT_VERSION_EXISTS).toBe('COMPONENT_VERSION_EXISTS');
    });

    it('should have UPGRADE_VALIDATION_FAILED error code', () => {
      expect(StrategyErrorCodes.UPGRADE_VALIDATION_FAILED).toBe('UPGRADE_VALIDATION_FAILED');
    });

    it('should have COMPONENT_UPGRADE_FAILED error code', () => {
      expect(StrategyErrorCodes.COMPONENT_UPGRADE_FAILED).toBe('COMPONENT_UPGRADE_FAILED');
    });
  });
});
