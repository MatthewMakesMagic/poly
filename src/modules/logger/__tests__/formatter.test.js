/**
 * Logger Formatter Tests
 *
 * Tests for JSON formatting with snake_case fields, circular reference handling,
 * Date serialization, and BigInt handling.
 */

import { describe, it, expect } from 'vitest';
import { formatLogEntry } from '../formatter.js';

describe('Formatter Module', () => {
  describe('formatLogEntry (AC1, AC2)', () => {
    it('produces valid JSON', () => {
      const result = formatLogEntry('info', 'test-module', 'test_event');
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('includes required fields: timestamp, level, module, event', () => {
      const result = formatLogEntry('info', 'test-module', 'test_event');
      const parsed = JSON.parse(result);

      expect(parsed.timestamp).toBeDefined();
      expect(parsed.level).toBe('info');
      expect(parsed.module).toBe('test-module');
      expect(parsed.event).toBe('test_event');
    });

    it('uses snake_case field names', () => {
      const result = formatLogEntry('error', 'mod', 'event', {}, {}, new Error('test'));
      const parsed = JSON.parse(result);

      // All top-level keys should be snake_case
      const keys = Object.keys(parsed);
      expect(keys).toContain('timestamp');
      expect(keys).toContain('level');
      expect(keys).toContain('module');
      expect(keys).toContain('event');
    });

    it('includes data when provided', () => {
      const data = { user_id: 'u123', count: 5 };
      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data).toEqual(data);
    });

    it('includes context when provided', () => {
      const context = { session_id: 's456', strategy: 'test' };
      const result = formatLogEntry('info', 'mod', 'event', {}, context);
      const parsed = JSON.parse(result);

      expect(parsed.context).toEqual(context);
    });

    it('omits data when empty object', () => {
      const result = formatLogEntry('info', 'mod', 'event', {});
      const parsed = JSON.parse(result);

      expect(parsed.data).toBeUndefined();
    });

    it('omits context when empty object', () => {
      const result = formatLogEntry('info', 'mod', 'event', {}, {});
      const parsed = JSON.parse(result);

      expect(parsed.context).toBeUndefined();
    });

    it('defaults module to "root" when null', () => {
      const result = formatLogEntry('info', null, 'event');
      const parsed = JSON.parse(result);

      expect(parsed.module).toBe('root');
    });
  });

  describe('Circular reference handling (AC1)', () => {
    it('handles circular references in data gracefully', () => {
      const circular = { name: 'test' };
      circular.self = circular;

      const result = formatLogEntry('info', 'mod', 'event', circular);
      const parsed = JSON.parse(result);

      expect(parsed.data.name).toBe('test');
      expect(parsed.data.self).toBe('[Circular]');
    });

    it('handles deeply nested circular references', () => {
      const obj = {
        level1: {
          level2: {
            level3: null,
          },
        },
      };
      obj.level1.level2.level3 = obj;

      const result = formatLogEntry('info', 'mod', 'event', obj);
      const parsed = JSON.parse(result);

      expect(parsed.data.level1.level2.level3).toBe('[Circular]');
    });
  });

  describe('Date object serialization (AC1)', () => {
    it('serializes Date objects to ISO strings', () => {
      const date = new Date('2026-01-30T10:15:30.000Z');
      const data = { created_at: date };

      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data.created_at).toBe('2026-01-30T10:15:30.000Z');
    });

    it('handles nested Date objects', () => {
      const data = {
        timestamps: {
          start: new Date('2026-01-30T10:00:00.000Z'),
          end: new Date('2026-01-30T11:00:00.000Z'),
        },
      };

      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data.timestamps.start).toBe('2026-01-30T10:00:00.000Z');
      expect(parsed.data.timestamps.end).toBe('2026-01-30T11:00:00.000Z');
    });
  });

  describe('BigInt handling (AC1)', () => {
    it('converts BigInt values to string', () => {
      const data = { big_number: BigInt('9007199254740993') };

      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data.big_number).toBe('9007199254740993');
    });

    it('handles nested BigInt values', () => {
      const data = {
        values: {
          a: BigInt(123),
          b: BigInt(456),
        },
      };

      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data.values.a).toBe('123');
      expect(parsed.data.values.b).toBe('456');
    });
  });

  describe('Error formatting', () => {
    it('includes error message and name', () => {
      const err = new Error('Something went wrong');
      const result = formatLogEntry('error', 'mod', 'event', {}, {}, err);
      const parsed = JSON.parse(result);

      expect(parsed.error.message).toBe('Something went wrong');
      expect(parsed.error.name).toBe('Error');
    });

    it('includes error code when present', () => {
      const err = new Error('Config error');
      err.code = 'CONFIG_INVALID';

      const result = formatLogEntry('error', 'mod', 'event', {}, {}, err);
      const parsed = JSON.parse(result);

      expect(parsed.error.code).toBe('CONFIG_INVALID');
    });

    it('includes error context when present', () => {
      const err = new Error('Position error');
      err.context = { position_id: 'p123' };

      const result = formatLogEntry('error', 'mod', 'event', {}, {}, err);
      const parsed = JSON.parse(result);

      expect(parsed.error.context.position_id).toBe('p123');
    });

    it('includes stack trace', () => {
      const err = new Error('Stack trace test');
      const result = formatLogEntry('error', 'mod', 'event', {}, {}, err);
      const parsed = JSON.parse(result);

      expect(parsed.error.stack).toBeDefined();
      expect(parsed.error.stack).toContain('Error: Stack trace test');
    });
  });

  describe('Array handling', () => {
    it('handles arrays in data', () => {
      const data = { items: [1, 2, 3] };
      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data.items).toEqual([1, 2, 3]);
    });

    it('handles arrays of objects', () => {
      const data = {
        orders: [
          { id: '1', price: 0.5 },
          { id: '2', price: 0.6 },
        ],
      };

      const result = formatLogEntry('info', 'mod', 'event', data);
      const parsed = JSON.parse(result);

      expect(parsed.data.orders).toEqual(data.orders);
    });
  });
});
