/**
 * Launch Config Module Public Interface Tests
 *
 * Tests the module interface: init, getState, shutdown, and public methods.
 * Uses vitest with mocked dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock the logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
import * as launchConfig from '../index.js';
import { LaunchConfigErrorCodes } from '../types.js';

// Test manifest path
const TEST_MANIFEST_PATH = './test-launch.json';

describe('Launch Config Module', () => {
  const validManifest = {
    strategies: ['simple-threshold'],
    position_size_dollars: 10,
    max_exposure_dollars: 500,
    symbols: ['BTC', 'ETH', 'SOL', 'XRP'],
    kill_switch_enabled: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up test file if exists
    try {
      fs.unlinkSync(path.resolve(TEST_MANIFEST_PATH));
    } catch {
      // Ignore if doesn't exist
    }
  });

  afterEach(async () => {
    try {
      await launchConfig.shutdown();
    } catch {
      // Ignore cleanup errors
    }
    // Clean up test file
    try {
      fs.unlinkSync(path.resolve(TEST_MANIFEST_PATH));
    } catch {
      // Ignore if doesn't exist
    }
  });

  describe('init()', () => {
    it('should initialize successfully with valid manifest', async () => {
      // Write test manifest
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));

      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const state = launchConfig.getState();
      expect(state.initialized).toBe(true);
      expect(state.manifestPath).toBe(TEST_MANIFEST_PATH);
      expect(state.manifest).toEqual(validManifest);
    });

    it('should throw if already initialized', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      await expect(launchConfig.init({ manifestPath: TEST_MANIFEST_PATH })).rejects.toThrow();
    });

    it('should handle missing manifest gracefully', async () => {
      // Init without manifest file - should log warning but not throw
      await launchConfig.init({ manifestPath: './nonexistent.json' });

      const state = launchConfig.getState();
      expect(state.initialized).toBe(true);
      expect(state.manifest).toBeNull();
    });
  });

  describe('getState()', () => {
    it('should return state with all expected fields', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const state = launchConfig.getState();

      expect(state).toHaveProperty('initialized');
      expect(state).toHaveProperty('manifestPath');
      expect(state).toHaveProperty('manifest');
      expect(state).toHaveProperty('knownStrategies');
      expect(state).toHaveProperty('activeStrategies');
      expect(state.knownStrategies).toContain('simple-threshold');
      expect(state.activeStrategies).toEqual(['simple-threshold']);
    });
  });

  describe('shutdown()', () => {
    it('should reset state', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      await launchConfig.shutdown();

      const state = launchConfig.getState();
      expect(state.initialized).toBe(false);
      expect(state.manifest).toBeNull();
    });
  });

  describe('loadManifest()', () => {
    it('should return cached manifest', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const manifest = launchConfig.loadManifest();

      expect(manifest).toEqual(validManifest);
    });

    it('should reload from disk when forced', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      // Modify file on disk
      const updatedManifest = { ...validManifest, position_size_dollars: 20 };
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(updatedManifest, null, 2));

      const manifest = launchConfig.loadManifest(true);

      expect(manifest.position_size_dollars).toBe(20);
    });

    it('should throw if not initialized', async () => {
      expect(() => launchConfig.loadManifest()).toThrow();
    });
  });

  describe('updateManifest()', () => {
    it('should update and persist changes', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const updated = launchConfig.updateManifest({ position_size_dollars: 25 });

      expect(updated.position_size_dollars).toBe(25);

      // Verify persisted
      const fromDisk = JSON.parse(fs.readFileSync(TEST_MANIFEST_PATH, 'utf-8'));
      expect(fromDisk.position_size_dollars).toBe(25);
    });

    it('should reject unknown strategies', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      expect(() => launchConfig.updateManifest({ strategies: ['unknown-strategy'] })).toThrow();
    });

    it('should reject invalid schema', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      expect(() => launchConfig.updateManifest({ position_size_dollars: -5 })).toThrow();
    });
  });

  describe('listAvailableStrategies()', () => {
    it('should return all known strategies', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const strategies = launchConfig.listAvailableStrategies();

      expect(strategies.length).toBeGreaterThan(0);
      expect(strategies.some((s) => s.name === 'simple-threshold')).toBe(true);
      expect(strategies.some((s) => s.name === 'oracle-edge')).toBe(true);
      expect(strategies[0]).toHaveProperty('name');
      expect(strategies[0]).toHaveProperty('description');
      expect(strategies[0]).toHaveProperty('dependencies');
    });
  });

  describe('isKnownStrategy()', () => {
    it('should return true for known strategies', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      expect(launchConfig.isKnownStrategy('simple-threshold')).toBe(true);
      expect(launchConfig.isKnownStrategy('oracle-edge')).toBe(true);
    });

    it('should return false for unknown strategies', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      expect(launchConfig.isKnownStrategy('unknown')).toBe(false);
    });

    it('should return false for non-string input', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      expect(launchConfig.isKnownStrategy(null)).toBe(false);
      expect(launchConfig.isKnownStrategy(undefined)).toBe(false);
      expect(launchConfig.isKnownStrategy(123)).toBe(false);
      expect(launchConfig.isKnownStrategy({})).toBe(false);
    });
  });

  describe('updateManifest() edge cases', () => {
    it('should handle empty updates object', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const updated = launchConfig.updateManifest({});

      expect(updated).toEqual(validManifest);
    });

    it('should reject duplicate strategies', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      expect(() => launchConfig.updateManifest({
        strategies: ['simple-threshold', 'simple-threshold']
      })).toThrow();
    });
  });

  describe('loadManifest() deep clone', () => {
    it('should return deep clone that cannot mutate internal state', async () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));
      await launchConfig.init({ manifestPath: TEST_MANIFEST_PATH });

      const manifest1 = launchConfig.loadManifest();
      manifest1.strategies.push('hacked');
      manifest1.symbols.push('HACKED');

      const manifest2 = launchConfig.loadManifest();
      expect(manifest2.strategies).not.toContain('hacked');
      expect(manifest2.symbols).not.toContain('HACKED');
    });
  });

  describe('listAvailableStrategies() without init', () => {
    it('should work without initialization (static data)', () => {
      // Don't init - should still work
      const strategies = launchConfig.listAvailableStrategies();

      expect(strategies.length).toBeGreaterThan(0);
      expect(strategies.some((s) => s.name === 'simple-threshold')).toBe(true);
    });

    it('should return deep cloned strategies', () => {
      const strategies1 = launchConfig.listAvailableStrategies();
      strategies1[0].dependencies.push('HACKED');

      const strategies2 = launchConfig.listAvailableStrategies();
      expect(strategies2[0].dependencies).not.toContain('HACKED');
    });
  });
});
