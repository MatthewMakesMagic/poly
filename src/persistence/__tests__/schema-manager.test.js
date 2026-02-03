/**
 * Schema Manager Tests
 *
 * Tests for schema application, table/index checks, and migration tracking.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 * All operations are now async.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// Use test database URL or skip tests
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Skip all tests if no database URL configured
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

// Increase timeout for slow Supabase connections
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

describeIfDb('Schema Manager', () => {
  const testConfig = {
    database: {
      url: TEST_DATABASE_URL,
      pool: { min: 1, max: 2, connectionTimeoutMs: 10000 },
      circuitBreakerPool: { min: 1, max: 1, connectionTimeoutMs: 10000 },
      queryTimeoutMs: 10000,
      retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  };

  beforeAll(async () => {
    // Initialize persistence to set up database connection
    if (persistence.getState().initialized) {
      await persistence.shutdown();
    }
    await persistence.init(testConfig);
  });

  afterAll(async () => {
    // Shutdown persistence
    if (persistence.getState().initialized) {
      await persistence.shutdown();
    }
  });

  describe('applySchema', () => {
    it('creates trade_intents table', async () => {
      // Schema is already applied in init, verify it exists
      expect(await tableExists('trade_intents')).toBe(true);
    });

    it('creates schema_migrations table', async () => {
      expect(await tableExists('schema_migrations')).toBe(true);
    });

    it('is idempotent - can be called multiple times', async () => {
      // Call applySchema again (it was already called in init)
      await expect(applySchema()).resolves.not.toThrow();
      expect(await tableExists('trade_intents')).toBe(true);
    });

    it('creates indexes on trade_intents', async () => {
      expect(await indexExists('idx_intents_status')).toBe(true);
      expect(await indexExists('idx_intents_window')).toBe(true);
    });
  });

  describe('tableExists', () => {
    it('returns true for existing table', async () => {
      expect(await tableExists('trade_intents')).toBe(true);
    });

    it('returns false for non-existent table', async () => {
      expect(await tableExists('nonexistent_table')).toBe(false);
    });

    it('returns true for schema_migrations table', async () => {
      expect(await tableExists('schema_migrations')).toBe(true);
    });
  });

  describe('getTableColumns', () => {
    it('returns column names for trade_intents', async () => {
      const columns = await getTableColumns('trade_intents');
      expect(columns).toContain('id');
      expect(columns).toContain('intent_type');
      expect(columns).toContain('window_id');
      expect(columns).toContain('payload');
      expect(columns).toContain('status');
      expect(columns).toContain('created_at');
      expect(columns).toContain('completed_at');
      expect(columns).toContain('result');
    });

    it('returns empty array for non-existent table', async () => {
      const columns = await getTableColumns('nonexistent_table');
      expect(columns).toEqual([]);
    });

    it('returns column names for schema_migrations', async () => {
      const columns = await getTableColumns('schema_migrations');
      expect(columns).toContain('id');
      expect(columns).toContain('version');
      expect(columns).toContain('name');
      expect(columns).toContain('applied_at');
    });
  });

  describe('indexExists', () => {
    it('returns true for existing index', async () => {
      expect(await indexExists('idx_intents_status')).toBe(true);
    });

    it('returns false for non-existent index', async () => {
      expect(await indexExists('nonexistent_index')).toBe(false);
    });
  });

  describe('migration tracking', () => {
    it('returns schema version', async () => {
      const version = await getCurrentVersion();
      expect(version).toBeDefined();
      expect(version).toMatch(/^\d{3}$/); // Version format: 001, 002, etc.
    });

    it('migrationApplied returns true for applied migration', async () => {
      // Migration 001 should be applied during init
      expect(await migrationApplied('001')).toBe(true);
    });

    it('migrationApplied returns false for non-applied migration', async () => {
      expect(await migrationApplied('999')).toBe(false);
    });

    it('recordMigration adds new migration record', async () => {
      // Record a test migration
      const testVersion = '998';
      const testName = 'test-migration';

      // Ensure it doesn't exist
      expect(await migrationApplied(testVersion)).toBe(false);

      // Record it
      await recordMigration(testVersion, testName);

      // Verify it was recorded
      expect(await migrationApplied(testVersion)).toBe(true);

      // Clean up: remove test migration
      await persistence.run(
        'DELETE FROM schema_migrations WHERE version = $1',
        [testVersion]
      );
    });
  });
});
