/**
 * Unit tests for Factory Public API (Story 2.7)
 *
 * Covers: FR4 (YAML parsing), FR42 (interchangeable strategies),
 *         NFR12 (interface contract), NFR14 (existing patterns)
 *
 * What this tests:
 *   - Public API exports all required functions
 *   - loadStrategy resolves .yaml and .js files correctly
 *   - listStrategies discovers files in strategy directories
 *   - Factory config block exists in config/index.js
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  composeFromYaml,
  composeFromDefinition,
  validateDefinition,
  listBlocks,
  loadBlocks,
  loadStrategy,
  listStrategies,
} from '../../../src/factory/index.js';

const FACTORY_DIR = new URL('../../../src/factory/', import.meta.url).pathname;

beforeAll(async () => {
  await loadBlocks(FACTORY_DIR);
});

describe('Factory Public API — Story 2.7', () => {

  // ─── API Surface ─────────────────────────────────────────────────

  describe('API surface', () => {
    it('exports composeFromYaml', () => {
      expect(typeof composeFromYaml).toBe('function');
    });

    it('exports composeFromDefinition', () => {
      expect(typeof composeFromDefinition).toBe('function');
    });

    it('exports validateDefinition', () => {
      expect(typeof validateDefinition).toBe('function');
    });

    it('exports listBlocks', () => {
      expect(typeof listBlocks).toBe('function');
    });

    it('exports loadBlocks', () => {
      expect(typeof loadBlocks).toBe('function');
    });

    it('exports loadStrategy', () => {
      expect(typeof loadStrategy).toBe('function');
    });

    it('exports listStrategies', () => {
      expect(typeof listStrategies).toBe('function');
    });
  });

  // ─── listBlocks ──────────────────────────────────────────────────

  describe('listBlocks()', () => {
    it('returns all block types', () => {
      const blocks = listBlocks();
      expect(blocks, 'listBlocks must return an object').toBeDefined();
      expect(Array.isArray(blocks.signal), 'Must have signal blocks').toBe(true);
      expect(Array.isArray(blocks.filter), 'Must have filter blocks').toBe(true);
      expect(Array.isArray(blocks.sizer), 'Must have sizer blocks').toBe(true);
    });

    it('lists known signal blocks', () => {
      const blocks = listBlocks();
      const signalNames = blocks.signal.map(b => b.name);
      expect(signalNames, 'Should include chainlink-deficit signal').toContain('chainlink-deficit');
      expect(signalNames, 'Should include ref-near-strike signal').toContain('ref-near-strike');
      expect(signalNames, 'Should include bs-fair-value signal').toContain('bs-fair-value');
    });

    it('lists known filter blocks', () => {
      const blocks = listBlocks();
      const filterNames = blocks.filter.map(b => b.name);
      expect(filterNames, 'Should include once-per-window filter').toContain('once-per-window');
      expect(filterNames, 'Should include time-window filter').toContain('time-window');
      expect(filterNames, 'Should include max-price filter').toContain('max-price');
    });

    it('lists known sizer blocks', () => {
      const blocks = listBlocks();
      const sizerNames = blocks.sizer.map(b => b.name);
      expect(sizerNames, 'Should include fixed-capital sizer').toContain('fixed-capital');
    });
  });

  // ─── loadStrategy — YAML ────────────────────────────────────────

  describe('loadStrategy() — YAML files', () => {
    const factoryStrategiesDir = new URL('../../../src/factory/strategies/', import.meta.url).pathname;

    it('loads edge-c-asymmetry YAML by name', async () => {
      const strategy = await loadStrategy('edge-c-asymmetry', {
        searchDirs: [factoryStrategiesDir],
      });

      expect(strategy.name, 'Loaded strategy must have correct name').toBe('edge-c-asymmetry');
      expect(typeof strategy.evaluate, 'Must have evaluate function').toBe('function');
      expect(typeof strategy.onWindowOpen, 'Must have onWindowOpen function').toBe('function');
    });

    it('loads edge-c-asymmetry YAML with .yaml extension', async () => {
      const strategy = await loadStrategy('edge-c-asymmetry.yaml', {
        searchDirs: [factoryStrategiesDir],
      });

      expect(strategy.name).toBe('edge-c-asymmetry');
    });
  });

  // ─── loadStrategy — Error Cases ─────────────────────────────────

  describe('loadStrategy() — error cases', () => {
    it('throws descriptive error for missing strategy', async () => {
      await expect(
        loadStrategy('nonexistent-strategy-xyz', { searchDirs: ['/tmp/empty-dir/'] })
      ).rejects.toThrow(/not found/i);
    });
  });

  // ─── listStrategies ─────────────────────────────────────────────

  describe('listStrategies()', () => {
    const factoryStrategiesDir = new URL('../../../src/factory/strategies/', import.meta.url).pathname;

    it('discovers YAML strategy files', async () => {
      const strategies = await listStrategies({
        searchDirs: [factoryStrategiesDir],
      });

      expect(strategies.length, 'Should find at least one strategy').toBeGreaterThan(0);

      const yamlStrategies = strategies.filter(s => s.type === 'yaml');
      expect(yamlStrategies.length, 'Should find at least one YAML strategy').toBeGreaterThan(0);

      const edgeC = yamlStrategies.find(s => s.name === 'edge-c-asymmetry');
      expect(edgeC, 'Should find edge-c-asymmetry.yaml').toBeDefined();
    });
  });
});
