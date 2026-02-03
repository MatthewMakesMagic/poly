/**
 * Persistence Module Tests
 *
 * Tests for PostgreSQL database initialization, schema application,
 * query methods, and error handling.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 *
 * Note: These tests require a PostgreSQL database. Set TEST_DATABASE_URL
 * environment variable or use the default test database connection.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';

// Increase timeout for slow Supabase connections
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });
import persistence from '../index.js';
import { PersistenceError, ErrorCodes } from '../../types/errors.js';

// Use test database URL or skip tests
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Skip all tests if no database URL configured
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Persistence Module (PostgreSQL)', () => {
  const testConfig = {
    database: {
      url: TEST_DATABASE_URL,
      // Longer timeouts for Supabase which can be slow
      pool: { min: 1, max: 2, connectionTimeoutMs: 10000 },
      circuitBreakerPool: { min: 1, max: 1, connectionTimeoutMs: 10000 },
      queryTimeoutMs: 10000,
      retry: { maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 5000 },
    },
  };

  // Keep a single connection open for all tests to avoid pool lifecycle issues
  beforeAll(async () => {
    // Clean up any existing connection
    if (persistence.getState().initialized) {
      await persistence.shutdown();
    }
    // Initialize once for all tests
    await persistence.init(testConfig);
  });

  afterAll(async () => {
    // Shutdown after all tests complete
    if (persistence.getState().initialized) {
      await persistence.shutdown();
    }
  });

  describe('init', () => {
    // Note: persistence is already initialized in beforeAll

    it('connects to PostgreSQL database', async () => {
      // Already initialized in beforeAll, just verify state
      const state = persistence.getState();
      expect(state.initialized).toBe(true);
      expect(state.connected).toBe(true);
    });

    it('applies schema on first init', async () => {
      // Check trade_intents table exists using information_schema
      const result = await persistence.get(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'trade_intents'`
      );
      expect(result).toBeDefined();
      expect(result.table_name).toBe('trade_intents');
    });

    it('is idempotent - can be called multiple times', async () => {
      // Call init again - should not throw, just return early
      await persistence.init(testConfig);
      await persistence.init(testConfig);

      const state = persistence.getState();
      expect(state.initialized).toBe(true);
    });

    it('throws PersistenceError when url not configured', async () => {
      // Shutdown to test init error handling, then reinitialize
      await persistence.shutdown();

      await expect(persistence.init({})).rejects.toThrow(PersistenceError);
      await expect(persistence.init({ database: {} })).rejects.toThrow(PersistenceError);

      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });
  });

  describe('trade_intents table', () => {
    beforeEach(async () => {
      // Clean up test data (persistence already initialized in beforeAll)
      await persistence.run('DELETE FROM trade_intents WHERE window_id LIKE $1', ['test-%']);
    });

    it('has all required columns', async () => {
      const columns = await persistence.all(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'trade_intents'
         ORDER BY ordinal_position`
      );

      const columnNames = columns.map(c => c.column_name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('intent_type');
      expect(columnNames).toContain('window_id');
      expect(columnNames).toContain('payload');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('completed_at');
      expect(columnNames).toContain('result');
    });

    it('has index on status', async () => {
      const result = await persistence.get(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_intents_status'`
      );
      expect(result).toBeDefined();
      expect(result.indexname).toBe('idx_intents_status');
    });

    it('has index on window_id', async () => {
      const result = await persistence.get(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_intents_window'`
      );
      expect(result).toBeDefined();
      expect(result.indexname).toBe('idx_intents_window');
    });

    it('enforces NOT NULL constraints', async () => {
      await expect(
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, created_at)
           VALUES ($1, $2, $3, $4)`,
          [null, 'test-null', '{}', new Date().toISOString()]
        )
      ).rejects.toThrow();
    });

    it('enforces CHECK constraints on intent_type', async () => {
      await expect(
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['invalid_type', 'test-invalid', '{}', 'pending', new Date().toISOString()]
        )
      ).rejects.toThrow();
    });

    it('enforces CHECK constraints on status', async () => {
      await expect(
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['open_position', 'test-invalid-status', '{}', 'invalid_status', new Date().toISOString()]
        )
      ).rejects.toThrow();
    });

    it('accepts valid intent_type values', async () => {
      const validTypes = ['open_position', 'close_position', 'place_order', 'cancel_order'];

      for (const intentType of validTypes) {
        const result = await persistence.runReturningId(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [intentType, `test-${intentType}`, '{}', 'pending', new Date().toISOString()]
        );
        expect(result.lastInsertRowid).toBeGreaterThan(0);
      }
    });

    it('accepts valid status values', async () => {
      const validStatuses = ['pending', 'executing', 'completed', 'failed'];

      for (const status of validStatuses) {
        const result = await persistence.runReturningId(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['open_position', `test-status-${status}`, '{}', status, new Date().toISOString()]
        );
        expect(result.lastInsertRowid).toBeGreaterThan(0);
      }
    });
  });

  describe('query methods', () => {
    beforeEach(async () => {
      // Clean up test data (persistence already initialized in beforeAll)
      await persistence.run('DELETE FROM trade_intents WHERE window_id LIKE $1', ['test-%']);
    });

    it('run() inserts and runReturningId() returns lastInsertRowid', async () => {
      const result = await persistence.runReturningId(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        ['open_position', 'test-run-123', '{"test": true}', 'pending', new Date().toISOString()]
      );

      expect(result.lastInsertRowid).toBeGreaterThan(0);
      expect(result.changes).toBe(1);
    });

    it('run() updates and returns changes count', async () => {
      // Insert first
      await persistence.run(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        ['open_position', 'test-update-123', '{}', 'pending', new Date().toISOString()]
      );

      // Update
      const result = await persistence.run(
        `UPDATE trade_intents SET status = $1 WHERE window_id = $2`,
        ['executing', 'test-update-123']
      );

      expect(result.changes).toBe(1);
    });

    it('get() returns single row', async () => {
      await persistence.run(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        ['open_position', 'test-get-123', '{"data": 42}', 'pending', new Date().toISOString()]
      );

      const row = await persistence.get(
        'SELECT * FROM trade_intents WHERE window_id = $1',
        ['test-get-123']
      );

      expect(row).toBeDefined();
      expect(row.window_id).toBe('test-get-123');
      expect(row.intent_type).toBe('open_position');
      expect(row.payload).toBe('{"data": 42}');
    });

    it('get() returns undefined when no match', async () => {
      const row = await persistence.get(
        'SELECT * FROM trade_intents WHERE window_id = $1',
        ['nonexistent']
      );

      expect(row).toBeUndefined();
    });

    it('all() returns array of rows', async () => {
      // Insert multiple rows
      for (let i = 0; i < 3; i++) {
        await persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['open_position', `test-all-${i}`, '{}', 'pending', new Date().toISOString()]
        );
      }

      const rows = await persistence.all(
        'SELECT * FROM trade_intents WHERE window_id LIKE $1',
        ['test-all-%']
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
    });

    it('all() returns empty array when no matches', async () => {
      const rows = await persistence.all(
        'SELECT * FROM trade_intents WHERE status = $1',
        ['nonexistent']
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    });
  });

  describe('error handling', () => {
    // Persistence already initialized in beforeAll

    it('throws PersistenceError on query failure', async () => {
      await expect(
        persistence.run('INSERT INTO nonexistent_table (col) VALUES ($1)', ['value'])
      ).rejects.toThrow(PersistenceError);
    });

    it('includes error code in thrown error', async () => {
      try {
        await persistence.run('INSERT INTO nonexistent_table (col) VALUES ($1)', ['value']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PersistenceError);
        expect(error.code).toBe(ErrorCodes.DB_QUERY_FAILED);
      }
    });

    it('includes context in thrown error', async () => {
      try {
        await persistence.run('INSERT INTO nonexistent_table (col) VALUES ($1)', ['value']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.context).toBeDefined();
        expect(error.context.sql).toContain('INSERT INTO');
      }
    });

    it('throws when querying before init', async () => {
      // Shutdown temporarily to test this case
      await persistence.shutdown();
      await expect(persistence.run('SELECT 1')).rejects.toThrow(PersistenceError);
      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });
  });

  describe('getState', () => {
    // Persistence already initialized in beforeAll

    it('returns initialized=true when connected', () => {
      const state = persistence.getState();
      expect(state.initialized).toBe(true);
      expect(state.connected).toBe(true);
    });

    it('returns initialized=false after shutdown', async () => {
      await persistence.shutdown();

      const state = persistence.getState();
      expect(state.initialized).toBe(false);
      expect(state.connected).toBe(false);

      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });
  });

  describe('shutdown', () => {
    it('closes database connection', async () => {
      await persistence.shutdown();

      const state = persistence.getState();
      expect(state.connected).toBe(false);

      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });

    it('is idempotent - can be called multiple times', async () => {
      await persistence.shutdown();
      await persistence.shutdown(); // Should not throw

      const state = persistence.getState();
      expect(state.connected).toBe(false);

      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });
  });

  describe('schema_migrations table', () => {
    // Persistence already initialized in beforeAll

    it('exists after init', async () => {
      const result = await persistence.get(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
      );
      expect(result).toBeDefined();
      expect(result.table_name).toBe('schema_migrations');
    });

    it('records initial migration', async () => {
      const result = await persistence.get(
        'SELECT * FROM schema_migrations WHERE version = $1',
        ['001']
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('initial-schema');
    });
  });

  describe('exec', () => {
    // Persistence already initialized in beforeAll

    afterEach(async () => {
      // Clean up test tables
      await persistence.exec('DROP TABLE IF EXISTS test_exec_table');
      await persistence.exec('DROP TABLE IF EXISTS test_multi_1');
      await persistence.exec('DROP TABLE IF EXISTS test_multi_2');
    });

    it('executes raw SQL statements', async () => {
      await persistence.exec(`
        CREATE TABLE IF NOT EXISTS test_exec_table (
          id SERIAL PRIMARY KEY,
          name TEXT
        )
      `);

      const result = await persistence.get(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'test_exec_table'`
      );
      expect(result).toBeDefined();
      expect(result.table_name).toBe('test_exec_table');
    });

    it('executes multiple SQL statements', async () => {
      await persistence.exec(`
        CREATE TABLE IF NOT EXISTS test_multi_1 (id SERIAL PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS test_multi_2 (id SERIAL PRIMARY KEY);
      `);

      const result1 = await persistence.get(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'test_multi_1'`
      );
      const result2 = await persistence.get(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'test_multi_2'`
      );

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });

    it('throws when not initialized', async () => {
      await persistence.shutdown();

      await expect(
        persistence.exec('CREATE TABLE test (id INTEGER)')
      ).rejects.toThrow(PersistenceError);

      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });
  });

  describe('transaction', () => {
    beforeEach(async () => {
      // Clean up test data (persistence already initialized in beforeAll)
      await persistence.run('DELETE FROM trade_intents WHERE window_id LIKE $1', ['test-tx-%']);
    });

    it('commits successful transactions', async () => {
      await persistence.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['open_position', 'test-tx-1', '{}', 'pending', new Date().toISOString()]
        );
        await tx.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['open_position', 'test-tx-2', '{}', 'pending', new Date().toISOString()]
        );
      });

      const rows = await persistence.all(
        'SELECT * FROM trade_intents WHERE window_id LIKE $1',
        ['test-tx-%']
      );
      expect(rows.length).toBe(2);
    });

    it('rolls back on error', async () => {
      await expect(
        persistence.transaction(async (tx) => {
          await tx.run(
            `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            ['open_position', 'test-tx-rollback', '{}', 'pending', new Date().toISOString()]
          );
          // This should fail and trigger rollback
          throw new Error('Simulated failure');
        })
      ).rejects.toThrow('Simulated failure');

      const rows = await persistence.all(
        'SELECT * FROM trade_intents WHERE window_id = $1',
        ['test-tx-rollback']
      );
      expect(rows.length).toBe(0);
    });

    it('returns value from transaction function', async () => {
      const result = await persistence.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          ['open_position', 'test-tx-return', '{}', 'pending', new Date().toISOString()]
        );
        return 'success';
      });

      expect(result).toBe('success');
    });

    it('throws when not initialized', async () => {
      await persistence.shutdown();

      await expect(
        persistence.transaction(async () => {})
      ).rejects.toThrow(PersistenceError);

      // Re-initialize for remaining tests
      await persistence.init(testConfig);
    });
  });
});
