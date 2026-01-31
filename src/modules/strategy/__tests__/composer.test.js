/**
 * Strategy Composer Tests
 *
 * Tests for the strategy composition and execution logic:
 * createStrategy, executeStrategy, validateStrategy, and component pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createStrategy,
  executeStrategy,
  validateStrategy,
} from '../composer.js';
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
    reasoning: 'test probability',
    metadata: {},
  })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

const mockEntryModule = {
  metadata: { name: 'test-entry', version: 1, type: 'entry' },
  evaluate: vi.fn((context, config) => ({
    shouldEnter: context.prevResults?.probability?.probability > 0.5,
    direction: 'long',
    signal: { strength: 0.7, trigger: 'threshold_crossed' },
  })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

const mockSizingModule = {
  metadata: { name: 'test-sizing', version: 1, type: 'sizing' },
  evaluate: vi.fn((context, config) => ({
    size: 100,
    adjustedSize: 85,
    reason: 'reduced_for_liquidity',
    riskMetrics: {},
  })),
  validateConfig: vi.fn(() => ({ valid: true })),
};

const mockExitModule = {
  metadata: { name: 'test-exit', version: 1, type: 'exit' },
  evaluate: vi.fn((context, config) => ({
    shouldExit: false,
    stopLoss: { price: 0.38, percentage: 0.05 },
    takeProfit: { price: 0.55, percentage: 0.15 },
    expiry: { windowEnd: '2026-01-31T10:15:00Z' },
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

// Standard test components object
const validComponents = {
  probability: 'prob-test-prob-v1',
  entry: 'entry-test-entry-v1',
  exit: 'exit-test-exit-v1',
  sizing: 'sizing-test-sizing-v1',
};

describe('Strategy Composer (Story 6.2)', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    setupMockCatalog();
  });

  afterEach(() => {
    resetState();
  });

  describe('AC1: Create Strategy from Components', () => {
    it('should create strategy with valid components', () => {
      const strategyId = createStrategy('Test Strategy', validComponents, { threshold: 0.5 });

      expect(strategyId).toMatch(/^strat-/);
      expect(run).toHaveBeenCalledTimes(1);

      const callArgs = run.mock.calls[0][1];
      expect(callArgs[1]).toBe('Test Strategy'); // name
      expect(callArgs[3]).toBe('prob-test-prob-v1'); // probability
      expect(callArgs[4]).toBe('entry-test-entry-v1'); // entry
      expect(callArgs[5]).toBe('exit-test-exit-v1'); // exit
      expect(callArgs[6]).toBe('sizing-test-sizing-v1'); // sizing
    });

    it('should persist strategy to strategy_instances table', () => {
      createStrategy('Persisted Strategy', validComponents, { param: 'value' });

      expect(run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO strategy_instances'),
        expect.any(Array)
      );

      const callArgs = run.mock.calls[0][1];
      expect(JSON.parse(callArgs[7])).toEqual({ param: 'value' }); // config JSON
    });

    it('should reject strategy with invalid component ID', () => {
      expect(() =>
        createStrategy('Invalid', {
          probability: 'prob-nonexistent-v1',
          entry: 'entry-test-entry-v1',
          exit: 'exit-test-exit-v1',
          sizing: 'sizing-test-sizing-v1',
        }, {})
      ).toThrow('not found in catalog');
    });

    it('should reject strategy with missing component', () => {
      expect(() =>
        createStrategy('Incomplete', {
          probability: 'prob-test-prob-v1',
          // missing entry, exit, sizing
        }, {})
      ).toThrow('is required');
    });

    it('should reject strategy with wrong component type in slot', () => {
      // Add probability component with wrong type to entry slot
      setCatalog({
        probability: {
          'prob-test-prob-v1': {
            versionId: 'prob-test-prob-v1',
            name: 'test-prob',
            version: 1,
            type: 'probability',
            module: mockProbabilityModule,
          },
          'prob-wrong-v1': {
            versionId: 'prob-wrong-v1',
            name: 'wrong',
            version: 1,
            type: 'probability', // wrong type for entry slot
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

      expect(() =>
        createStrategy('WrongType', {
          probability: 'prob-test-prob-v1',
          entry: 'prob-wrong-v1', // probability component in entry slot
          exit: 'exit-test-exit-v1',
          sizing: 'sizing-test-sizing-v1',
        }, {})
      ).toThrow("type 'probability', expected 'entry'");
    });
  });

  describe('AC2: Strategy Execution Flow', () => {
    const testStrategyId = 'strat-test-123';

    beforeEach(() => {
      // Set up mock strategy in database
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.5}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });
    });

    it('should execute components in correct order: probability -> entry -> sizing -> exit', () => {
      const context = { spotPrice: 42500, marketPrice: 0.42 };
      const result = executeStrategy(testStrategyId, context);

      // Verify all components were called in order
      expect(mockProbabilityModule.evaluate).toHaveBeenCalled();
      expect(mockEntryModule.evaluate).toHaveBeenCalled();
      expect(mockSizingModule.evaluate).toHaveBeenCalled();
      expect(mockExitModule.evaluate).toHaveBeenCalled();

      // Verify call order
      const probCall = mockProbabilityModule.evaluate.mock.invocationCallOrder[0];
      const entryCall = mockEntryModule.evaluate.mock.invocationCallOrder[0];
      const sizingCall = mockSizingModule.evaluate.mock.invocationCallOrder[0];
      const exitCall = mockExitModule.evaluate.mock.invocationCallOrder[0];

      expect(probCall).toBeLessThan(entryCall);
      expect(entryCall).toBeLessThan(sizingCall);
      expect(sizingCall).toBeLessThan(exitCall);
    });

    it('should return structured execution result', () => {
      const context = { spotPrice: 42500, marketPrice: 0.42, windowId: 'btc-15m-xxx' };
      const result = executeStrategy(testStrategyId, context);

      expect(result.strategyId).toBe(testStrategyId);
      expect(result.executedAt).toBeDefined();
      expect(result.decision).toBeDefined();
      expect(result.components).toBeDefined();
      expect(result.context).toBeDefined();

      // Check component results exist
      expect(result.components.probability).toBeDefined();
      expect(result.components.entry).toBeDefined();
      expect(result.components.sizing).toBeDefined();
      expect(result.components.exit).toBeDefined();
    });

    it('should produce trade decision from component outputs', () => {
      const context = { spotPrice: 42500, marketPrice: 0.42 };
      const result = executeStrategy(testStrategyId, context);

      expect(result.decision.action).toBe('enter'); // shouldEnter: true
      expect(result.decision.direction).toBe('long');
      expect(result.decision.size).toBe(85); // adjustedSize
      expect(result.decision.stopLoss).toBe(0.38);
      expect(result.decision.takeProfit).toBe(0.55);
      expect(result.decision.probability).toBe(0.75);
    });

    it('should throw for non-existent strategy', () => {
      get.mockReturnValue(undefined);

      expect(() => executeStrategy('strat-nonexistent', {})).toThrow('not found');
    });

    it('should throw for inactive strategy', () => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Inactive Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 0, // inactive
      });

      expect(() => executeStrategy(testStrategyId, {})).toThrow('is not active');
    });
  });

  describe('AC3: Component Reuse Across Strategies', () => {
    it('should reference same component version for multiple strategies', () => {
      // Create two strategies using same probability component
      const strategyId1 = createStrategy('Strategy 1', validComponents, {});
      const strategyId2 = createStrategy('Strategy 2', validComponents, {});

      expect(strategyId1).toMatch(/^strat-/);
      expect(strategyId2).toMatch(/^strat-/);
      expect(strategyId1).not.toBe(strategyId2);

      // Both should store the same component version ID
      const calls = run.mock.calls;
      expect(calls[0][1][3]).toBe('prob-test-prob-v1'); // strategy 1
      expect(calls[1][1][3]).toBe('prob-test-prob-v1'); // strategy 2
    });

    it('should load shared component once from catalog', () => {
      const testStrategyId = 'strat-shared-test';
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Shared Component Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      // Execute strategy - components loaded from catalog
      const result = executeStrategy(testStrategyId, { spotPrice: 100 });

      // Component should execute with shared module
      expect(result.components.probability.probability).toBe(0.75);
    });
  });

  describe('AC4: Component Result Pipeline', () => {
    const testStrategyId = 'strat-pipeline-test';

    beforeEach(() => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Pipeline Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.6}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });
    });

    it('should pass probability output to entry component', () => {
      const context = { spotPrice: 42500 };
      executeStrategy(testStrategyId, context);

      const entryContext = mockEntryModule.evaluate.mock.calls[0][0];
      expect(entryContext.prevResults.probability).toBeDefined();
      expect(entryContext.prevResults.probability.probability).toBe(0.75);
    });

    it('should pass entry decision to sizing component', () => {
      const context = { spotPrice: 42500 };
      executeStrategy(testStrategyId, context);

      const sizingContext = mockSizingModule.evaluate.mock.calls[0][0];
      expect(sizingContext.prevResults.entry).toBeDefined();
      expect(sizingContext.prevResults.entry.shouldEnter).toBe(true);
    });

    it('should pass sizing output to exit component', () => {
      const context = { spotPrice: 42500 };
      executeStrategy(testStrategyId, context);

      const exitContext = mockExitModule.evaluate.mock.calls[0][0];
      expect(exitContext.prevResults.sizing).toBeDefined();
      expect(exitContext.prevResults.sizing.size).toBe(100);
    });

    it('should aggregate all component outputs in final result', () => {
      const context = { spotPrice: 42500, windowId: 'test-window' };
      const result = executeStrategy(testStrategyId, context);

      // All component outputs should be present
      expect(result.components.probability.probability).toBe(0.75);
      expect(result.components.entry.shouldEnter).toBe(true);
      expect(result.components.sizing.adjustedSize).toBe(85);
      expect(result.components.exit.stopLoss.price).toBe(0.38);
    });
  });

  describe('AC5: Strategy Configuration Passing', () => {
    const testStrategyId = 'strat-config-test';

    beforeEach(() => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Config Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.6,"riskMultiplier":2}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });
    });

    it('should pass full strategy config to each component', () => {
      const context = { spotPrice: 42500 };
      executeStrategy(testStrategyId, context);

      const expectedConfig = { threshold: 0.6, riskMultiplier: 2 };

      // Each component should receive the config
      expect(mockProbabilityModule.evaluate.mock.calls[0][1]).toEqual(expectedConfig);
      expect(mockEntryModule.evaluate.mock.calls[0][1]).toEqual(expectedConfig);
      expect(mockSizingModule.evaluate.mock.calls[0][1]).toEqual(expectedConfig);
      expect(mockExitModule.evaluate.mock.calls[0][1]).toEqual(expectedConfig);
    });

    it('should validate config against components during createStrategy', () => {
      // Config validation happens during creation
      createStrategy('Valid Config', validComponents, { threshold: 0.5 });

      // All validateConfig functions should have been called
      expect(mockProbabilityModule.validateConfig).toHaveBeenCalledWith({ threshold: 0.5 });
      expect(mockEntryModule.validateConfig).toHaveBeenCalledWith({ threshold: 0.5 });
      expect(mockSizingModule.validateConfig).toHaveBeenCalledWith({ threshold: 0.5 });
      expect(mockExitModule.validateConfig).toHaveBeenCalledWith({ threshold: 0.5 });
    });

    it('should reject strategy if config validation fails', () => {
      // Make one component reject the config
      mockSizingModule.validateConfig.mockReturnValueOnce({
        valid: false,
        errors: ['Missing required field: maxSize'],
      });

      expect(() =>
        createStrategy('Invalid Config', validComponents, { threshold: 0.5 })
      ).toThrow('Config validation failed');
    });
  });

  describe('AC6: Error Handling in Composition', () => {
    const testStrategyId = 'strat-error-test';

    beforeEach(() => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Error Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });
    });

    it('should halt execution when component throws error', () => {
      mockEntryModule.evaluate.mockImplementationOnce(() => {
        throw new Error('Entry component failure');
      });

      expect(() => executeStrategy(testStrategyId, {})).toThrow('execution failed');

      // Exit should not have been called
      expect(mockExitModule.evaluate).not.toHaveBeenCalled();
    });

    it('should include failed component and error details in error', () => {
      mockSizingModule.evaluate.mockImplementationOnce(() => {
        throw new Error('Sizing calculation error');
      });

      try {
        executeStrategy(testStrategyId, {});
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe(StrategyErrorCodes.COMPONENT_EXECUTION_FAILED);
        expect(err.message).toContain('sizing-test-sizing-v1');
        expect(err.message).toContain('Sizing calculation error');
      }
    });

    it('should include partial results in error context', () => {
      mockSizingModule.evaluate.mockImplementationOnce(() => {
        throw new Error('Sizing failed');
      });

      try {
        executeStrategy(testStrategyId, {});
        expect.fail('Should have thrown');
      } catch (err) {
        // Partial results should include probability and entry
        expect(err.context.partialResults).toBeDefined();
        expect(err.context.partialResults.probability).toBeDefined();
        expect(err.context.partialResults.entry).toBeDefined();
        // Sizing and exit should not be in partial results
        expect(err.context.partialResults.sizing).toBeUndefined();
        expect(err.context.partialResults.exit).toBeUndefined();
      }
    });

    it('should reject component returning invalid output', () => {
      mockProbabilityModule.evaluate.mockReturnValueOnce(null);

      expect(() => executeStrategy(testStrategyId, {})).toThrow('returned invalid output');
    });
  });

  describe('AC7: Validate Strategy Function', () => {
    const testStrategyId = 'strat-validate-test';

    beforeEach(() => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Validate Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });
    });

    it('should return valid for well-formed strategy', () => {
      const result = validateStrategy(testStrategyId);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should return strategy info in result', () => {
      const result = validateStrategy(testStrategyId);

      expect(result.strategy.id).toBe(testStrategyId);
      expect(result.strategy.name).toBe('Validate Test Strategy');
      expect(result.strategy.active).toBe(true);
    });

    it('should return details for each component', () => {
      const result = validateStrategy(testStrategyId);

      expect(result.details.probability.inCatalog).toBe(true);
      expect(result.details.probability.interfaceValid).toBe(true);
      expect(result.details.probability.configValid).toBe(true);

      expect(result.details.entry.inCatalog).toBe(true);
      expect(result.details.sizing.inCatalog).toBe(true);
      expect(result.details.exit.inCatalog).toBe(true);
    });

    it('should detect missing component in catalog', () => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Missing Component Strategy',
        base_strategy_id: null,
        probability_component: 'prob-nonexistent-v1', // not in catalog
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      const result = validateStrategy(testStrategyId);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Component prob-nonexistent-v1 (probability) not found in catalog');
      expect(result.details.probability.inCatalog).toBe(false);
    });

    it('should detect non-existent strategy', () => {
      get.mockReturnValue(undefined);

      const result = validateStrategy('strat-nonexistent');

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Strategy strat-nonexistent not found');
    });

    it('should detect inactive strategy', () => {
      get.mockReturnValue({
        id: testStrategyId,
        name: 'Inactive Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 0,
      });

      const result = validateStrategy(testStrategyId);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(`Strategy ${testStrategyId} is not active`);
    });

    it('should detect config validation failure', () => {
      mockEntryModule.validateConfig.mockReturnValueOnce({
        valid: false,
        errors: ['Invalid threshold value'],
      });

      const result = validateStrategy(testStrategyId);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Config validation failed for entry: Invalid threshold value');
      expect(result.details.entry.configValid).toBe(false);
    });
  });

  describe('Integration: Full Strategy Creation and Execution Flow', () => {
    it('should create and execute a complete strategy', () => {
      // Create strategy
      const strategyId = createStrategy('Integration Test Strategy', validComponents, {
        threshold: 0.6,
        maxSize: 200,
      });

      expect(strategyId).toMatch(/^strat-/);

      // Set up mock for getStrategy to return the created strategy
      get.mockReturnValue({
        id: strategyId,
        name: 'Integration Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{"threshold":0.6,"maxSize":200}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      // Execute strategy
      const context = {
        spotPrice: 42500,
        marketPrice: 0.42,
        windowId: 'btc-15m-integration-test',
      };

      const result = executeStrategy(strategyId, context);

      // Verify complete execution
      expect(result.strategyId).toBe(strategyId);
      expect(result.decision.action).toBe('enter');
      expect(result.decision.direction).toBe('long');
      expect(result.decision.size).toBe(85);
      expect(result.components.probability.probability).toBe(0.75);
      expect(result.context.windowId).toBe('btc-15m-integration-test');
    });

    it('should validate, create, and execute strategy end-to-end', () => {
      // Create strategy
      const strategyId = createStrategy('E2E Test Strategy', validComponents, {});

      // Mock getStrategy for validation and execution
      get.mockReturnValue({
        id: strategyId,
        name: 'E2E Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-prob-v1',
        entry_component: 'entry-test-entry-v1',
        exit_component: 'exit-test-exit-v1',
        sizing_component: 'sizing-test-sizing-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      // Validate strategy
      const validation = validateStrategy(strategyId);
      expect(validation.valid).toBe(true);

      // Execute strategy
      const result = executeStrategy(strategyId, { spotPrice: 100 });
      expect(result.decision).toBeDefined();
      expect(result.components).toBeDefined();
    });
  });
});
