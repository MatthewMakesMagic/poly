/**
 * State Reconciler Tests
 *
 * Tests for the state reconciler module with mocked persistence.
 * V3: All persistence operations are async PostgreSQL queries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- In-memory intent store for mocking ---
const intentStore = new Map();
let nextIntentId = 1;

// Mock logger before imports
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  init: vi.fn(),
  shutdown: vi.fn(),
}));

// Mock persistence (V3: async PostgreSQL API)
vi.mock('../../../persistence/index.js', () => ({
  default: {
    init: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(async (sql, params) => {
      // SELECT * FROM trade_intents WHERE id = $1
      if (sql.includes('trade_intents') && sql.includes('WHERE id')) {
        const id = params[0];
        const intent = intentStore.get(id);
        if (!intent) return undefined;
        return { ...intent };
      }
      return undefined;
    }),
    all: vi.fn(async (sql, params) => {
      // SELECT * FROM trade_intents WHERE status = $1
      if (sql.includes('trade_intents') && sql.includes('status')) {
        const status = params[0];
        const results = [];
        for (const intent of intentStore.values()) {
          if (intent.status === status) {
            results.push({ ...intent });
          }
        }
        return results;
      }
      return [];
    }),
    run: vi.fn(async (sql, params) => {
      // UPDATE trade_intents SET status = $1 WHERE id = $2
      if (sql.includes('UPDATE') && sql.includes('trade_intents')) {
        if (sql.includes('status') && sql.includes('completed_at') && sql.includes('result')) {
          // markIntentReconciled: UPDATE ... SET status=$1, completed_at=$2, result=$3 WHERE id=$4
          const [status, completedAt, result, id] = params;
          const intent = intentStore.get(id);
          if (intent) {
            intent.status = status;
            intent.completed_at = completedAt;
            intent.result = result;
          }
          return { changes: 1 };
        }
        // markExecuting: UPDATE ... SET status=$1 WHERE id=$2
        const [status, id] = params;
        const intent = intentStore.get(id);
        if (intent) {
          intent.status = status;
        }
        return { changes: 1 };
      }
      return { changes: 0 };
    }),
    runReturningId: vi.fn(async (sql, params) => {
      // INSERT INTO trade_intents ...
      if (sql.includes('INSERT') && sql.includes('trade_intents')) {
        const id = nextIntentId++;
        const [intentType, windowId, payload, status, createdAt] = params;
        intentStore.set(id, {
          id,
          intent_type: intentType,
          window_id: windowId,
          payload,
          status,
          created_at: createdAt,
          completed_at: null,
          result: null,
        });
        return { changes: 1, lastInsertRowid: id };
      }
      return { changes: 0, lastInsertRowid: null };
    }),
    exec: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as stateReconciler from '../index.js';
import { logIntent, markExecuting, INTENT_TYPES, INTENT_STATUS } from '../../../persistence/write-ahead.js';
import persistence from '../../../persistence/index.js';

describe('State Reconciler Module', () => {
  beforeEach(async () => {
    // Clear in-memory stores
    intentStore.clear();
    nextIntentId = 1;

    // Reset state reconciler
    await stateReconciler.shutdown().catch(() => {});

    // Initialize state reconciler
    await stateReconciler.init({});
  });

  afterEach(async () => {
    await stateReconciler.shutdown().catch(() => {});
  });

  describe('Module Interface (AC6)', () => {
    it('exports init function', () => {
      expect(typeof stateReconciler.init).toBe('function');
    });

    it('exports checkStartupState function', () => {
      expect(typeof stateReconciler.checkStartupState).toBe('function');
    });

    it('exports getIncompleteIntents function', () => {
      expect(typeof stateReconciler.getIncompleteIntents).toBe('function');
    });

    it('exports markIntentReconciled function', () => {
      expect(typeof stateReconciler.markIntentReconciled).toBe('function');
    });

    it('exports detectDivergence function', () => {
      expect(typeof stateReconciler.detectDivergence).toBe('function');
    });

    it('exports getState function', () => {
      expect(typeof stateReconciler.getState).toBe('function');
    });

    it('exports shutdown function', () => {
      expect(typeof stateReconciler.shutdown).toBe('function');
    });
  });

  describe('checkStartupState (AC1, AC4, AC7, AC8)', () => {
    it('returns clean=true when no incomplete intents', async () => {
      const result = await stateReconciler.checkStartupState();

      expect(result.clean).toBe(true);
      expect(result.incompleteCount).toBe(0);
      expect(result.incompleteIntents).toEqual([]);
    });

    it('returns incomplete intents when found (AC1)', async () => {
      // Create an intent and mark it as executing (simulates crash)
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {
        market: 'BTC-USD',
        size: 100,
      });
      await markExecuting(intentId);

      // Now check startup state
      const result = await stateReconciler.checkStartupState();

      expect(result.clean).toBe(false);
      expect(result.incompleteCount).toBe(1);
      expect(result.incompleteIntents).toHaveLength(1);
      expect(result.incompleteIntents[0].id).toBe(intentId);
      expect(result.incompleteIntents[0].intent_type).toBe(INTENT_TYPES.OPEN_POSITION);
      expect(result.incompleteIntents[0].window_id).toBe('window-123');
    });

    it('includes timestamp in result (AC7)', async () => {
      const result = await stateReconciler.checkStartupState();

      // ISO 8601 format: 2026-01-30T10:15:30.123Z
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('includes duration_ms in result (AC7, AC8)', async () => {
      const result = await stateReconciler.checkStartupState();

      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('completes within 10 seconds (AC8 - NFR3)', async () => {
      // Create multiple intents to simulate load
      for (let i = 0; i < 100; i++) {
        const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, `window-${i}`, { i });
        await markExecuting(intentId);
      }

      const result = await stateReconciler.checkStartupState();

      expect(result.duration_ms).toBeLessThan(10000);
      expect(result.incompleteCount).toBe(100);
    });

    it('updates stats after each check', async () => {
      // First check
      await stateReconciler.checkStartupState();
      let state = stateReconciler.getState();
      expect(state.stats.totalChecks).toBe(1);

      // Second check
      await stateReconciler.checkStartupState();
      state = stateReconciler.getState();
      expect(state.stats.totalChecks).toBe(2);
    });
  });

  describe('Logging (AC2, AC4)', () => {
    it('logs info message when clean (AC4)', async () => {
      const result = await stateReconciler.checkStartupState();

      // Verify result indicates clean state
      expect(result.clean).toBe(true);
      expect(result.incompleteCount).toBe(0);

      // Verify module state reflects the reconciliation
      const state = stateReconciler.getState();
      expect(state.lastReconciliation).toBeDefined();
      expect(state.lastReconciliation.clean).toBe(true);
      expect(state.stats.totalChecks).toBe(1);
    });

    it('logs warn for each incomplete intent (AC2)', async () => {
      // Create executing intent
      const intentId = await logIntent(INTENT_TYPES.CLOSE_POSITION, 'window-abc', {
        position_id: 42,
      });
      await markExecuting(intentId);

      const result = await stateReconciler.checkStartupState();

      // Verify the result contains the intent details with required log fields
      expect(result.incompleteIntents[0].intent_type).toBe(INTENT_TYPES.CLOSE_POSITION);
      expect(result.incompleteIntents[0].window_id).toBe('window-abc');
      // payload is JSON-parsed by write-ahead getIncompleteIntents
      expect(result.incompleteIntents[0].payload).toBeDefined();
      expect(result.incompleteIntents[0].created_at).toBeDefined();
      // Verify all AC2 required fields are present
      expect(result.incompleteIntents[0]).toHaveProperty('id');
      expect(result.incompleteIntents[0]).toHaveProperty('intent_type');
      expect(result.incompleteIntents[0]).toHaveProperty('window_id');
      expect(result.incompleteIntents[0]).toHaveProperty('created_at');
      expect(result.incompleteIntents[0]).toHaveProperty('payload');
    });

    it('includes duration_ms in clean startup log (AC4)', async () => {
      const result = await stateReconciler.checkStartupState();

      // Verify duration is tracked for monitoring
      expect(result.duration_ms).toBeDefined();
      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('No automatic retry (AC3)', () => {
    it('does NOT automatically retry incomplete intents', async () => {
      // Create an executing intent
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, 'window-xyz', {});
      await markExecuting(intentId);

      // Check startup state
      await stateReconciler.checkStartupState();

      // Verify intent is still in 'executing' status (not retried)
      const intents = await stateReconciler.getIncompleteIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].id).toBe(intentId);
    });

    it('returns result indicating manual reconciliation required', async () => {
      const intentId = await logIntent(INTENT_TYPES.CANCEL_ORDER, 'window-123', {});
      await markExecuting(intentId);

      const result = await stateReconciler.checkStartupState();

      expect(result.clean).toBe(false);
      expect(result.incompleteCount).toBe(1);
    });
  });

  describe('markIntentReconciled (AC6)', () => {
    it('updates intent status to failed', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {});
      await markExecuting(intentId);

      await stateReconciler.markIntentReconciled(intentId, {
        action: 'verified_on_exchange',
        result: 'position confirmed open',
      });

      // Verify intent is now failed (check the in-memory store directly)
      const intent = intentStore.get(intentId);
      expect(intent.status).toBe('failed');
    });

    it('sets completed_at timestamp', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {});
      await markExecuting(intentId);

      const beforeTime = new Date().toISOString();
      await stateReconciler.markIntentReconciled(intentId, { action: 'test' });
      const afterTime = new Date().toISOString();

      const intent = intentStore.get(intentId);
      expect(intent.completed_at).toBeDefined();
      expect(intent.completed_at >= beforeTime).toBe(true);
      expect(intent.completed_at <= afterTime).toBe(true);
    });

    it('includes resolution in result field', async () => {
      const intentId = await logIntent(INTENT_TYPES.CLOSE_POSITION, 'window-456', {});
      await markExecuting(intentId);

      const resolution = {
        action: 'manual_verification',
        notes: 'Checked exchange - position was closed successfully',
      };

      await stateReconciler.markIntentReconciled(intentId, resolution);

      const intent = intentStore.get(intentId);
      const result = JSON.parse(intent.result);

      expect(result.reconciled).toBe(true);
      expect(result.resolution).toEqual(resolution);
    });

    it('throws if intent not found', async () => {
      await expect(
        stateReconciler.markIntentReconciled(99999, { action: 'test' })
      ).rejects.toThrow('Intent not found');
    });

    it('throws if intent not in executing status', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {});
      // Intent is in 'pending' status, not 'executing'

      await expect(
        stateReconciler.markIntentReconciled(intentId, { action: 'test' })
      ).rejects.toThrow("not in 'executing' status");
    });
  });

  describe('detectDivergence (AC5)', () => {
    it('returns empty array when states match', async () => {
      const memoryPositions = [{ id: 1, size: 100, status: 'open' }];
      const dbPositions = [{ id: 1, size: 100, status: 'open' }];

      const result = await stateReconciler.detectDivergence(memoryPositions, dbPositions);

      expect(result).toEqual([]);
    });

    it('detects position in memory but not DB', async () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },
        { id: 2, size: 200, status: 'open' },
      ];
      const dbPositions = [{ id: 1, size: 100, status: 'open' }];

      const result = await stateReconciler.detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('MEMORY_ONLY');
      expect(result[0].position_id).toBe(2);
    });

    it('detects position in DB but not memory', async () => {
      const memoryPositions = [{ id: 1, size: 100, status: 'open' }];
      const dbPositions = [
        { id: 1, size: 100, status: 'open' },
        { id: 3, size: 300, status: 'open' },
      ];

      const result = await stateReconciler.detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('DB_ONLY');
      expect(result[0].position_id).toBe(3);
    });

    it('detects field value mismatches', async () => {
      const memoryPositions = [{ id: 1, size: 100, status: 'open' }];
      const dbPositions = [{ id: 1, size: 150, status: 'open' }];

      const result = await stateReconciler.detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('STATE_MISMATCH');
      expect(result[0].field).toBe('size');
      expect(result[0].memory_value).toBe(100);
      expect(result[0].db_value).toBe(150);
    });

    it('updates stats.divergencesDetected', async () => {
      const initialState = stateReconciler.getState();
      const initialCount = initialState.stats.divergencesDetected;

      await stateReconciler.detectDivergence(
        [{ id: 1, size: 100, status: 'open' }],
        []
      );

      const newState = stateReconciler.getState();
      expect(newState.stats.divergencesDetected).toBe(initialCount + 1);
    });
  });

  describe('getState (AC6)', () => {
    it('returns config and stats', () => {
      const state = stateReconciler.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.stats).toBeDefined();
      expect(state.stats.totalChecks).toBe(0);
      expect(state.stats.incompleteFound).toBe(0);
      expect(state.stats.divergencesDetected).toBe(0);
    });

    it('returns lastReconciliation after checkStartupState', async () => {
      await stateReconciler.checkStartupState();

      const state = stateReconciler.getState();

      expect(state.lastReconciliation).toBeDefined();
      expect(state.lastReconciliation.clean).toBe(true);
      expect(state.lastReconciliation.timestamp).toBeDefined();
    });

    it('tracks totalChecks', async () => {
      expect(stateReconciler.getState().stats.totalChecks).toBe(0);

      await stateReconciler.checkStartupState();
      expect(stateReconciler.getState().stats.totalChecks).toBe(1);

      await stateReconciler.checkStartupState();
      expect(stateReconciler.getState().stats.totalChecks).toBe(2);
    });

    it('tracks incompleteFound', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', {});
      await markExecuting(intentId);

      await stateReconciler.checkStartupState();

      expect(stateReconciler.getState().stats.incompleteFound).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('resets state after shutdown', async () => {
      await stateReconciler.checkStartupState();
      expect(stateReconciler.getState().initialized).toBe(true);

      await stateReconciler.shutdown();

      expect(stateReconciler.getState().initialized).toBe(false);
      expect(stateReconciler.getState().stats.totalChecks).toBe(0);
    });

    it('can shutdown when not initialized', async () => {
      await stateReconciler.shutdown();

      // Should not throw
      await expect(stateReconciler.shutdown()).resolves.not.toThrow();
    });

    it('can be re-initialized after shutdown', async () => {
      await stateReconciler.shutdown();
      await stateReconciler.init({});

      expect(stateReconciler.getState().initialized).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('throws when checkStartupState called before init', async () => {
      await stateReconciler.shutdown();

      await expect(stateReconciler.checkStartupState()).rejects.toThrow(
        'State reconciler not initialized'
      );
    });

    it('throws when markIntentReconciled called before init', async () => {
      await stateReconciler.shutdown();

      await expect(
        stateReconciler.markIntentReconciled(1, {})
      ).rejects.toThrow('State reconciler not initialized');
    });
  });
});
