/**
 * Persistence Module Tests
 *
 * Tests for SQLite database initialization, schema application,
 * query methods, and error handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import persistence from '../index.js';
import { PersistenceError, ErrorCodes } from '../../types/errors.js';

describe('Persistence Module', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    // Create temp directory for test database
    tempDir = mkdtempSync(join(tmpdir(), 'poly-test-'));
    dbPath = join(tempDir, 'test.db');
  });

  afterEach(async () => {
    // Shutdown persistence and clean up
    await persistence.shutdown();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('init', () => {
    it('creates database file at configured path', async () => {
      await persistence.init({ database: { path: dbPath } });

      expect(existsSync(dbPath)).toBe(true);
    });

    it('applies schema on first init', async () => {
      await persistence.init({ database: { path: dbPath } });

      // Check trade_intents table exists
      const result = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='trade_intents'"
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('trade_intents');
    });

    it('preserves existing data on subsequent init', async () => {
      // First init and insert data
      await persistence.init({ database: { path: dbPath } });
      persistence.run(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['open_position', 'window-123', '{"test": true}', 'pending', new Date().toISOString()]
      );

      // Shutdown and reinit
      await persistence.shutdown();
      await persistence.init({ database: { path: dbPath } });

      // Data should still be there
      const rows = persistence.all('SELECT * FROM trade_intents');
      expect(rows.length).toBe(1);
      expect(rows[0].window_id).toBe('window-123');
    });

    it('is idempotent - can be called multiple times', async () => {
      await persistence.init({ database: { path: dbPath } });
      await persistence.init({ database: { path: dbPath } }); // Should not throw

      const state = persistence.getState();
      expect(state.initialized).toBe(true);
    });

    it('throws PersistenceError when path not configured', async () => {
      await expect(persistence.init({})).rejects.toThrow(PersistenceError);
      await expect(persistence.init({ database: {} })).rejects.toThrow(PersistenceError);
    });
  });

  describe('trade_intents table', () => {
    beforeEach(async () => {
      await persistence.init({ database: { path: dbPath } });
    });

    it('has all required columns', async () => {
      const result = persistence.get(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='trade_intents'"
      );

      const sql = result.sql;
      expect(sql).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
      expect(sql).toContain('intent_type TEXT NOT NULL');
      expect(sql).toContain('window_id TEXT NOT NULL');
      expect(sql).toContain('payload TEXT NOT NULL');
      expect(sql).toContain('status TEXT NOT NULL');
      expect(sql).toContain('created_at TEXT NOT NULL');
      expect(sql).toContain('completed_at TEXT');
      expect(sql).toContain('result TEXT');
    });

    it('has index on status', async () => {
      const result = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_intents_status'"
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('idx_intents_status');
    });

    it('has index on window_id', async () => {
      const result = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_intents_window'"
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('idx_intents_window');
    });

    it('enforces NOT NULL constraints', async () => {
      expect(() => {
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, created_at)
           VALUES (?, ?, ?, ?)`,
          [null, 'window-123', '{}', new Date().toISOString()]
        );
      }).toThrow();
    });

    it('enforces CHECK constraints on intent_type', async () => {
      expect(() => {
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['invalid_type', 'window-123', '{}', 'pending', new Date().toISOString()]
        );
      }).toThrow();
    });

    it('enforces CHECK constraints on status', async () => {
      expect(() => {
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['open_position', 'window-123', '{}', 'invalid_status', new Date().toISOString()]
        );
      }).toThrow();
    });

    it('accepts valid intent_type values', async () => {
      const validTypes = ['open_position', 'close_position', 'place_order', 'cancel_order'];

      for (const intentType of validTypes) {
        const result = persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [intentType, `window-${intentType}`, '{}', 'pending', new Date().toISOString()]
        );
        expect(result.lastInsertRowid).toBeGreaterThan(0);
      }
    });

    it('accepts valid status values', async () => {
      const validStatuses = ['pending', 'executing', 'completed', 'failed'];

      for (const status of validStatuses) {
        const result = persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['open_position', `window-${status}`, '{}', status, new Date().toISOString()]
        );
        expect(result.lastInsertRowid).toBeGreaterThan(0);
      }
    });
  });

  describe('query methods', () => {
    beforeEach(async () => {
      await persistence.init({ database: { path: dbPath } });
    });

    it('run() inserts and returns lastInsertRowid', async () => {
      const result = persistence.run(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['open_position', 'window-123', '{"test": true}', 'pending', new Date().toISOString()]
      );

      expect(result.lastInsertRowid).toBe(1);
      expect(result.changes).toBe(1);
    });

    it('run() updates and returns changes count', async () => {
      // Insert first
      persistence.run(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['open_position', 'window-123', '{}', 'pending', new Date().toISOString()]
      );

      // Update
      const result = persistence.run(
        `UPDATE trade_intents SET status = ? WHERE window_id = ?`,
        ['executing', 'window-123']
      );

      expect(result.changes).toBe(1);
    });

    it('get() returns single row', async () => {
      persistence.run(
        `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        ['open_position', 'window-123', '{"data": 42}', 'pending', new Date().toISOString()]
      );

      const row = persistence.get(
        'SELECT * FROM trade_intents WHERE window_id = ?',
        ['window-123']
      );

      expect(row).toBeDefined();
      expect(row.window_id).toBe('window-123');
      expect(row.intent_type).toBe('open_position');
      expect(row.payload).toBe('{"data": 42}');
    });

    it('get() returns undefined when no match', async () => {
      const row = persistence.get(
        'SELECT * FROM trade_intents WHERE window_id = ?',
        ['nonexistent']
      );

      expect(row).toBeUndefined();
    });

    it('all() returns array of rows', async () => {
      // Insert multiple rows
      for (let i = 0; i < 3; i++) {
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['open_position', `window-${i}`, '{}', 'pending', new Date().toISOString()]
        );
      }

      const rows = persistence.all('SELECT * FROM trade_intents');

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(3);
    });

    it('all() returns empty array when no matches', async () => {
      const rows = persistence.all('SELECT * FROM trade_intents WHERE status = ?', ['nonexistent']);

      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBe(0);
    });
  });

  describe('error handling', () => {
    it('throws PersistenceError on query failure', async () => {
      await persistence.init({ database: { path: dbPath } });

      expect(() => {
        persistence.run('INSERT INTO nonexistent_table (col) VALUES (?)', ['value']);
      }).toThrow(PersistenceError);
    });

    it('includes error code in thrown error', async () => {
      await persistence.init({ database: { path: dbPath } });

      try {
        persistence.run('INSERT INTO nonexistent_table (col) VALUES (?)', ['value']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PersistenceError);
        expect(error.code).toBe(ErrorCodes.DB_QUERY_FAILED);
      }
    });

    it('includes context in thrown error', async () => {
      await persistence.init({ database: { path: dbPath } });

      try {
        persistence.run('INSERT INTO nonexistent_table (col) VALUES (?)', ['value']);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error.context).toBeDefined();
        expect(error.context.sql).toContain('INSERT INTO');
      }
    });

    it('throws when querying before init', async () => {
      // Don't init - just try to query
      expect(() => {
        persistence.run('SELECT 1');
      }).toThrow(PersistenceError);
    });
  });

  describe('getState', () => {
    it('returns initialized=false before init', () => {
      const state = persistence.getState();
      expect(state.initialized).toBe(false);
    });

    it('returns initialized=true after init', async () => {
      await persistence.init({ database: { path: dbPath } });

      const state = persistence.getState();
      expect(state.initialized).toBe(true);
      expect(state.connected).toBe(true);
      expect(state.path).toBe(dbPath);
    });

    it('returns initialized=false after shutdown', async () => {
      await persistence.init({ database: { path: dbPath } });
      await persistence.shutdown();

      const state = persistence.getState();
      expect(state.initialized).toBe(false);
      expect(state.connected).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('closes database connection', async () => {
      await persistence.init({ database: { path: dbPath } });
      await persistence.shutdown();

      const state = persistence.getState();
      expect(state.connected).toBe(false);
    });

    it('is idempotent - can be called multiple times', async () => {
      await persistence.init({ database: { path: dbPath } });
      await persistence.shutdown();
      await persistence.shutdown(); // Should not throw

      const state = persistence.getState();
      expect(state.connected).toBe(false);
    });
  });

  describe('schema_migrations table', () => {
    beforeEach(async () => {
      await persistence.init({ database: { path: dbPath } });
    });

    it('exists after init', async () => {
      const result = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('schema_migrations');
    });

    it('records initial migration', async () => {
      const result = persistence.get(
        'SELECT * FROM schema_migrations WHERE version = ?',
        ['001']
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('initial-schema');
    });
  });

  describe('exec', () => {
    beforeEach(async () => {
      await persistence.init({ database: { path: dbPath } });
    });

    it('executes raw SQL statements', () => {
      persistence.exec(`
        CREATE TABLE IF NOT EXISTS test_exec_table (
          id INTEGER PRIMARY KEY,
          name TEXT
        )
      `);

      const result = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_exec_table'"
      );
      expect(result).toBeDefined();
      expect(result.name).toBe('test_exec_table');
    });

    it('executes multiple SQL statements', () => {
      persistence.exec(`
        CREATE TABLE IF NOT EXISTS test_multi_1 (id INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS test_multi_2 (id INTEGER PRIMARY KEY);
      `);

      const result1 = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_multi_1'"
      );
      const result2 = persistence.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_multi_2'"
      );

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });

    it('throws when not initialized', async () => {
      await persistence.shutdown();

      expect(() => {
        persistence.exec('CREATE TABLE test (id INTEGER)');
      }).toThrow(PersistenceError);
    });
  });

  describe('transaction', () => {
    beforeEach(async () => {
      await persistence.init({ database: { path: dbPath } });
    });

    it('commits successful transactions', () => {
      persistence.transaction(() => {
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['open_position', 'tx-test-1', '{}', 'pending', new Date().toISOString()]
        );
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['open_position', 'tx-test-2', '{}', 'pending', new Date().toISOString()]
        );
      });

      const rows = persistence.all('SELECT * FROM trade_intents WHERE window_id LIKE ?', ['tx-test-%']);
      expect(rows.length).toBe(2);
    });

    it('rolls back on error', () => {
      expect(() => {
        persistence.transaction(() => {
          persistence.run(
            `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            ['open_position', 'tx-rollback-test', '{}', 'pending', new Date().toISOString()]
          );
          // This should fail and trigger rollback
          throw new Error('Simulated failure');
        });
      }).toThrow('Simulated failure');

      const rows = persistence.all('SELECT * FROM trade_intents WHERE window_id = ?', ['tx-rollback-test']);
      expect(rows.length).toBe(0);
    });

    it('returns value from transaction function', () => {
      const result = persistence.transaction(() => {
        persistence.run(
          `INSERT INTO trade_intents (intent_type, window_id, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          ['open_position', 'tx-return-test', '{}', 'pending', new Date().toISOString()]
        );
        return 'success';
      });

      expect(result).toBe('success');
    });

    it('throws when not initialized', async () => {
      await persistence.shutdown();

      expect(() => {
        persistence.transaction(() => {});
      }).toThrow(PersistenceError);
    });
  });
});
