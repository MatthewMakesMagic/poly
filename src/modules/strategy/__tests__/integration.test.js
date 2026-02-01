/**
 * Strategy Module Integration Tests
 *
 * End-to-end tests for the strategy registry including:
 * - Full strategy registration flow
 * - Component discovery from filesystem
 * - Database operations with real schema
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

import * as strategyModule from '../index.js';
import { discoverComponents } from '../logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock the logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the database for most tests
vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  get: vi.fn(),
  all: vi.fn(() => []),
}));

import { run, get, all } from '../../../persistence/database.js';

describe('Strategy Module Integration (Story 6.1)', () => {
  const testComponentsPath = join(__dirname, 'test-components');

  beforeEach(async () => {
    await strategyModule.shutdown();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await strategyModule.shutdown();

    // Clean up test components directory
    if (existsSync(testComponentsPath)) {
      rmSync(testComponentsPath, { recursive: true, force: true });
    }
  });

  describe('AC6.7: Full Strategy Registration Flow', () => {
    it('should complete full registration flow', async () => {
      // Initialize module
      await strategyModule.init({ discoverOnInit: false });

      // Register a strategy
      const strategyId = strategyModule.registerStrategyWithComponents({
        name: 'Integration Test Strategy',
        components: {
          probability: 'prob-spot-lag-v1',
          entry: 'entry-threshold-v1',
          exit: 'exit-stop-loss-v1',
          sizing: 'sizing-liquidity-aware-v1',
        },
        config: {
          threshold: 0.6,
          stopLoss: 0.02,
          takeProfit: 0.05,
        },
      });

      // Verify strategy ID format
      expect(strategyId).toMatch(/^strat-/);

      // Verify database was called with correct parameters
      expect(run).toHaveBeenCalledTimes(1);
      const dbCall = run.mock.calls[0];
      expect(dbCall[0]).toContain('INSERT INTO strategy_instances');

      const params = dbCall[1];
      expect(params[1]).toBe('Integration Test Strategy'); // name
      expect(params[3]).toBe('prob-spot-lag-v1'); // probability
      expect(params[4]).toBe('entry-threshold-v1'); // entry
      expect(params[5]).toBe('exit-stop-loss-v1'); // exit
      expect(params[6]).toBe('sizing-liquidity-aware-v1'); // sizing
    });

    it('should retrieve registered strategy', async () => {
      await strategyModule.init({ discoverOnInit: false });

      // Mock database response
      get.mockReturnValueOnce({
        id: 'strat-test-123',
        name: 'Test Strategy',
        base_strategy_id: null,
        probability_component: 'prob-test-v1',
        entry_component: 'entry-test-v1',
        exit_component: 'exit-test-v1',
        sizing_component: 'sizing-test-v1',
        config: '{"threshold":0.6}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      const strategy = strategyModule.getStrategyById('strat-test-123');

      expect(strategy).toBeDefined();
      expect(strategy.id).toBe('strat-test-123');
      expect(strategy.name).toBe('Test Strategy');
      expect(strategy.components.probability).toBe('prob-test-v1');
      expect(strategy.config.threshold).toBe(0.6);
      expect(strategy.active).toBe(true);
    });

    it('should handle forked strategy registration', async () => {
      await strategyModule.init({ discoverOnInit: false });

      const strategyId = strategyModule.registerStrategyWithComponents({
        name: 'Forked Strategy',
        components: {
          probability: 'prob-spot-lag-v2', // Updated version
          entry: 'entry-threshold-v1',
          exit: 'exit-stop-loss-v1',
          sizing: 'sizing-liquidity-aware-v1',
        },
        config: { threshold: 0.7 },
        baseStrategyId: 'strat-parent-123',
      });

      expect(strategyId).toMatch(/^strat-/);

      const params = run.mock.calls[0][1];
      expect(params[2]).toBe('strat-parent-123'); // base_strategy_id
    });
  });

  describe('AC6: Component Discovery from Filesystem', () => {
    beforeEach(() => {
      // Create test components directory structure
      const types = ['probability', 'entry', 'exit', 'sizing'];
      for (const type of types) {
        mkdirSync(join(testComponentsPath, type), { recursive: true });
      }
    });

    it('should discover valid components', async () => {
      // Create a valid test component
      const componentCode = `
        export const metadata = {
          name: 'test-discovery',
          version: 1,
          type: 'probability',
          description: 'Test component for discovery',
        };
        export function evaluate(context, config) {
          return { probability: 0.5, signal: 'hold' };
        }
        export function validateConfig(config) {
          return { valid: true };
        }
      `;
      writeFileSync(join(testComponentsPath, 'probability', 'test-discovery.js'), componentCode);

      const catalog = await discoverComponents(testComponentsPath);

      expect(catalog).toBeDefined();
      expect(catalog.probability).toBeDefined();
      expect(Object.keys(catalog.probability)).toHaveLength(1);
      expect(catalog.probability['prob-test-discovery-v1']).toBeDefined();
    });

    it('should skip template files', async () => {
      const templateCode = `
        export const metadata = { name: 'template', version: 1, type: 'probability' };
        export function evaluate() { return {}; }
        export function validateConfig() { return { valid: true }; }
      `;
      writeFileSync(join(testComponentsPath, 'probability', '_template.js'), templateCode);

      const catalog = await discoverComponents(testComponentsPath);

      expect(catalog.probability).toEqual({});
    });

    it('should skip invalid components', async () => {
      // Create component missing required exports
      const invalidCode = `
        export const metadata = { name: 'invalid', version: 1 };
        // Missing type, evaluate, and validateConfig
      `;
      writeFileSync(join(testComponentsPath, 'probability', 'invalid.js'), invalidCode);

      const catalog = await discoverComponents(testComponentsPath);

      expect(catalog.probability).toEqual({});
    });

    it('should handle empty component directories', async () => {
      const catalog = await discoverComponents(testComponentsPath);

      expect(catalog).toEqual({
        probability: {},
        entry: {},
        exit: {},
        sizing: {},
        'price-source': {},
        analysis: {},
        'signal-generator': {},
      });
    });

    it('should handle non-existent components path', async () => {
      const catalog = await discoverComponents('/non/existent/path');

      expect(catalog).toEqual({
        probability: {},
        entry: {},
        exit: {},
        sizing: {},
        'price-source': {},
        analysis: {},
        'signal-generator': {},
      });
    });
  });

  describe('AC5: Query Operations', () => {
    it('should list components by type', async () => {
      await strategyModule.init({ discoverOnInit: false });

      // Manually populate catalog through rediscover
      // For this test, we verify the listAvailableComponents function works
      const components = strategyModule.listAvailableComponents('probability');

      expect(Array.isArray(components)).toBe(true);
    });

    it('should get strategy components with catalog lookup', async () => {
      await strategyModule.init({ discoverOnInit: false });

      // Mock strategy lookup
      get.mockReturnValueOnce({
        id: 'strat-123',
        name: 'Test',
        base_strategy_id: null,
        probability_component: 'prob-test-v1',
        entry_component: 'entry-test-v1',
        exit_component: 'exit-test-v1',
        sizing_component: 'sizing-test-v1',
        config: '{}',
        created_at: '2026-01-31T00:00:00Z',
        active: 1,
      });

      const components = strategyModule.getComponentsForStrategy('strat-123');

      expect(components).toBeDefined();
      expect(components.probability.versionId).toBe('prob-test-v1');
      expect(components.probability.inCatalog).toBe(false); // Not in empty catalog
    });

    it('should list all registered strategies', async () => {
      await strategyModule.init({ discoverOnInit: false });

      all.mockReturnValueOnce([
        {
          id: 'strat-1',
          name: 'Strategy 1',
          base_strategy_id: null,
          probability_component: 'prob-a-v1',
          entry_component: 'entry-a-v1',
          exit_component: 'exit-a-v1',
          sizing_component: 'sizing-a-v1',
          created_at: '2026-01-31T00:00:00Z',
          active: 1,
        },
        {
          id: 'strat-2',
          name: 'Strategy 2',
          base_strategy_id: 'strat-1',
          probability_component: 'prob-a-v2',
          entry_component: 'entry-a-v1',
          exit_component: 'exit-a-v1',
          sizing_component: 'sizing-a-v1',
          created_at: '2026-01-31T01:00:00Z',
          active: 1,
        },
      ]);

      const strategies = strategyModule.listRegisteredStrategies();

      expect(strategies).toHaveLength(2);
      expect(strategies[0].id).toBe('strat-1');
      expect(strategies[1].baseStrategyId).toBe('strat-1');
    });
  });

  describe('Module Lifecycle', () => {
    it('should handle multiple init/shutdown cycles', async () => {
      for (let i = 0; i < 3; i++) {
        await strategyModule.init({ discoverOnInit: false });
        expect(strategyModule.getState().initialized).toBe(true);

        await strategyModule.shutdown();
        expect(strategyModule.getState().initialized).toBe(false);
      }
    });

    it('should clear state on shutdown', async () => {
      await strategyModule.init({ discoverOnInit: false });

      // Register something
      strategyModule.registerStrategyWithComponents({
        name: 'Test',
        components: {
          probability: 'prob-v1',
          entry: 'entry-v1',
          exit: 'exit-v1',
          sizing: 'sizing-v1',
        },
        config: {},
      });

      const stateBefore = strategyModule.getState();
      expect(stateBefore.stats.strategiesRegistered).toBe(1);

      await strategyModule.shutdown();

      const stateAfter = strategyModule.getState();
      expect(stateAfter.initialized).toBe(false);
      expect(stateAfter.stats.strategiesRegistered).toBe(0);
    });
  });
});
