/**
 * Logger Schema Tests
 *
 * Tests for log entry schema validation.
 */

import { describe, it, expect } from 'vitest';
import { validateLogEntry, isValidLevel, getValidLevels } from '../schema.js';

describe('Schema Module', () => {
  describe('validateLogEntry', () => {
    it('validates correct log entry', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'info',
        module: 'test-module',
        event: 'test_event',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('validates entry with optional fields', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'error',
        module: 'test-module',
        event: 'test_event',
        data: { key: 'value' },
        context: { session: 'abc123' },
        error: { message: 'Something went wrong' },
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(true);
    });

    it('rejects non-object input', () => {
      expect(validateLogEntry(null).valid).toBe(false);
      expect(validateLogEntry('string').valid).toBe(false);
      expect(validateLogEntry(123).valid).toBe(false);
    });

    it('requires timestamp field', () => {
      const entry = {
        level: 'info',
        module: 'test',
        event: 'test',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: timestamp');
    });

    it('requires ISO 8601 timestamp format', () => {
      const entry = {
        timestamp: '2026-01-30',
        level: 'info',
        module: 'test',
        event: 'test',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid timestamp format: must be ISO 8601 with milliseconds');
    });

    it('requires level field', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        module: 'test',
        event: 'test',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: level');
    });

    it('requires valid level value', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'debug',
        module: 'test',
        event: 'test',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid level');
    });

    it('requires module field', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'info',
        event: 'test',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: module');
    });

    it('requires event field', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'info',
        module: 'test',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: event');
    });

    it('validates data is object if present', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'info',
        module: 'test',
        event: 'test',
        data: 'not an object',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid data: must be an object');
    });

    it('validates context is object if present', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'info',
        module: 'test',
        event: 'test',
        context: 123,
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid context: must be an object');
    });

    it('validates error is object if present', () => {
      const entry = {
        timestamp: '2026-01-30T10:15:30.123Z',
        level: 'info',
        module: 'test',
        event: 'test',
        error: 'string error',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid error: must be an object');
    });

    it('reports multiple errors', () => {
      const entry = {
        timestamp: 'invalid',
        level: 'debug',
      };

      const result = validateLogEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });

  describe('isValidLevel', () => {
    it('returns true for valid levels', () => {
      expect(isValidLevel('info')).toBe(true);
      expect(isValidLevel('warn')).toBe(true);
      expect(isValidLevel('error')).toBe(true);
    });

    it('returns false for invalid levels', () => {
      expect(isValidLevel('debug')).toBe(false);
      expect(isValidLevel('trace')).toBe(false);
      expect(isValidLevel('fatal')).toBe(false);
      expect(isValidLevel('')).toBe(false);
      expect(isValidLevel('INFO')).toBe(false); // Case sensitive
    });
  });

  describe('getValidLevels', () => {
    it('returns array of valid levels', () => {
      const levels = getValidLevels();
      expect(levels).toEqual(['info', 'warn', 'error']);
    });

    it('returns a copy, not the original array', () => {
      const levels1 = getValidLevels();
      const levels2 = getValidLevels();
      expect(levels1).not.toBe(levels2);
    });
  });
});
