/**
 * State Reconciler Logic Unit Tests
 *
 * Tests for the pure logic functions in the state reconciler module.
 */

import { describe, it, expect } from 'vitest';
import { detectDivergence, buildReconciliationResult, formatDivergenceForLog } from '../logic.js';

describe('State Reconciler Logic', () => {
  describe('detectDivergence', () => {
    it('returns empty array when both arrays are empty', () => {
      const result = detectDivergence([], []);
      expect(result).toEqual([]);
    });

    it('returns empty array when states match exactly', () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },
        { id: 2, size: 200, status: 'closed' },
      ];
      const dbPositions = [
        { id: 1, size: 100, status: 'open' },
        { id: 2, size: 200, status: 'closed' },
      ];

      const result = detectDivergence(memoryPositions, dbPositions);
      expect(result).toEqual([]);
    });

    it('detects position in memory but not in DB (MEMORY_ONLY)', () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },
        { id: 2, size: 200, status: 'open' },
      ];
      const dbPositions = [
        { id: 1, size: 100, status: 'open' },
      ];

      const result = detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'MEMORY_ONLY',
        position_id: 2,
        memory_state: { id: 2, size: 200, status: 'open' },
        db_state: null,
      });
    });

    it('detects position in DB but not in memory (DB_ONLY)', () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },
      ];
      const dbPositions = [
        { id: 1, size: 100, status: 'open' },
        { id: 3, size: 300, status: 'open' },
      ];

      const result = detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'DB_ONLY',
        position_id: 3,
        memory_state: null,
        db_state: { id: 3, size: 300, status: 'open' },
      });
    });

    it('detects size mismatch (STATE_MISMATCH)', () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },
      ];
      const dbPositions = [
        { id: 1, size: 150, status: 'open' },
      ];

      const result = detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'STATE_MISMATCH',
        position_id: 1,
        field: 'size',
        memory_value: 100,
        db_value: 150,
      });
    });

    it('detects status mismatch (STATE_MISMATCH)', () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },
      ];
      const dbPositions = [
        { id: 1, size: 100, status: 'closed' },
      ];

      const result = detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'STATE_MISMATCH',
        position_id: 1,
        field: 'status',
        memory_value: 'open',
        db_value: 'closed',
      });
    });

    it('detects multiple divergence types simultaneously', () => {
      const memoryPositions = [
        { id: 1, size: 100, status: 'open' },    // size mismatch
        { id: 2, size: 200, status: 'open' },    // MEMORY_ONLY
      ];
      const dbPositions = [
        { id: 1, size: 150, status: 'open' },    // size mismatch
        { id: 3, size: 300, status: 'open' },    // DB_ONLY
      ];

      const result = detectDivergence(memoryPositions, dbPositions);

      expect(result).toHaveLength(3);

      // Size mismatch for id=1
      expect(result.find((d) => d.type === 'STATE_MISMATCH')).toBeDefined();

      // Memory only for id=2
      expect(result.find((d) => d.type === 'MEMORY_ONLY' && d.position_id === 2)).toBeDefined();

      // DB only for id=3
      expect(result.find((d) => d.type === 'DB_ONLY' && d.position_id === 3)).toBeDefined();
    });

    it('handles null memory positions', () => {
      const result = detectDivergence(null, [{ id: 1, size: 100, status: 'open' }]);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('DB_ONLY');
    });

    it('handles null db positions', () => {
      const result = detectDivergence([{ id: 1, size: 100, status: 'open' }], null);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('MEMORY_ONLY');
    });

    it('handles undefined inputs', () => {
      const result = detectDivergence(undefined, undefined);
      expect(result).toEqual([]);
    });
  });

  describe('buildReconciliationResult', () => {
    it('returns clean=true when no incomplete intents', () => {
      const startTime = Date.now();
      const result = buildReconciliationResult([], startTime);

      expect(result.clean).toBe(true);
      expect(result.incompleteCount).toBe(0);
      expect(result.incompleteIntents).toEqual([]);
      expect(result.timestamp).toBeDefined();
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('returns clean=false when incomplete intents exist', () => {
      const startTime = Date.now();
      const intents = [
        { id: 1, intent_type: 'open_position', window_id: 'w1' },
        { id: 2, intent_type: 'close_position', window_id: 'w2' },
      ];

      const result = buildReconciliationResult(intents, startTime);

      expect(result.clean).toBe(false);
      expect(result.incompleteCount).toBe(2);
      expect(result.incompleteIntents).toHaveLength(2);
    });

    it('includes valid ISO timestamp', () => {
      const startTime = Date.now();
      const result = buildReconciliationResult([], startTime);

      // ISO 8601 format: 2026-01-30T10:15:30.123Z
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('calculates duration correctly', async () => {
      const startTime = Date.now();

      // Wait a small amount
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = buildReconciliationResult([], startTime);

      expect(result.duration_ms).toBeGreaterThanOrEqual(10);
    });

    it('handles null intents array', () => {
      const startTime = Date.now();
      const result = buildReconciliationResult(null, startTime);

      expect(result.clean).toBe(true);
      expect(result.incompleteCount).toBe(0);
    });
  });

  describe('formatDivergenceForLog', () => {
    it('formats MEMORY_ONLY divergence with actionable message', () => {
      const divergence = {
        type: 'MEMORY_ONLY',
        position_id: 123,
        memory_state: { id: 123, size: 100 },
        db_state: null,
      };

      const formatted = formatDivergenceForLog(divergence);

      expect(formatted.actionable_message).toContain('123');
      expect(formatted.actionable_message).toContain('memory but not in database');
    });

    it('formats DB_ONLY divergence with actionable message', () => {
      const divergence = {
        type: 'DB_ONLY',
        position_id: 456,
        memory_state: null,
        db_state: { id: 456, size: 200 },
      };

      const formatted = formatDivergenceForLog(divergence);

      expect(formatted.actionable_message).toContain('456');
      expect(formatted.actionable_message).toContain('database but not in memory');
    });

    it('formats STATE_MISMATCH divergence with actionable message', () => {
      const divergence = {
        type: 'STATE_MISMATCH',
        position_id: 789,
        field: 'size',
        memory_value: 100,
        db_value: 150,
      };

      const formatted = formatDivergenceForLog(divergence);

      expect(formatted.actionable_message).toContain('789');
      expect(formatted.actionable_message).toContain('size');
      expect(formatted.actionable_message).toContain('100');
      expect(formatted.actionable_message).toContain('150');
    });

    it('preserves original divergence fields', () => {
      const divergence = {
        type: 'MEMORY_ONLY',
        position_id: 123,
        memory_state: { id: 123 },
        db_state: null,
      };

      const formatted = formatDivergenceForLog(divergence);

      expect(formatted.type).toBe('MEMORY_ONLY');
      expect(formatted.position_id).toBe(123);
      expect(formatted.memory_state).toEqual({ id: 123 });
      expect(formatted.db_state).toBe(null);
    });

    it('handles unknown divergence type', () => {
      const divergence = {
        type: 'UNKNOWN_TYPE',
        position_id: 999,
      };

      const formatted = formatDivergenceForLog(divergence);

      expect(formatted.actionable_message).toContain('Unknown');
      expect(formatted.actionable_message).toContain('999');
    });
  });
});
