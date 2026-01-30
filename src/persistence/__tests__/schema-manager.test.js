/**
 * Schema Manager Tests
 *
 * Tests for schema application, table/index checks, and migration tracking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import persistence from '../index.js';
import {
  applySchema,
  tableExists,
  getTableColumns,
  indexExists,
  getCurrentVersion,
  migrationApplied,
  recordMigration,
} from '../schema-manager.js';
import { PersistenceError } from '../../types/errors.js';

describe('Schema Manager', () => {
  let tempDir;
  let dbPath;

  beforeEach(async () => {
    // Create temp directory for test database
    tempDir = mkdtempSync(join(tmpdir(), 'poly-schema-test-'));
    dbPath = join(tempDir, 'test.db');
    // Initialize persistence to set up database connection
    await persistence.init({ database: { path: dbPath } });
  });

  afterEach(async () => {
    // Shutdown persistence and clean up
    await persistence.shutdown();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('applySchema', () => {
    it('creates trade_intents table', () => {
      // Schema is already applied in init, verify it exists
      expect(tableExists('trade_intents')).toBe(true);
    });

    it('creates schema_migrations table', () => {
      expect(tableExists('schema_migrations')).toBe(true);
    });

    it('is idempotent - can be called multiple times', () => {
      // Call applySchema again (it was already called in init)
      expect(() => applySchema()).not.toThrow();
      expect(tableExists('trade_intents')).toBe(true);
    });

    it('creates indexes on trade_intents', () => {
      expect(indexExists('idx_intents_status')).toBe(true);
      expect(indexExists('idx_intents_window')).toBe(true);
    });
  });

  describe('tableExists', () => {
    it('returns true for existing table', () => {
      expect(tableExists('trade_intents')).toBe(true);
    });

    it('returns false for non-existent table', () => {
      expect(tableExists('nonexistent_table')).toBe(false);
    });

    it('returns true for schema_migrations table', () => {
      expect(tableExists('schema_migrations')).toBe(true);
    });
  });

  describe('getTableColumns', () => {
    it('returns column names for trade_intents', () => {
      const columns = getTableColumns('trade_intents');
      expect(columns).toContain('id');
      expect(columns).toContain('intent_type');
      expect(columns).toContain('window_id');
      expect(columns).toContain('payload');
      expect(columns).toContain('status');
      expect(columns).toContain('created_at');
      expect(columns).toContain('completed_at');
      expect(columns).toContain('result');
    });

    it('returns empty array for non-existent table', () => {
      const columns = getTableColumns('nonexistent_table');
      expect(columns).toEqual([]);
    });

    it('returns column names for schema_migrations', () => {
      const columns = getTableColumns('schema_migrations');
      expect(columns).toContain('id');
      expect(columns).toContain('version');
      expect(columns).toContain('name');
      expect(columns).toContain('applied_at');
    });

    it('throws PersistenceError for invalid table name', () => {
      expect(() => getTableColumns('invalid; DROP TABLE')).toThrow(PersistenceError);
      expect(() => getTableColumns('123invalid')).toThrow(PersistenceError);
      expect(() => getTableColumns('')).toThrow(PersistenceError);
    });

    it('accepts valid table names with underscores', () => {
      expect(() => getTableColumns('trade_intents')).not.toThrow();
      expect(() => getTableColumns('schema_migrations')).not.toThrow();
    });
  });

  describe('indexExists', () => {
    it('returns true for existing index', () => {
      expect(indexExists('idx_intents_status')).toBe(true);
      expect(indexExists('idx_intents_window')).toBe(true);
    });

    it('returns false for non-existent index', () => {
      expect(indexExists('nonexistent_index')).toBe(false);
    });
  });

  describe('getCurrentVersion', () => {
    it('returns last applied migration version', () => {
      const version = getCurrentVersion();
      // Version should be at least '001' and match NNN format
      expect(version).toMatch(/^\d{3}$/);
      expect(parseInt(version, 10)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('migrationApplied', () => {
    it('returns true for applied migrations', () => {
      expect(migrationApplied('001')).toBe(true);
    });

    it('returns false for non-applied migrations', () => {
      expect(migrationApplied('999')).toBe(false);
    });
  });

  describe('recordMigration', () => {
    it('records a new migration', () => {
      // Record a fake migration with high version to avoid conflicts with real migrations
      recordMigration('900', 'test-migration');

      // Verify it was recorded
      expect(migrationApplied('900')).toBe(true);

      // Verify the details
      const row = persistence.get(
        'SELECT * FROM schema_migrations WHERE version = ?',
        ['900']
      );
      expect(row.name).toBe('test-migration');
      expect(row.applied_at).toBeDefined();
    });

    it('records migration with correct timestamp format', () => {
      recordMigration('901', 'timestamp-test');

      const row = persistence.get(
        'SELECT applied_at FROM schema_migrations WHERE version = ?',
        ['901']
      );

      // Should be ISO format
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
