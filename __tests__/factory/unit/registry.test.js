/**
 * Unit tests for Block Registry (Story 2.1)
 *
 * Covers: FR6, FR7, FR8 (building block discovery)
 *         NFR16 (independent testability)
 *
 * What this tests:
 *   - Auto-discovery of block modules from signals/, filters/, sizers/
 *   - Block retrieval by type and name
 *   - Descriptive errors for missing blocks and uninitialized registry
 *   - listBlocks() returns all registered blocks with metadata
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { loadBlocks, getBlock, listBlocks, resetRegistry, isInitialized } from '../../../src/factory/registry.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const factoryDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src/factory');

describe('Block Registry — Story 2.1', () => {
  afterEach(() => {
    resetRegistry();
  });

  describe('loadBlocks()', () => {
    it('discovers all signal, filter, and sizer blocks from the factory directory', async () => {
      const result = await loadBlocks(factoryDir);

      expect(result.loaded, 'Registry should discover blocks from all three directories').toBeGreaterThanOrEqual(14);
      expect(result.errors, 'No errors should occur during block loading').toHaveLength(0);
      expect(isInitialized(), 'Registry should be marked as initialized after loadBlocks()').toBe(true);
    });

    it('loads the expected signal blocks (FR6)', async () => {
      await loadBlocks(factoryDir);
      const blocks = listBlocks();
      const signalNames = blocks.signal.map(b => b.name).sort();

      expect(signalNames, 'All seven FR6 signal blocks should be discovered').toEqual([
        'bs-fair-value',
        'chainlink-deficit',
        'clob-imbalance',
        'exchange-consensus',
        'mean-reversion',
        'momentum',
        'ref-near-strike',
      ]);
    });

    it('loads the expected filter blocks (FR7)', async () => {
      await loadBlocks(factoryDir);
      const blocks = listBlocks();
      const filterNames = blocks.filter.map(b => b.name).sort();

      expect(filterNames, 'All five FR7 filter blocks should be discovered').toEqual([
        'cooldown',
        'max-price',
        'min-data',
        'once-per-window',
        'time-window',
      ]);
    });

    it('loads the expected sizer blocks (FR8)', async () => {
      await loadBlocks(factoryDir);
      const blocks = listBlocks();
      const sizerNames = blocks.sizer.map(b => b.name).sort();

      expect(sizerNames, 'All three FR8 sizer blocks should be discovered').toEqual([
        'fixed-capital',
        'kelly-fraction',
        'volatility-scaled',
      ]);
    });
  });

  describe('getBlock()', () => {
    it('retrieves a block by type and name', async () => {
      await loadBlocks(factoryDir);
      const block = getBlock('signal', 'chainlink-deficit');

      expect(block.name).toBe('chainlink-deficit');
      expect(block.description).toBeTruthy();
      expect(block.paramSchema).toBeTypeOf('object');
      expect(block.create).toBeTypeOf('function');
    });

    it('throws descriptive error for unknown block name listing available blocks', async () => {
      await loadBlocks(factoryDir);

      expect(() => getBlock('signal', 'nonexistent-signal'))
        .toThrow(/No signal block named 'nonexistent-signal'/);
      expect(() => getBlock('signal', 'nonexistent-signal'))
        .toThrow(/Available signal blocks/);
    });

    it('throws descriptive error for unknown block type', async () => {
      await loadBlocks(factoryDir);

      expect(() => getBlock('invalid-type', 'anything'))
        .toThrow(/Unknown block type 'invalid-type'/);
    });

    it('throws descriptive error when registry not initialized', () => {
      expect(() => getBlock('signal', 'chainlink-deficit'))
        .toThrow(/Block registry not initialized/);
    });
  });

  describe('listBlocks()', () => {
    it('returns all blocks grouped by type with metadata', async () => {
      await loadBlocks(factoryDir);
      const blocks = listBlocks();

      expect(blocks.signal.length, 'Should have signal blocks').toBeGreaterThan(0);
      expect(blocks.filter.length, 'Should have filter blocks').toBeGreaterThan(0);
      expect(blocks.sizer.length, 'Should have sizer blocks').toBeGreaterThan(0);

      // Each block should have name, description, paramSchema
      for (const block of blocks.signal) {
        expect(block).toHaveProperty('name');
        expect(block).toHaveProperty('description');
        expect(block).toHaveProperty('paramSchema');
      }
    });

    it('throws when registry not initialized', () => {
      expect(() => listBlocks()).toThrow(/Block registry not initialized/);
    });
  });

  describe('Block interface contract (NFR16)', () => {
    it('every discovered block exports name, description, paramSchema, create', async () => {
      await loadBlocks(factoryDir);
      const blocks = listBlocks();

      for (const type of ['signal', 'filter', 'sizer']) {
        for (const block of blocks[type]) {
          const mod = getBlock(type, block.name);
          expect(mod.name, `${type}/${block.name} should export name`).toBeTypeOf('string');
          expect(mod.description, `${type}/${block.name} should export description`).toBeTypeOf('string');
          expect(mod.paramSchema, `${type}/${block.name} should export paramSchema`).toBeTypeOf('object');
          expect(mod.create, `${type}/${block.name} should export create function`).toBeTypeOf('function');
        }
      }
    });
  });
});
