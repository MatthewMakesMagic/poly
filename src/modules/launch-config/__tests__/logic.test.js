/**
 * Launch Config Logic Tests
 *
 * Tests the validation and file operations logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  validateManifestSchema,
  validateStrategyNames,
  readManifest,
  writeManifest,
  loadAndValidateManifest,
  mergeManifestUpdates,
  getDefaultManifest,
} from '../logic.js';
import { LaunchConfigErrorCodes } from '../types.js';

// Test manifest path
const TEST_MANIFEST_PATH = './test-logic-manifest.json';

describe('Launch Config Logic', () => {
  const validManifest = {
    strategies: ['simple-threshold'],
    position_size_dollars: 10,
    max_exposure_dollars: 500,
    symbols: ['BTC', 'ETH'],
    kill_switch_enabled: true,
  };

  beforeEach(() => {
    // Clean up test file
    try {
      fs.unlinkSync(path.resolve(TEST_MANIFEST_PATH));
    } catch {
      // Ignore
    }
  });

  afterEach(() => {
    // Clean up test file
    try {
      fs.unlinkSync(path.resolve(TEST_MANIFEST_PATH));
    } catch {
      // Ignore
    }
  });

  describe('validateManifestSchema()', () => {
    it('should accept valid manifest', () => {
      const result = validateManifestSchema(validManifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should reject null manifest', () => {
      const result = validateManifestSchema(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Manifest must be an object');
    });

    it('should reject missing required fields', () => {
      const result = validateManifestSchema({ strategies: ['simple-threshold'] });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Missing required field'))).toBe(true);
    });

    it('should reject invalid strategies type', () => {
      const result = validateManifestSchema({
        ...validManifest,
        strategies: 'simple-threshold', // Should be array
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('strategies'))).toBe(true);
    });

    it('should reject empty strategies array', () => {
      const result = validateManifestSchema({
        ...validManifest,
        strategies: [],
      });
      expect(result.valid).toBe(false);
    });

    it('should reject invalid position_size_dollars', () => {
      const result = validateManifestSchema({
        ...validManifest,
        position_size_dollars: 0, // Must be >= 1
      });
      expect(result.valid).toBe(false);
    });

    it('should reject non-boolean kill_switch_enabled', () => {
      const result = validateManifestSchema({
        ...validManifest,
        kill_switch_enabled: 'yes',
      });
      expect(result.valid).toBe(false);
    });

    it('should reject unknown fields', () => {
      const result = validateManifestSchema({
        ...validManifest,
        unknownField: 'value',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unknown field'))).toBe(true);
    });

    it('should reject duplicate strategies', () => {
      const result = validateManifestSchema({
        ...validManifest,
        strategies: ['simple-threshold', 'simple-threshold'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
    });

    it('should reject position_size_dollars exceeding maximum', () => {
      const result = validateManifestSchema({
        ...validManifest,
        position_size_dollars: 999999,
      });
      expect(result.valid).toBe(false);
    });

    it('should reject max_exposure_dollars exceeding maximum', () => {
      const result = validateManifestSchema({
        ...validManifest,
        max_exposure_dollars: 999999999,
      });
      expect(result.valid).toBe(false);
    });

    it('should reject too many strategies', () => {
      const result = validateManifestSchema({
        ...validManifest,
        strategies: Array(15).fill('simple-threshold'),
      });
      expect(result.valid).toBe(false);
    });

    it('should reject empty symbols array', () => {
      const result = validateManifestSchema({
        ...validManifest,
        symbols: [],
      });
      expect(result.valid).toBe(false);
    });

    it('should reject too many symbols', () => {
      const result = validateManifestSchema({
        ...validManifest,
        symbols: Array(25).fill('BTC'),
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateStrategyNames()', () => {
    it('should accept known strategies', () => {
      const result = validateStrategyNames(['simple-threshold', 'oracle-edge']);
      expect(result.valid).toBe(true);
      expect(result.unknownStrategies).toBeUndefined();
    });

    it('should reject unknown strategies', () => {
      const result = validateStrategyNames(['simple-threshold', 'unknown-strategy']);
      expect(result.valid).toBe(false);
      expect(result.unknownStrategies).toContain('unknown-strategy');
    });

    it('should accept all known strategies', () => {
      const result = validateStrategyNames([
        'simple-threshold',
        'oracle-edge',
        'probability-model',
        'lag-based',
        'hybrid',
      ]);
      expect(result.valid).toBe(true);
    });
  });

  describe('readManifest()', () => {
    it('should read valid JSON file', () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));

      const manifest = readManifest(TEST_MANIFEST_PATH);

      expect(manifest).toEqual(validManifest);
    });

    it('should throw for missing file', () => {
      expect(() => readManifest('./nonexistent.json')).toThrow();
      try {
        readManifest('./nonexistent.json');
      } catch (err) {
        expect(err.code).toBe(LaunchConfigErrorCodes.MANIFEST_NOT_FOUND);
      }
    });

    it('should throw for invalid JSON', () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, 'not valid json');

      expect(() => readManifest(TEST_MANIFEST_PATH)).toThrow();
      try {
        readManifest(TEST_MANIFEST_PATH);
      } catch (err) {
        expect(err.code).toBe(LaunchConfigErrorCodes.INVALID_MANIFEST_SCHEMA);
      }
    });

    it('should reject path traversal attempts', () => {
      expect(() => readManifest('../../../etc/passwd')).toThrow();
      try {
        readManifest('../../../etc/passwd');
      } catch (err) {
        expect(err.code).toBe(LaunchConfigErrorCodes.VALIDATION_FAILED);
        expect(err.message).toContain('Path traversal');
      }
    });
  });

  describe('writeManifest()', () => {
    it('should write manifest to file', () => {
      writeManifest(validManifest, TEST_MANIFEST_PATH);

      const content = fs.readFileSync(TEST_MANIFEST_PATH, 'utf-8');
      expect(JSON.parse(content)).toEqual(validManifest);
    });

    it('should format with pretty print', () => {
      writeManifest(validManifest, TEST_MANIFEST_PATH);

      const content = fs.readFileSync(TEST_MANIFEST_PATH, 'utf-8');
      expect(content).toContain('\n');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('should reject path traversal attempts', () => {
      expect(() => writeManifest(validManifest, '../../../tmp/evil.json')).toThrow();
      try {
        writeManifest(validManifest, '../../../tmp/evil.json');
      } catch (err) {
        expect(err.code).toBe(LaunchConfigErrorCodes.VALIDATION_FAILED);
        expect(err.message).toContain('Path traversal');
      }
    });

    it('should perform atomic write (temp file should not persist on success)', () => {
      writeManifest(validManifest, TEST_MANIFEST_PATH);

      // Temp file should be cleaned up
      const tempPath = `${path.resolve(TEST_MANIFEST_PATH)}.tmp.${process.pid}`;
      expect(fs.existsSync(tempPath)).toBe(false);

      // Target file should exist
      expect(fs.existsSync(TEST_MANIFEST_PATH)).toBe(true);
    });
  });

  describe('loadAndValidateManifest()', () => {
    it('should load and validate manifest', () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(validManifest, null, 2));

      const manifest = loadAndValidateManifest(TEST_MANIFEST_PATH);

      expect(manifest).toEqual(validManifest);
    });

    it('should throw for invalid schema', () => {
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify({ strategies: [] }, null, 2));

      expect(() => loadAndValidateManifest(TEST_MANIFEST_PATH)).toThrow();
      try {
        loadAndValidateManifest(TEST_MANIFEST_PATH);
      } catch (err) {
        expect(err.code).toBe(LaunchConfigErrorCodes.INVALID_MANIFEST_SCHEMA);
      }
    });

    it('should throw for unknown strategies', () => {
      const badManifest = { ...validManifest, strategies: ['unknown'] };
      fs.writeFileSync(TEST_MANIFEST_PATH, JSON.stringify(badManifest, null, 2));

      expect(() => loadAndValidateManifest(TEST_MANIFEST_PATH)).toThrow();
      try {
        loadAndValidateManifest(TEST_MANIFEST_PATH);
      } catch (err) {
        expect(err.code).toBe(LaunchConfigErrorCodes.UNKNOWN_STRATEGY);
      }
    });
  });

  describe('mergeManifestUpdates()', () => {
    it('should merge updates into manifest', () => {
      const updates = { position_size_dollars: 25 };

      const merged = mergeManifestUpdates(validManifest, updates);

      expect(merged.position_size_dollars).toBe(25);
      expect(merged.strategies).toEqual(validManifest.strategies);
    });

    it('should override all specified fields', () => {
      const updates = {
        strategies: ['oracle-edge'],
        max_exposure_dollars: 1000,
      };

      const merged = mergeManifestUpdates(validManifest, updates);

      expect(merged.strategies).toEqual(['oracle-edge']);
      expect(merged.max_exposure_dollars).toBe(1000);
    });
  });

  describe('getDefaultManifest()', () => {
    it('should return default values', () => {
      const defaults = getDefaultManifest();

      expect(defaults.strategies).toEqual(['simple-threshold']);
      expect(defaults.position_size_dollars).toBe(10);
      expect(defaults.max_exposure_dollars).toBe(500);
      expect(defaults.kill_switch_enabled).toBe(true);
    });

    it('should return a copy', () => {
      const defaults1 = getDefaultManifest();
      const defaults2 = getDefaultManifest();

      defaults1.strategies.push('oracle-edge');

      expect(defaults2.strategies).not.toContain('oracle-edge');
    });
  });
});
