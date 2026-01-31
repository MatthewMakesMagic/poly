/**
 * Strategy Module Tests
 *
 * Tests for the main strategy module interface:
 * init, getState, shutdown, and registry functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as strategyModule from '../index.js';

// Mock the logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the database
vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  get: vi.fn(),
  all: vi.fn(() => []),
}));

describe('Strategy Module (Story 6.1)', () => {
  beforeEach(async () => {
    // Ensure clean state
    await strategyModule.shutdown();
  });

  afterEach(async () => {
    await strategyModule.shutdown();
  });

  describe('AC7: Module Interface - init/getState/shutdown', () => {
    it('should initialize successfully', async () => {
      await strategyModule.init({ discoverOnInit: false });

      const state = strategyModule.getState();
      expect(state.initialized).toBe(true);
    });

    it('should throw if already initialized', async () => {
      await strategyModule.init({ discoverOnInit: false });

      await expect(strategyModule.init({ discoverOnInit: false })).rejects.toThrow(
        'Strategy module already initialized'
      );
    });

    it('should return state with catalog summary', async () => {
      await strategyModule.init({ discoverOnInit: false });

      const state = strategyModule.getState();
      expect(state.catalogSummary).toBeDefined();
      expect(state.catalogSummary).toHaveProperty('probability');
      expect(state.catalogSummary).toHaveProperty('entry');
      expect(state.catalogSummary).toHaveProperty('exit');
      expect(state.catalogSummary).toHaveProperty('sizing');
    });

    it('should shutdown gracefully', async () => {
      await strategyModule.init({ discoverOnInit: false });
      await strategyModule.shutdown();

      const state = strategyModule.getState();
      expect(state.initialized).toBe(false);
    });

    it('should handle shutdown when not initialized', async () => {
      // Should not throw
      await strategyModule.shutdown();
    });
  });

  describe('AC7: Registry Functions', () => {
    it('should throw NOT_INITIALIZED if calling functions before init', () => {
      expect(() => strategyModule.listAvailableComponents()).toThrow(
        'Strategy module not initialized'
      );
    });

    it('should export registerStrategyWithComponents function', async () => {
      await strategyModule.init({ discoverOnInit: false });
      expect(typeof strategyModule.registerStrategyWithComponents).toBe('function');
    });

    it('should export getStrategyById function', async () => {
      await strategyModule.init({ discoverOnInit: false });
      expect(typeof strategyModule.getStrategyById).toBe('function');
    });

    it('should export getComponentByVersionId function', async () => {
      await strategyModule.init({ discoverOnInit: false });
      expect(typeof strategyModule.getComponentByVersionId).toBe('function');
    });

    it('should export listAvailableComponents function', async () => {
      await strategyModule.init({ discoverOnInit: false });
      expect(typeof strategyModule.listAvailableComponents).toBe('function');
    });

    it('should export getComponentsForStrategy function', async () => {
      await strategyModule.init({ discoverOnInit: false });
      expect(typeof strategyModule.getComponentsForStrategy).toBe('function');
    });
  });

  describe('AC2: Version ID Generation', () => {
    it('should generate correct format for probability component', () => {
      const id = strategyModule.generateVersionId('probability', 'spot-lag', 1);
      expect(id).toBe('prob-spot-lag-v1');
    });

    it('should generate correct format for entry component', () => {
      const id = strategyModule.generateVersionId('entry', 'threshold', 2);
      expect(id).toBe('entry-threshold-v2');
    });

    it('should generate correct format for exit component', () => {
      const id = strategyModule.generateVersionId('exit', 'stop-loss', 1);
      expect(id).toBe('exit-stop-loss-v1');
    });

    it('should generate correct format for sizing component', () => {
      const id = strategyModule.generateVersionId('sizing', 'liquidity-aware', 3);
      expect(id).toBe('sizing-liquidity-aware-v3');
    });

    it('should generate unique IDs for different versions', () => {
      const v1 = strategyModule.generateVersionId('entry', 'threshold', 1);
      const v2 = strategyModule.generateVersionId('entry', 'threshold', 2);
      expect(v1).not.toBe(v2);
    });

    it('should throw for invalid component type', () => {
      expect(() => strategyModule.generateVersionId('invalid', 'test', 1)).toThrow(
        'Invalid component type'
      );
    });
  });

  describe('AC2: Version ID Parsing', () => {
    it('should parse valid probability version ID', () => {
      const parsed = strategyModule.parseVersionId('prob-spot-lag-v1');
      expect(parsed).toEqual({
        type: 'probability',
        name: 'spot-lag',
        version: 1,
        prefix: 'prob',
      });
    });

    it('should parse valid entry version ID', () => {
      const parsed = strategyModule.parseVersionId('entry-threshold-v2');
      expect(parsed).toEqual({
        type: 'entry',
        name: 'threshold',
        version: 2,
        prefix: 'entry',
      });
    });

    it('should return null for invalid version ID', () => {
      expect(strategyModule.parseVersionId('invalid')).toBeNull();
      expect(strategyModule.parseVersionId('')).toBeNull();
      expect(strategyModule.parseVersionId(null)).toBeNull();
    });
  });

  describe('AC6: Component Interface Validation', () => {
    it('should validate valid component', () => {
      const validComponent = {
        metadata: { name: 'test', version: 1, type: 'probability' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = strategyModule.validateComponentInterface(validComponent);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject component missing metadata', () => {
      const invalidComponent = {
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = strategyModule.validateComponentInterface(invalidComponent);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing metadata export');
    });

    it('should reject component missing evaluate function', () => {
      const invalidComponent = {
        metadata: { name: 'test', version: 1, type: 'probability' },
        validateConfig: () => ({ valid: true }),
      };

      const result = strategyModule.validateComponentInterface(invalidComponent);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing or invalid evaluate function');
    });

    it('should reject component with invalid type', () => {
      const invalidComponent = {
        metadata: { name: 'test', version: 1, type: 'invalid' },
        evaluate: () => {},
        validateConfig: () => ({ valid: true }),
      };

      const result = strategyModule.validateComponentInterface(invalidComponent);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid metadata.type: invalid');
    });
  });

  describe('Type Exports', () => {
    it('should export StrategyError', () => {
      expect(strategyModule.StrategyError).toBeDefined();
    });

    it('should export StrategyErrorCodes', () => {
      expect(strategyModule.StrategyErrorCodes).toBeDefined();
      expect(strategyModule.StrategyErrorCodes.NOT_INITIALIZED).toBeDefined();
    });

    it('should export ComponentType', () => {
      expect(strategyModule.ComponentType).toBeDefined();
      expect(strategyModule.ComponentType.PROBABILITY).toBe('probability');
    });
  });
});
