/**
 * Write-Ahead Logging Tests
 *
 * Tests for the write-ahead logging module that ensures crash recovery
 * through intent logging before execution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('Write-Ahead Logging', () => {
  let tempDir;
  let dbPath;

  beforeEach(async () => {
    // Create temp directory for test database
    tempDir = mkdtempSync(join(tmpdir(), 'poly-wal-test-'));
    dbPath = join(tempDir, 'test.db');

    // Initialize persistence with test database
    await persistence.init({
      database: { path: dbPath },
    });
  });

  afterEach(async () => {
    // Shutdown and cleanup
    await persistence.shutdown();

    // Remove temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
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
    it('creates pending intent with correct fields', () => {
      const payload = { market_id: 'btc-usd', size: 100 };
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', payload);

      expect(intentId).toBeTypeOf('number');
      expect(intentId).toBeGreaterThan(0);

      const intent = getIntent(intentId);
      expect(intent.intent_type).toBe('open_position');
      expect(intent.window_id).toBe('window-123');
      expect(intent.status).toBe('pending');
      expect(intent.payload).toEqual(payload);
      expect(intent.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(intent.completed_at).toBeNull();
      expect(intent.result).toBeNull();
    });

    it('returns intent ID', () => {
      const id1 = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', { test: 1 });
      const id2 = logIntent(INTENT_TYPES.PLACE_ORDER, 'w2', { test: 2 });

      expect(id1).toBeTypeOf('number');
      expect(id2).toBeTypeOf('number');
      expect(id2).toBeGreaterThan(id1);
    });

    it('serializes payload to JSON', () => {
      const complexPayload = {
        nested: { deep: { value: 42 } },
        array: [1, 2, 3],
        string: 'test',
        number: 123.456,
        boolean: true,
        null: null,
      };

      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', complexPayload);
      const intent = getIntent(intentId);

      expect(intent.payload).toEqual(complexPayload);
    });

    it('throws IntentError for invalid type', () => {
      expect(() => {
        logIntent('invalid_type', 'w1', {});
      }).toThrow(IntentError);

      try {
        logIntent('bad_type', 'w1', {});
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_INTENT_TYPE);
        expect(error.context.providedType).toBe('bad_type');
        expect(error.context.validTypes).toContain('open_position');
      }
    });

    it('throws IntentError for non-serializable payload', () => {
      // Create circular reference
      const circular = { self: null };
      circular.self = circular;

      expect(() => {
        logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', circular);
      }).toThrow(IntentError);

      try {
        logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', circular);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_PAYLOAD);
      }
    });

    it('accepts all valid intent types', () => {
      Object.values(INTENT_TYPES).forEach((type) => {
        const id = logIntent(type, 'window-test', { type });
        expect(id).toBeTypeOf('number');
        expect(id).toBeGreaterThan(0);
      });
    });

    it('throws IntentError for null windowId', () => {
      expect(() => {
        logIntent(INTENT_TYPES.OPEN_POSITION, null, {});
      }).toThrow(IntentError);

      try {
        logIntent(INTENT_TYPES.OPEN_POSITION, null, {});
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_PAYLOAD);
      }
    });

    it('throws IntentError for undefined windowId', () => {
      expect(() => {
        logIntent(INTENT_TYPES.OPEN_POSITION, undefined, {});
      }).toThrow(IntentError);

      try {
        logIntent(INTENT_TYPES.OPEN_POSITION, undefined, {});
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_PAYLOAD);
      }
    });

    it('throws IntentError for empty string windowId', () => {
      expect(() => {
        logIntent(INTENT_TYPES.OPEN_POSITION, '', {});
      }).toThrow(IntentError);

      try {
        logIntent(INTENT_TYPES.OPEN_POSITION, '', {});
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_PAYLOAD);
      }
    });
  });

  describe('markExecuting', () => {
    it('transitions pending intent to executing', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', { order: 1 });

      let intent = getIntent(intentId);
      expect(intent.status).toBe('pending');

      markExecuting(intentId);

      intent = getIntent(intentId);
      expect(intent.status).toBe('executing');
    });

    it('throws if intent not found', () => {
      expect(() => {
        markExecuting(99999);
      }).toThrow(IntentError);

      try {
        markExecuting(99999);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INTENT_NOT_FOUND);
        expect(error.context.intentId).toBe(99999);
      }
    });

    it('throws if intent already executing', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);

      expect(() => {
        markExecuting(intentId);
      }).toThrow(IntentError);

      try {
        markExecuting(intentId);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('executing');
        expect(error.context.targetStatus).toBe('executing');
      }
    });

    it('throws if intent already completed', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);
      markCompleted(intentId, { success: true });

      expect(() => {
        markExecuting(intentId);
      }).toThrow(IntentError);

      try {
        markExecuting(intentId);
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('completed');
      }
    });

    it('throws if intent already failed', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);
      markFailed(intentId, { code: 'ERROR' });

      expect(() => {
        markExecuting(intentId);
      }).toThrow(IntentError);
    });
  });

  describe('markCompleted', () => {
    it('transitions executing intent to completed', () => {
      const intentId = logIntent(INTENT_TYPES.CLOSE_POSITION, 'w1', { position: 1 });
      markExecuting(intentId);

      let intent = getIntent(intentId);
      expect(intent.status).toBe('executing');

      markCompleted(intentId, { orderId: 'ord-123', price: 0.55 });

      intent = getIntent(intentId);
      expect(intent.status).toBe('completed');
    });

    it('sets completed_at timestamp', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);

      let intent = getIntent(intentId);
      expect(intent.completed_at).toBeNull();

      markCompleted(intentId, { success: true });

      intent = getIntent(intentId);
      expect(intent.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('serializes result to JSON', () => {
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', {});
      markExecuting(intentId);

      const result = {
        orderId: 'order-abc',
        fillPrice: 0.52,
        fillSize: 100,
        fees: 0.01,
      };

      markCompleted(intentId, result);

      const intent = getIntent(intentId);
      expect(intent.result).toEqual(result);
    });

    it('throws if intent not executing', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});

      // Try to complete from pending (should fail)
      expect(() => {
        markCompleted(intentId, { success: true });
      }).toThrow(IntentError);

      try {
        markCompleted(intentId, { success: true });
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('pending');
        expect(error.context.targetStatus).toBe('completed');
      }
    });

    it('throws if intent already completed', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);
      markCompleted(intentId, { first: true });

      expect(() => {
        markCompleted(intentId, { second: true });
      }).toThrow(IntentError);
    });

    it('throws if intent already failed', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);
      markFailed(intentId, { code: 'ERROR' });

      expect(() => {
        markCompleted(intentId, { success: true });
      }).toThrow(IntentError);
    });
  });

  describe('markFailed', () => {
    it('transitions executing intent to failed', () => {
      const intentId = logIntent(INTENT_TYPES.CANCEL_ORDER, 'w1', { orderId: 'x' });
      markExecuting(intentId);

      let intent = getIntent(intentId);
      expect(intent.status).toBe('executing');

      markFailed(intentId, { code: 'ORDER_NOT_FOUND', message: 'Order was already filled' });

      intent = getIntent(intentId);
      expect(intent.status).toBe('failed');
    });

    it('sets completed_at timestamp', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);

      let intent = getIntent(intentId);
      expect(intent.completed_at).toBeNull();

      markFailed(intentId, { code: 'TIMEOUT' });

      intent = getIntent(intentId);
      expect(intent.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('serializes error to JSON', () => {
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', {});
      markExecuting(intentId);

      const error = {
        code: 'INSUFFICIENT_LIQUIDITY',
        message: 'Not enough depth in orderbook',
        context: {
          requested: 100,
          available: 50,
        },
      };

      markFailed(intentId, error);

      const intent = getIntent(intentId);
      expect(intent.result).toEqual(error);
    });

    it('throws if intent not executing', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});

      // Try to fail from pending (should fail)
      expect(() => {
        markFailed(intentId, { code: 'ERROR' });
      }).toThrow(IntentError);

      try {
        markFailed(intentId, { code: 'ERROR' });
      } catch (error) {
        expect(error.code).toBe(ErrorCodes.INVALID_STATUS_TRANSITION);
        expect(error.context.currentStatus).toBe('pending');
        expect(error.context.targetStatus).toBe('failed');
      }
    });
  });

  describe('getIncompleteIntents', () => {
    it('returns only executing intents', () => {
      // Create intents in various states
      const id1 = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', { id: 1 });
      markExecuting(id1); // executing

      const id2 = logIntent(INTENT_TYPES.CLOSE_POSITION, 'w2', { id: 2 });
      markExecuting(id2);
      markCompleted(id2, { success: true }); // completed

      const id3 = logIntent(INTENT_TYPES.PLACE_ORDER, 'w3', { id: 3 });
      markExecuting(id3);
      markFailed(id3, { code: 'ERROR' }); // failed

      const id4 = logIntent(INTENT_TYPES.CANCEL_ORDER, 'w4', { id: 4 }); // pending

      const id5 = logIntent(INTENT_TYPES.OPEN_POSITION, 'w5', { id: 5 });
      markExecuting(id5); // executing

      const incomplete = getIncompleteIntents();

      expect(incomplete).toHaveLength(2);
      expect(incomplete.map((i) => i.id)).toContain(id1);
      expect(incomplete.map((i) => i.id)).toContain(id5);
      expect(incomplete.every((i) => i.status === 'executing')).toBe(true);
    });

    it('returns empty array when none executing', () => {
      // Create some non-executing intents
      // Pending intent (not executing)
      logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', {});

      // Completed intent (not executing)
      const id2 = logIntent(INTENT_TYPES.CLOSE_POSITION, 'w2', {});
      markExecuting(id2);
      markCompleted(id2, {});

      const incomplete = getIncompleteIntents();
      expect(incomplete).toHaveLength(0);
      expect(incomplete).toEqual([]);
    });

    it('deserializes payload JSON', () => {
      const payload = { market_id: 'eth-usd', amount: 50, nested: { key: 'value' } };
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', payload);
      markExecuting(intentId);

      const incomplete = getIncompleteIntents();

      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].payload).toEqual(payload);
      expect(typeof incomplete[0].payload).toBe('object');
    });
  });

  describe('getIntent', () => {
    it('returns intent by ID', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'window-abc', { size: 10 });

      const intent = getIntent(intentId);

      expect(intent).toBeDefined();
      expect(intent.id).toBe(intentId);
      expect(intent.intent_type).toBe('place_order');
      expect(intent.window_id).toBe('window-abc');
    });

    it('deserializes payload and result JSON', () => {
      const payload = { order: { side: 'buy', size: 100 } };
      const result = { orderId: 'ord-999', status: 'filled' };

      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', payload);
      markExecuting(intentId);
      markCompleted(intentId, result);

      const intent = getIntent(intentId);

      expect(intent.payload).toEqual(payload);
      expect(typeof intent.payload).toBe('object');
      expect(intent.result).toEqual(result);
      expect(typeof intent.result).toBe('object');
    });

    it('returns undefined for non-existent ID', () => {
      const intent = getIntent(99999);
      expect(intent).toBeUndefined();
    });

    it('handles null result for pending/executing intents', () => {
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', { test: true });

      let intent = getIntent(intentId);
      expect(intent.result).toBeNull();

      markExecuting(intentId);
      intent = getIntent(intentId);
      expect(intent.result).toBeNull();
    });
  });

  describe('Full lifecycle: pending → executing → completed', () => {
    it('completes the success workflow', () => {
      const payload = {
        market_id: 'btc-yes',
        side: 'buy',
        size: 50,
        price: 0.48,
      };

      // Step 1: Log intent
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-2024-01-30-10:00', payload);

      let intent = getIntent(intentId);
      expect(intent.status).toBe('pending');
      expect(intent.payload).toEqual(payload);
      expect(intent.completed_at).toBeNull();
      expect(intent.result).toBeNull();

      // Step 2: Mark executing
      markExecuting(intentId);

      intent = getIntent(intentId);
      expect(intent.status).toBe('executing');
      expect(intent.completed_at).toBeNull();
      expect(intent.result).toBeNull();

      // Verify shows up in incomplete
      let incomplete = getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).toContain(intentId);

      // Step 3: Mark completed
      const result = {
        orderId: 'poly-ord-12345',
        fillPrice: 0.485,
        fillSize: 50,
        fees: 0.005,
      };
      markCompleted(intentId, result);

      intent = getIntent(intentId);
      expect(intent.status).toBe('completed');
      expect(intent.completed_at).toBeTruthy();
      expect(intent.result).toEqual(result);

      // No longer in incomplete
      incomplete = getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).not.toContain(intentId);
    });
  });

  describe('Full lifecycle: pending → executing → failed', () => {
    it('completes the failure workflow', () => {
      const payload = {
        orderId: 'ord-to-cancel',
        reason: 'user_request',
      };

      // Step 1: Log intent
      const intentId = logIntent(INTENT_TYPES.CANCEL_ORDER, 'window-2024-01-30-10:15', payload);

      let intent = getIntent(intentId);
      expect(intent.status).toBe('pending');

      // Step 2: Mark executing
      markExecuting(intentId);

      intent = getIntent(intentId);
      expect(intent.status).toBe('executing');

      // Verify shows up in incomplete
      let incomplete = getIncompleteIntents();
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
      markFailed(intentId, error);

      intent = getIntent(intentId);
      expect(intent.status).toBe('failed');
      expect(intent.completed_at).toBeTruthy();
      expect(intent.result).toEqual(error);

      // No longer in incomplete
      incomplete = getIncompleteIntents();
      expect(incomplete.map((i) => i.id)).not.toContain(intentId);
    });
  });

  describe('Transition validation (status rules)', () => {
    it('cannot complete a pending intent (must execute first)', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});

      expect(() => {
        markCompleted(intentId, { success: true });
      }).toThrow(IntentError);

      // Verify intent is still pending
      const intent = getIntent(intentId);
      expect(intent.status).toBe('pending');
    });

    it('cannot fail a pending intent (must execute first)', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});

      expect(() => {
        markFailed(intentId, { code: 'ERROR' });
      }).toThrow(IntentError);

      // Verify intent is still pending
      const intent = getIntent(intentId);
      expect(intent.status).toBe('pending');
    });

    it('cannot transition from completed to any state', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);
      markCompleted(intentId, {});

      expect(() => markExecuting(intentId)).toThrow(IntentError);
      expect(() => markCompleted(intentId, {})).toThrow(IntentError);
      expect(() => markFailed(intentId, {})).toThrow(IntentError);
    });

    it('cannot transition from failed to any state', () => {
      const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, 'w1', {});
      markExecuting(intentId);
      markFailed(intentId, {});

      expect(() => markExecuting(intentId)).toThrow(IntentError);
      expect(() => markCompleted(intentId, {})).toThrow(IntentError);
      expect(() => markFailed(intentId, {})).toThrow(IntentError);
    });
  });
});
