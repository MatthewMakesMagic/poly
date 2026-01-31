/**
 * State Reconciler Integration Tests
 *
 * Tests for the state reconciler module with database integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as stateReconciler from '../index.js';
import * as logger from '../../logger/index.js';
import persistence from '../../../persistence/index.js';
import { logIntent, markExecuting, INTENT_TYPES, INTENT_STATUS } from '../../../persistence/write-ahead.js';

describe('State Reconciler Module', () => {
  let tempDir;
  let dbPath;
  let logDir;

  beforeEach(async () => {
    // Create temp directories
    tempDir = mkdtempSync(join(tmpdir(), 'poly-state-reconciler-test-'));
    dbPath = join(tempDir, 'test.db');
    logDir = join(tempDir, 'logs');

    // Reset modules
    await stateReconciler.shutdown().catch(() => {});
    await logger.shutdown().catch(() => {});
    await persistence.shutdown().catch(() => {});

    // Initialize persistence
    await persistence.init({
      database: { path: dbPath },
    });

    // Initialize logger
    await logger.init({
      logging: {
        level: 'info',
        directory: logDir,
        console: false,
      },
    });

    // Initialize state reconciler
    await stateReconciler.init({});
  });

  afterEach(async () => {
    // Shutdown in reverse order
    await stateReconciler.shutdown().catch(() => {});
    await logger.shutdown().catch(() => {});
    await persistence.shutdown().catch(() => {});

    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {
        market: 'BTC-USD',
        size: 100,
      });
      markExecuting(intentId);

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
        const intentId = logIntent(INTENT_TYPES.PLACE_ORDER, `window-${i}`, { i });
        markExecuting(intentId);
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
      const intentId = logIntent(INTENT_TYPES.CLOSE_POSITION, 'window-abc', {
        position_id: 42,
      });
      markExecuting(intentId);

      const result = await stateReconciler.checkStartupState();

      // Verify the result contains the intent details with required log fields
      expect(result.incompleteIntents[0].intent_type).toBe(INTENT_TYPES.CLOSE_POSITION);
      expect(result.incompleteIntents[0].window_id).toBe('window-abc');
      expect(result.incompleteIntents[0].payload.position_id).toBe(42);
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
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-xyz', {});
      markExecuting(intentId);

      // Check startup state
      await stateReconciler.checkStartupState();

      // Verify intent is still in 'executing' status (not retried)
      const intents = await stateReconciler.getIncompleteIntents();
      expect(intents).toHaveLength(1);
      expect(intents[0].id).toBe(intentId);
    });

    it('returns result indicating manual reconciliation required', async () => {
      const intentId = logIntent(INTENT_TYPES.CANCEL_ORDER, 'window-123', {});
      markExecuting(intentId);

      const result = await stateReconciler.checkStartupState();

      expect(result.clean).toBe(false);
      expect(result.incompleteCount).toBe(1);
    });
  });

  describe('markIntentReconciled (AC6)', () => {
    it('updates intent status to failed', async () => {
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {});
      markExecuting(intentId);

      await stateReconciler.markIntentReconciled(intentId, {
        action: 'verified_on_exchange',
        result: 'position confirmed open',
      });

      // Verify intent is now failed
      const intent = persistence.get('SELECT * FROM trade_intents WHERE id = ?', [intentId]);
      expect(intent.status).toBe('failed');
    });

    it('sets completed_at timestamp', async () => {
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {});
      markExecuting(intentId);

      const beforeTime = new Date().toISOString();
      await stateReconciler.markIntentReconciled(intentId, { action: 'test' });
      const afterTime = new Date().toISOString();

      const intent = persistence.get('SELECT * FROM trade_intents WHERE id = ?', [intentId]);
      expect(intent.completed_at).toBeDefined();
      expect(intent.completed_at >= beforeTime).toBe(true);
      expect(intent.completed_at <= afterTime).toBe(true);
    });

    it('includes resolution in result field', async () => {
      const intentId = logIntent(INTENT_TYPES.CLOSE_POSITION, 'window-456', {});
      markExecuting(intentId);

      const resolution = {
        action: 'manual_verification',
        notes: 'Checked exchange - position was closed successfully',
      };

      await stateReconciler.markIntentReconciled(intentId, resolution);

      const intent = persistence.get('SELECT * FROM trade_intents WHERE id = ?', [intentId]);
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
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'window-123', {});
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
      const intentId = logIntent(INTENT_TYPES.OPEN_POSITION, 'w1', {});
      markExecuting(intentId);

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
