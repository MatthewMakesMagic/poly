/**
 * Strategy Configuration Tests (Story 6.5)
 *
 * Tests for strategy configuration management:
 * getStrategyConfig, validateStrategyConfig, previewConfigUpdate, updateStrategyConfig
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getStrategyConfig,
  validateStrategyConfig,
  previewConfigUpdate,
  updateStrategyConfig,
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
  evaluate: vi.fn((context, config) => ({
    probability: 0.75,
    confidence: 0.8,
  })),
  validateConfig: vi.fn((config) => {
    // Validate threshold is between 0 and 1
    if (config.threshold !== undefined) {
      if (typeof config.threshold !== 'number' || config.threshold < 0 || config.threshold > 1) {
        return { valid: false, errors: ['threshold must be a number between 0 and 1'] };
      }
    }
    return { valid: true };
  }),
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
  evaluate: vi.fn(() => ({
    shouldExit: false,
    stopLoss: { price: 0.38 },
    takeProfit: { price: 0.55 },
  })),
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

// Test strategy data
const testStrategyId = 'strat-config-test';
const testStrategy = {
  id: testStrategyId,
  name: 'Config Test Strategy',
  base_strategy_id: null,
  probability_component: 'prob-test-prob-v1',
  entry_component: 'entry-test-entry-v1',
  exit_component: 'exit-test-exit-v1',
  sizing_component: 'sizing-test-sizing-v1',
  config: JSON.stringify({
    threshold: 0.5,
    stopLoss: { percent: 0.05, enabled: true },
    takeProfit: { percent: 0.1, enabled: true },
  }),
  created_at: '2026-01-31T00:00:00Z',
  active: 1,
};

describe('Strategy Configuration (Story 6.5)', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    setupMockCatalog();
    get.mockReturnValue(testStrategy);
  });

  afterEach(() => {
    resetState();
  });

  describe('AC1: Config Storage - getStrategyConfig', () => {
    it('should return config from strategy_instances table', () => {
      const config = getStrategyConfig(testStrategyId);

      expect(config).toEqual({
        threshold: 0.5,
        stopLoss: { percent: 0.05, enabled: true },
        takeProfit: { percent: 0.1, enabled: true },
      });
    });

    it('should return null for non-existent strategy', () => {
      get.mockReturnValue(undefined);

      const config = getStrategyConfig('strat-nonexistent');

      expect(config).toBeNull();
    });

    it('should return null for null strategyId', () => {
      const config = getStrategyConfig(null);

      expect(config).toBeNull();
    });

    it('should return empty object for strategy with no config', () => {
      get.mockReturnValue({
        ...testStrategy,
        config: '{}',
      });

      const config = getStrategyConfig(testStrategyId);

      expect(config).toEqual({});
    });
  });

  describe('AC2: Config-Only Update (No Component Change)', () => {
    it('should update config without changing components', () => {
      const result = updateStrategyConfig(testStrategyId, { threshold: 0.6 });

      expect(result.config.threshold).toBe(0.6);
      expect(result.components).toEqual({
        probability: 'prob-test-prob-v1',
        entry: 'entry-test-entry-v1',
        exit: 'exit-test-exit-v1',
        sizing: 'sizing-test-sizing-v1',
      });
    });

    it('should validate against all component validateConfig functions', () => {
      updateStrategyConfig(testStrategyId, { threshold: 0.6 });

      expect(mockProbabilityModule.validateConfig).toHaveBeenCalled();
      expect(mockEntryModule.validateConfig).toHaveBeenCalled();
      expect(mockSizingModule.validateConfig).toHaveBeenCalled();
      expect(mockExitModule.validateConfig).toHaveBeenCalled();
    });

    it('should update database with new config', () => {
      updateStrategyConfig(testStrategyId, { threshold: 0.6 });

      expect(run).toHaveBeenCalledWith(
        'UPDATE strategy_instances SET config = ? WHERE id = ?',
        expect.arrayContaining([expect.any(String), testStrategyId])
      );
    });
  });

  describe('AC3: Config Deep Merge with Defaults', () => {
    it('should deep merge partial config updates by default', () => {
      const result = updateStrategyConfig(testStrategyId, {
        stopLoss: { percent: 0.03 },
      });

      expect(result.config.stopLoss.percent).toBe(0.03);
      expect(result.config.stopLoss.enabled).toBe(true); // Preserved
      expect(result.config.takeProfit).toBeDefined(); // Preserved
      expect(result.config.threshold).toBe(0.5); // Preserved
    });

    it('should deep merge with merge: true option explicitly', () => {
      const result = updateStrategyConfig(
        testStrategyId,
        { stopLoss: { percent: 0.03 } },
        { merge: true }
      );

      expect(result.config.stopLoss.percent).toBe(0.03);
      expect(result.config.stopLoss.enabled).toBe(true); // Preserved
    });

    it('should preserve unspecified keys in nested objects', () => {
      const result = updateStrategyConfig(testStrategyId, {
        takeProfit: { percent: 0.2 },
      });

      expect(result.config.takeProfit.percent).toBe(0.2);
      expect(result.config.takeProfit.enabled).toBe(true); // Preserved
    });
  });

  describe('AC4: Config Replace Mode', () => {
    it('should replace entire config when merge=false', () => {
      const newConfig = { threshold: 0.7 };

      const result = updateStrategyConfig(testStrategyId, newConfig, { merge: false });

      expect(result.config).toEqual(newConfig);
      expect(result.config.stopLoss).toBeUndefined(); // Removed
      expect(result.config.takeProfit).toBeUndefined(); // Removed
    });

    it('should allow removing config keys with replace mode', () => {
      const newConfig = { threshold: 0.7, newKey: 'value' };

      const result = updateStrategyConfig(testStrategyId, newConfig, { merge: false });

      expect(result.config.stopLoss).toBeUndefined();
      expect(result.config.newKey).toBe('value');
    });

    it('should still validate replaced config against components', () => {
      updateStrategyConfig(testStrategyId, { threshold: 0.7 }, { merge: false });

      expect(mockProbabilityModule.validateConfig).toHaveBeenCalled();
    });
  });

  describe('AC5: Config Validation at Load - validateStrategyConfig', () => {
    it('should validate config against all components', () => {
      const result = validateStrategyConfig(testStrategyId);

      expect(result.valid).toBe(true);
      expect(result.componentResults.probability.valid).toBe(true);
      expect(result.componentResults.entry.valid).toBe(true);
      expect(result.componentResults.exit.valid).toBe(true);
      expect(result.componentResults.sizing.valid).toBe(true);
    });

    it('should detect invalid config (fail-fast)', () => {
      get.mockReturnValue({
        ...testStrategy,
        config: JSON.stringify({ threshold: 2.0 }), // Invalid threshold
      });

      const result = validateStrategyConfig(testStrategyId);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('threshold must be a number between 0 and 1'))).toBe(true);
    });

    it('should return detailed validation errors', () => {
      get.mockReturnValue({
        ...testStrategy,
        config: JSON.stringify({ threshold: 2.0 }),
      });

      const result = validateStrategyConfig(testStrategyId);

      expect(result.componentResults.probability.valid).toBe(false);
      expect(result.componentResults.probability.errors).toContain(
        'threshold must be a number between 0 and 1'
      );
    });

    it('should handle non-existent strategy', () => {
      get.mockReturnValue(undefined);

      const result = validateStrategyConfig('strat-nonexistent');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Strategy strat-nonexistent not found');
    });

    it('should detect missing component in catalog', () => {
      get.mockReturnValue({
        ...testStrategy,
        probability_component: 'prob-missing-v1',
      });

      const result = validateStrategyConfig(testStrategyId);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('prob-missing-v1'))).toBe(true);
    });
  });

  describe('AC6: Config Hot-Reload', () => {
    it('should update config and take effect immediately (no restart)', () => {
      // First update
      updateStrategyConfig(testStrategyId, { threshold: 0.6 });

      // Verify database was updated
      expect(run).toHaveBeenCalledWith(
        'UPDATE strategy_instances SET config = ? WHERE id = ?',
        expect.any(Array)
      );

      // The update is persisted - next execution will use new config
      const updateCall = run.mock.calls[0][1];
      const persistedConfig = JSON.parse(updateCall[0]);
      expect(persistedConfig.threshold).toBe(0.6);
    });

    it('should return updated strategy immediately', () => {
      const result = updateStrategyConfig(testStrategyId, { threshold: 0.8 });

      expect(result.config.threshold).toBe(0.8);
    });
  });

  describe('AC7: Config Diff Preview - previewConfigUpdate', () => {
    it('should return preview without making changes', () => {
      const preview = previewConfigUpdate(testStrategyId, { threshold: 0.8 });

      expect(preview.canUpdate).toBe(true);
      expect(preview.diff.changed.threshold).toBeDefined();
      expect(preview.diff.changed.threshold.from).toBe(0.5);
      expect(preview.diff.changed.threshold.to).toBe(0.8);

      // Verify no database update was made
      expect(run).not.toHaveBeenCalled();
    });

    it('should not persist changes during preview', () => {
      previewConfigUpdate(testStrategyId, { threshold: 0.9 });

      expect(run).not.toHaveBeenCalled();
    });

    it('should include validation result in preview', () => {
      const preview = previewConfigUpdate(testStrategyId, { threshold: 0.6 });

      expect(preview.validationResult.valid).toBe(true);
      expect(preview.validationResult.componentResults.probability.valid).toBe(true);
    });

    it('should show canUpdate=false for invalid config', () => {
      const preview = previewConfigUpdate(testStrategyId, { threshold: 2.0 });

      expect(preview.canUpdate).toBe(false);
      expect(preview.validationResult.valid).toBe(false);
    });

    it('should include current and proposed config in preview', () => {
      const preview = previewConfigUpdate(testStrategyId, { newKey: 'value' });

      expect(preview.currentConfig.threshold).toBe(0.5);
      expect(preview.proposedConfig.newKey).toBe('value');
      expect(preview.proposedConfig.threshold).toBe(0.5); // Merged
    });

    it('should show added keys in diff', () => {
      const preview = previewConfigUpdate(testStrategyId, { newKey: 'value' });

      expect(preview.diff.added.newKey).toBe('value');
    });

    it('should show removed keys in diff for replace mode', () => {
      const preview = previewConfigUpdate(
        testStrategyId,
        { threshold: 0.7 },
        { merge: false }
      );

      expect(preview.diff.removed.stopLoss).toBeDefined();
      expect(preview.diff.removed.takeProfit).toBeDefined();
    });

    it('should support merge mode in preview', () => {
      const preview = previewConfigUpdate(
        testStrategyId,
        { stopLoss: { percent: 0.03 } },
        { merge: true }
      );

      expect(preview.proposedConfig.stopLoss.percent).toBe(0.03);
      expect(preview.proposedConfig.stopLoss.enabled).toBe(true);
    });

    it('should support replace mode in preview', () => {
      const preview = previewConfigUpdate(
        testStrategyId,
        { threshold: 0.7 },
        { merge: false }
      );

      expect(preview.proposedConfig).toEqual({ threshold: 0.7 });
    });
  });

  describe('AC8: Config Validation Error Details', () => {
    it('should reject invalid config with detailed errors', () => {
      expect(() =>
        updateStrategyConfig(testStrategyId, { threshold: 2.0 })
      ).toThrow('Config validation failed');
    });

    it('should include which component failed in error', () => {
      try {
        updateStrategyConfig(testStrategyId, { threshold: 2.0 });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe(StrategyErrorCodes.CONFIG_UPDATE_FAILED);
        expect(err.context.errors).toBeDefined();
        expect(err.context.componentResults).toBeDefined();
      }
    });

    it('should not partially apply config on validation failure', () => {
      try {
        updateStrategyConfig(testStrategyId, { threshold: 2.0 });
      } catch (err) {
        // Database should not have been updated
        expect(run).not.toHaveBeenCalled();
      }
    });

    it('should reject entire update if any component fails validation', () => {
      mockEntryModule.validateConfig.mockReturnValueOnce({
        valid: false,
        errors: ['Entry requires minThreshold'],
      });

      expect(() =>
        updateStrategyConfig(testStrategyId, { threshold: 0.5 })
      ).toThrow('Config validation failed');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty newConfig in merge mode', () => {
      const result = updateStrategyConfig(testStrategyId, {});

      // Should preserve existing config
      expect(result.config.threshold).toBe(0.5);
    });

    it('should handle empty newConfig in replace mode', () => {
      const result = updateStrategyConfig(testStrategyId, {}, { merge: false });

      expect(result.config).toEqual({});
    });

    it('should handle null newConfig gracefully', () => {
      const result = updateStrategyConfig(testStrategyId, null);

      expect(result.config.threshold).toBe(0.5);
    });

    it('should handle deeply nested config merges', () => {
      get.mockReturnValue({
        ...testStrategy,
        config: JSON.stringify({
          level1: {
            level2: {
              level3: { value: 'original' },
              other: 'preserved',
            },
          },
        }),
      });

      const result = updateStrategyConfig(testStrategyId, {
        level1: {
          level2: {
            level3: { value: 'updated' },
          },
        },
      });

      expect(result.config.level1.level2.level3.value).toBe('updated');
      expect(result.config.level1.level2.other).toBe('preserved');
    });

    it('should throw for non-existent strategy', () => {
      get.mockReturnValue(undefined);

      expect(() =>
        updateStrategyConfig('strat-nonexistent', { threshold: 0.5 })
      ).toThrow('not found');
    });

    it('should throw for null strategyId', () => {
      expect(() =>
        updateStrategyConfig(null, { threshold: 0.5 })
      ).toThrow('required');
    });
  });

  describe('Integration: Config Workflow', () => {
    it('should support full config workflow: preview -> update -> validate', () => {
      // 1. Preview the change
      const preview = previewConfigUpdate(testStrategyId, { threshold: 0.7 });
      expect(preview.canUpdate).toBe(true);

      // 2. Apply the change
      const updated = updateStrategyConfig(testStrategyId, { threshold: 0.7 });
      expect(updated.config.threshold).toBe(0.7);

      // 3. Update mock for validation to return new config
      get.mockReturnValue({
        ...testStrategy,
        config: JSON.stringify({ ...JSON.parse(testStrategy.config), threshold: 0.7 }),
      });

      // 4. Validate the new config
      const validation = validateStrategyConfig(testStrategyId);
      expect(validation.valid).toBe(true);
    });

    it('should prevent invalid config from being applied after preview', () => {
      // Preview shows it would fail
      const preview = previewConfigUpdate(testStrategyId, { threshold: 2.0 });
      expect(preview.canUpdate).toBe(false);

      // Attempting update should also fail
      expect(() =>
        updateStrategyConfig(testStrategyId, { threshold: 2.0 })
      ).toThrow();
    });
  });
});
