/**
 * Write-Ahead Logging Tests
 *
 * Tests for the write-ahead logging module that ensures crash recovery
 * through intent logging before execution.
 *
 * V3 Philosophy Implementation - Stage 2: PostgreSQL Foundation
 * All operations are now async.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import persistence from '../index.js';
import {
  logIntent,
  markExecuting,
  markCompleted,
  markFailed,
  getIncompleteIntents,
  getIntent,
  INTENT_TYPES,
  INTENT_STATUS,
} from '../write-ahead.js';
import { IntentError, ErrorCodes } from '../../types/errors.js';

// Use test database URL or skip tests
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Skip all tests if no database URL configured
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

// Increase timeout for slow Supabase connections
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

// Counter for unique window IDs
let testCounter = 0;

/**
 * Generate a unique window ID for each test invocation
 */
function uniqueWindowId(suffix = '') {
  testCounter++;
  const timestamp = Date.now();
  return `wal-test-${timestamp}-${testCounter}${suffix ? `-${suffix}` : ''}`;
}

describeIfDb('Write-Ahead Logging', () => {
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
    // Clean up test data
    if (persistence.getState().initialized) {
      await persistence.run(
        "DELETE FROM trade_intents WHERE window_id LIKE $1",
        ['wal-test-%']
      );
      await persistence.shutdown();
    }
  });

  describe('INTENT_TYPES', () => {
    it('exports all required intent types', () => {
      expect(INTENT_TYPES.OPEN_POSITION).toBe('open_position');
      expect(INTENT_TYPES.CLOSE_POSITION).toBe('close_position');
      expect(INTENT_TYPES.PLACE_ORDER).toBe('place_order');
      expect(INTENT_TYPES.CANCEL_ORDER).toBe('cancel_order');
    });
  });

  describe('INTENT_STATUS', () => {
    it('exports all required status values', () => {
      expect(INTENT_STATUS.PENDING).toBe('pending');
      expect(INTENT_STATUS.EXECUTING).toBe('executing');
      expect(INTENT_STATUS.COMPLETED).toBe('completed');
      expect(INTENT_STATUS.FAILED).toBe('failed');
    });
  });

  describe('logIntent', () => {
    it('creates pending intent with correct fields', async () => {
      const windowId = uniqueWindowId('create');
      const payload = { market_id: 'btc-usd', size: 100 };
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, windowId, payload);

      expect(intentId).toBeTypeOf('number');
      expect(intentId).toBeGreaterThan(0);

      const intent = await getIntent(intentId);
      expect(intent.intent_type).toBe('open_position');
      expect(intent.window_id).toBe(windowId);
      expect(intent.status).toBe('pending');
      expect(intent.payload).toEqual(payload);
      expect(intent.created_at).toBeDefined();
      expect(intent.completed_at).toBeNull();
      expect(intent.result).toBeNull();
    });

    it('returns intent ID', async () => {
      const id1 = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId('id1'), { test: 1 });
      const id2 = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId('id2'), { test: 2 });

      expect(id1).toBeTypeOf('number');
      expect(id2).toBeTypeOf('number');
      expect(id2).toBeGreaterThan(id1);
    });

    it('serializes payload to JSON', async () => {
      const complexPayload = {
        nested: { deep: { value: 42 } },
        array: [1, 2, 3],
        string: 'test',
        number: 123.456,
        boolean: true,
        null: null,
      };

      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, uniqueWindowId('json'), complexPayload);
      const intent = await getIntent(intentId);

      expect(intent.payload).toEqual(complexPayload);
    });

    it('throws IntentError for invalid type', async () => {
      await expect(logIntent('invalid_type', uniqueWindowId(), {})).rejects.toThrow(IntentError);

      try {
        await logIntent('bad_type', uniqueWindowId(), {});
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_INTENT_TYPE);
        expect(error.context.providedType).toBe('bad_type');
        expect(error.context.validTypes).toContain('open_position');
      }
    });

    it('throws IntentError for non-serializable payload', async () => {
      const circular = { self: null };
      circular.self = circular;

      await expect(logIntent(INTENT_TYPES.OPEN_POSITION, uniqueWindowId(), circular)).rejects.toThrow(IntentError);
    });

    it('accepts all valid intent types', async () => {
      for (const type of Object.values(INTENT_TYPES)) {
        const id = await logIntent(type, uniqueWindowId(type), { type });
        expect(id).toBeTypeOf('number');
        expect(id).toBeGreaterThan(0);
      }
    });

    it('throws IntentError for null windowId', async () => {
      await expect(logIntent(INTENT_TYPES.OPEN_POSITION, null, {})).rejects.toThrow(IntentError);
    });

    it('throws IntentError for undefined windowId', async () => {
      await expect(logIntent(INTENT_TYPES.OPEN_POSITION, undefined, {})).rejects.toThrow(IntentError);
    });

    it('throws IntentError for empty string windowId', async () => {
      await expect(logIntent(INTENT_TYPES.OPEN_POSITION, '', {})).rejects.toThrow(IntentError);
    });
  });

  describe('markExecuting', () => {
    it('transitions pending intent to executing', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), { order: 1 });

      let intent = await getIntent(intentId);
      expect(intent.status).toBe('pending');

      await markExecuting(intentId);

      intent = await getIntent(intentId);
      expect(intent.status).toBe('executing');
    });

    it('throws if intent not found', async () => {
      await expect(markExecuting(99999)).rejects.toThrow(IntentError);

      try {
        await markExecuting(99999);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INTENT_NOT_FOUND);
        expect(error.context.intentId).toBe(99999);
      }
    });

    it('throws if intent already executing', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);

      await expect(markExecuting(intentId)).rejects.toThrow(IntentError);

      try {
        await markExecuting(intentId);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('executing');
        expect(error.context.targetStatus).toBe('executing');
      }
    });

    it('throws if intent already completed', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);
      await markCompleted(intentId, { success: true });

      await expect(markExecuting(intentId)).rejects.toThrow(IntentError);

      try {
        await markExecuting(intentId);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('completed');
      }
    });

    it('throws if intent already failed', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);
      await markFailed(intentId, { code: 'ERROR' });

      await expect(markExecuting(intentId)).rejects.toThrow(IntentError);
    });
  });

  describe('markCompleted', () => {
    it('transitions executing intent to completed', async () => {
      const intentId = await logIntent(INTENT_TYPES.CLOSE_POSITION, uniqueWindowId(), { position: 1 });
      await markExecuting(intentId);

      let intent = await getIntent(intentId);
      expect(intent.status).toBe('executing');

      await markCompleted(intentId, { orderId: 'ord-123', price: 0.55 });

      intent = await getIntent(intentId);
      expect(intent.status).toBe('completed');
    });

    it('sets completed_at timestamp', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);

      let intent = await getIntent(intentId);
      expect(intent.completed_at).toBeNull();

      await markCompleted(intentId, { success: true });

      intent = await getIntent(intentId);
      expect(intent.completed_at).toBeDefined();
    });

    it('serializes result to JSON', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, uniqueWindowId(), {});
      await markExecuting(intentId);

      const result = {
        orderId: 'order-abc',
        fillPrice: 0.52,
        fillSize: 100,
        fees: 0.01,
      };

      await markCompleted(intentId, result);

      const intent = await getIntent(intentId);
      expect(intent.result).toEqual(result);
    });

    it('throws if intent not executing', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});

      await expect(markCompleted(intentId, { success: true })).rejects.toThrow(IntentError);

      try {
        await markCompleted(intentId, { success: true });
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('pending');
        expect(error.context.targetStatus).toBe('completed');
      }
    });

    it('throws if intent already completed', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);
      await markCompleted(intentId, { first: true });

      await expect(markCompleted(intentId, { second: true })).rejects.toThrow(IntentError);
    });

    it('throws if intent already failed', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);
      await markFailed(intentId, { code: 'ERROR' });

      await expect(markCompleted(intentId, { success: true })).rejects.toThrow(IntentError);
    });
  });

  describe('markFailed', () => {
    it('transitions executing intent to failed', async () => {
      const intentId = await logIntent(INTENT_TYPES.CANCEL_ORDER, uniqueWindowId(), { orderId: 'x' });
      await markExecuting(intentId);

      let intent = await getIntent(intentId);
      expect(intent.status).toBe('executing');

      await markFailed(intentId, { code: 'ORDER_NOT_FOUND', message: 'Order was already filled' });

      intent = await getIntent(intentId);
      expect(intent.status).toBe('failed');
    });

    it('sets completed_at timestamp', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);

      let intent = await getIntent(intentId);
      expect(intent.completed_at).toBeNull();

      await markFailed(intentId, { code: 'TIMEOUT' });

      intent = await getIntent(intentId);
      expect(intent.completed_at).toBeDefined();
    });

    it('serializes error to JSON', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, uniqueWindowId(), {});
      await markExecuting(intentId);

      const error = {
        code: 'INSUFFICIENT_LIQUIDITY',
        message: 'Not enough depth in orderbook',
        context: {
          requested: 100,
          available: 50,
        },
      };

      await markFailed(intentId, error);

      const intent = await getIntent(intentId);
      expect(intent.result).toEqual(error);
    });

    it('throws if intent not executing', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});

      await expect(markFailed(intentId, { code: 'ERROR' })).rejects.toThrow(IntentError);

      try {
        await markFailed(intentId, { code: 'ERROR' });
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('pending');
        expect(error.context.targetStatus).toBe('failed');
      }
    });
  });

  describe('getIncompleteIntents', () => {
    it('returns executing intents', async () => {
      const windowPrefix = uniqueWindowId('incomplete');

      // Create intents in various states
      const id1 = await logIntent(INTENT_TYPES.OPEN_POSITION, `${windowPrefix}-1`, { id: 1 });
      await markExecuting(id1); // executing

      const id2 = await logIntent(INTENT_TYPES.CLOSE_POSITION, `${windowPrefix}-2`, { id: 2 });
      await markExecuting(id2);
      await markCompleted(id2, { success: true }); // completed

      const id3 = await logIntent(INTENT_TYPES.PLACE_ORDER, `${windowPrefix}-3`, { id: 3 });
      await markExecuting(id3);
      await markFailed(id3, { code: 'ERROR' }); // failed

      await logIntent(INTENT_TYPES.CANCEL_ORDER, `${windowPrefix}-4`, { id: 4 }); // pending

      const id5 = await logIntent(INTENT_TYPES.OPEN_POSITION, `${windowPrefix}-5`, { id: 5 });
      await markExecuting(id5); // executing

      const incomplete = await getIncompleteIntents();

      // Filter to only our test intents
      const testIncomplete = incomplete.filter(i => i.window_id.startsWith(windowPrefix));
      expect(testIncomplete).toHaveLength(2);
      expect(testIncomplete.map((i) => i.id)).toContain(id1);
      expect(testIncomplete.map((i) => i.id)).toContain(id5);
      expect(testIncomplete.every((i) => i.status === 'executing')).toBe(true);
    });

    it('deserializes payload JSON', async () => {
      const payload = { market_id: 'eth-usd', amount: 50, nested: { key: 'value' } };
      const windowId = uniqueWindowId('deserialize');
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, windowId, payload);
      await markExecuting(intentId);

      const incomplete = await getIncompleteIntents();
      const testIntent = incomplete.find(i => i.id === intentId);

      expect(testIntent).toBeDefined();
      expect(testIntent.payload).toEqual(payload);
      expect(typeof testIntent.payload).toBe('object');
    });
  });

  describe('getIntent', () => {
    it('returns intent by ID', async () => {
      const windowId = uniqueWindowId('getbyid');
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, windowId, { size: 10 });

      const intent = await getIntent(intentId);

      expect(intent).toBeDefined();
      expect(intent.id).toBe(intentId);
      expect(intent.intent_type).toBe('place_order');
      expect(intent.window_id).toBe(windowId);
    });

    it('deserializes payload and result JSON', async () => {
      const payload = { order: { side: 'buy', size: 100 } };
      const result = { orderId: 'ord-999', status: 'filled' };

      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), payload);
      await markExecuting(intentId);
      await markCompleted(intentId, result);

      const intent = await getIntent(intentId);

      expect(intent.payload).toEqual(payload);
      expect(typeof intent.payload).toBe('object');
      expect(intent.result).toEqual(result);
      expect(typeof intent.result).toBe('object');
    });

    it('returns undefined for non-existent ID', async () => {
      const intent = await getIntent(99999);
      expect(intent).toBeUndefined();
    });

    it('handles null result for pending/executing intents', async () => {
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, uniqueWindowId(), { test: true });

      let intent = await getIntent(intentId);
      expect(intent.result).toBeNull();

      await markExecuting(intentId);
      intent = await getIntent(intentId);
      expect(intent.result).toBeNull();
    });
  });

  describe('Full lifecycle: pending -> executing -> completed', () => {
    it('completes the success workflow', async () => {
      const windowId = uniqueWindowId('lifecycle-success');
      const payload = {
        market_id: 'btc-yes',
        side: 'buy',
        size: 50,
        price: 0.48,
      };

      // Step 1: Log intent
      const intentId = await logIntent(INTENT_TYPES.OPEN_POSITION, windowId, payload);

      let intent = await getIntent(intentId);
      expect(intent.status).toBe('pending');
      expect(intent.payload).toEqual(payload);
      expect(intent.completed_at).toBeNull();
      expect(intent.result).toBeNull();

      // Step 2: Mark executing
      await markExecuting(intentId);

      intent = await getIntent(intentId);
      expect(intent.status).toBe('executing');
      expect(intent.completed_at).toBeNull();
      expect(intent.result).toBeNull();

      // Verify shows up in incomplete
      let incomplete = await getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).toContain(intentId);

      // Step 3: Mark completed
      const result = {
        orderId: 'poly-ord-12345',
        fillPrice: 0.485,
        fillSize: 50,
        fees: 0.005,
      };
      await markCompleted(intentId, result);

      intent = await getIntent(intentId);
      expect(intent.status).toBe('completed');
      expect(intent.completed_at).toBeTruthy();
      expect(intent.result).toEqual(result);

      // No longer in incomplete
      incomplete = await getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).not.toContain(intentId);
    });
  });

  describe('Full lifecycle: pending -> executing -> failed', () => {
    it('completes the failure workflow', async () => {
      const windowId = uniqueWindowId('lifecycle-failure');
      const payload = {
        orderId: 'ord-to-cancel',
        reason: 'user_request',
      };

      // Step 1: Log intent
      const intentId = await logIntent(INTENT_TYPES.CANCEL_ORDER, windowId, payload);

      let intent = await getIntent(intentId);
      expect(intent.status).toBe('pending');

      // Step 2: Mark executing
      await markExecuting(intentId);

      intent = await getIntent(intentId);
      expect(intent.status).toBe('executing');

      // Verify shows up in incomplete
      let incomplete = await getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).toContain(intentId);

      // Step 3: Mark failed
      const error = {
        code: 'ORDER_ALREADY_FILLED',
        message: 'Cannot cancel: order was already filled',
        context: {
          orderId: 'ord-to-cancel',
          fillTime: '2024-01-30T10:14:55Z',
        },
      };
      await markFailed(intentId, error);

      intent = await getIntent(intentId);
      expect(intent.status).toBe('failed');
      expect(intent.completed_at).toBeTruthy();
      expect(intent.result).toEqual(error);

      // No longer in incomplete
      incomplete = await getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).not.toContain(intentId);
    });
  });

  describe('Transition validation (status rules)', () => {
    it('cannot complete a pending intent (must execute first)', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});

      await expect(markCompleted(intentId, { success: true })).rejects.toThrow(IntentError);

      // Verify intent is still pending
      const intent = await getIntent(intentId);
      expect(intent.status).toBe('pending');
    });

    it('cannot fail a pending intent (must execute first)', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});

      await expect(markFailed(intentId, { code: 'ERROR' })).rejects.toThrow(IntentError);

      // Verify intent is still pending
      const intent = await getIntent(intentId);
      expect(intent.status).toBe('pending');
    });

    it('cannot transition from completed to any state', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);
      await markCompleted(intentId, {});

      await expect(markExecuting(intentId)).rejects.toThrow(IntentError);
      await expect(markCompleted(intentId, {})).rejects.toThrow(IntentError);
      await expect(markFailed(intentId, {})).rejects.toThrow(IntentError);
    });

    it('cannot transition from failed to any state', async () => {
      const intentId = await logIntent(INTENT_TYPES.PLACE_ORDER, uniqueWindowId(), {});
      await markExecuting(intentId);
      await markFailed(intentId, {});

      await expect(markExecuting(intentId)).rejects.toThrow(IntentError);
      await expect(markCompleted(intentId, {})).rejects.toThrow(IntentError);
      await expect(markFailed(intentId, {})).rejects.toThrow(IntentError);
    });
  });
});
