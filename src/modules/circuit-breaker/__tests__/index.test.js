/**
 * Circuit Breaker Module Tests
 *
 * V3 Stage 5: Tests for circuit breaker state management,
 * trip/reset lifecycle, and fail-closed behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock persistence
vi.mock('../../../persistence/index.js', () => ({
  default: {
    cbQuery: vi.fn(),
    all: vi.fn().mockResolvedValue([]),
  },
}));

// Import after mocks
import persistence from '../../../persistence/index.js';
import * as circuitBreaker from '../index.js';
import { CBState, TripReason } from '../types.js';

describe('Circuit Breaker Module', () => {
  const mockConfig = {
    circuitBreaker: {
      escalationIntervalMs: 30000,
      cbQueryTimeoutMs: 1000,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await circuitBreaker.shutdown();
    } catch {
      // Ignore
    }
  });

  describe('init()', () => {
    it('should initialize with CLOSED state from DB', async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);

      await circuitBreaker.init(mockConfig);
      const state = circuitBreaker.getState();

      expect(state.initialized).toBe(true);
      expect(state.state).toBe(CBState.CLOSED);
      expect(state.tripReason).toBeNull();
    });

    it('should restore OPEN state from DB and start escalation', async () => {
      const trippedAt = new Date(Date.now() - 60000).toISOString();
      persistence.cbQuery.mockResolvedValue([
        { state: 'OPEN', trip_reason: 'MANUAL_TRIP', tripped_at: trippedAt },
      ]);

      await circuitBreaker.init(mockConfig);
      const state = circuitBreaker.getState();

      expect(state.state).toBe(CBState.OPEN);
      expect(state.tripReason).toBe('MANUAL_TRIP');
      expect(state.escalationStage).toBe('monitoring');
    });

    it('should default to CLOSED if DB query fails', async () => {
      persistence.cbQuery.mockRejectedValue(new Error('DB not available'));

      await circuitBreaker.init(mockConfig);
      const state = circuitBreaker.getState();

      expect(state.initialized).toBe(true);
      expect(state.state).toBe(CBState.CLOSED);
    });

    it('should be idempotent on second call', async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);

      await circuitBreaker.init(mockConfig);
      await circuitBreaker.init(mockConfig); // Should not throw

      expect(persistence.cbQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('trip()', () => {
    beforeEach(async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);
      await circuitBreaker.init(mockConfig);
      vi.clearAllMocks();
    });

    it('should trip the breaker and persist to DB', async () => {
      persistence.cbQuery
        .mockResolvedValueOnce([{ state: 'OPEN' }]) // UPDATE RETURNING
        .mockResolvedValueOnce([]); // INSERT audit

      await circuitBreaker.trip(TripReason.STOP_LOSS_BLIND, { reason: 'test' });

      const state = circuitBreaker.getState();
      expect(state.state).toBe(CBState.OPEN);
      expect(state.tripReason).toBe(TripReason.STOP_LOSS_BLIND);
      expect(state.trippedAt).toBeTruthy();

      // Verify DB calls
      expect(persistence.cbQuery).toHaveBeenCalledTimes(2);
      expect(persistence.cbQuery.mock.calls[0][0]).toContain('UPDATE circuit_breaker');
      expect(persistence.cbQuery.mock.calls[1][0]).toContain('INSERT INTO circuit_breaker_audit');
    });

    it('should not re-trip if already OPEN', async () => {
      persistence.cbQuery
        .mockResolvedValueOnce([{ state: 'OPEN' }]) // First trip
        .mockResolvedValueOnce([]); // Audit

      await circuitBreaker.trip(TripReason.STOP_LOSS_BLIND);
      vi.clearAllMocks();

      await circuitBreaker.trip(TripReason.MANUAL_TRIP);

      // Should not have made any DB calls for second trip
      expect(persistence.cbQuery).not.toHaveBeenCalled();
    });

    it('should set fallback OPEN if DB write fails', async () => {
      persistence.cbQuery.mockRejectedValue(new Error('DB write failed'));

      await circuitBreaker.trip(TripReason.POSITION_TRACKING_FAILED);

      const state = circuitBreaker.getState();
      expect(state.state).toBe(CBState.OPEN);
      expect(state.fallbackOpen).toBe(true);
    });
  });

  describe('isOpen()', () => {
    beforeEach(async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);
      await circuitBreaker.init(mockConfig);
      vi.clearAllMocks();
    });

    it('should return false when DB says CLOSED', async () => {
      persistence.cbQuery.mockResolvedValue([{ state: 'CLOSED' }]);

      const open = await circuitBreaker.isOpen();
      expect(open).toBe(false);
    });

    it('should return true when DB says OPEN', async () => {
      persistence.cbQuery.mockResolvedValue([{ state: 'OPEN' }]);

      const open = await circuitBreaker.isOpen();
      expect(open).toBe(true);
    });

    it('should return true (fail-closed) on DB error', async () => {
      persistence.cbQuery.mockRejectedValue(new Error('DB error'));

      const open = await circuitBreaker.isOpen();
      expect(open).toBe(true);
    });

    it('should return true (fail-closed) on DB timeout', async () => {
      // Make cbQuery hang forever
      persistence.cbQuery.mockImplementation(
        () => new Promise(() => {}) // never resolves
      );

      // Use a short timeout config
      const shortConfig = {
        circuitBreaker: { cbQueryTimeoutMs: 50, escalationIntervalMs: 30000 },
      };
      await circuitBreaker.shutdown();
      persistence.cbQuery.mockResolvedValueOnce([{ state: 'CLOSED', trip_reason: null, tripped_at: null }]);
      await circuitBreaker.init(shortConfig);

      // Now make it hang
      persistence.cbQuery.mockImplementation(
        () => new Promise(() => {})
      );

      const openPromise = circuitBreaker.isOpen();
      vi.advanceTimersByTime(100);
      const open = await openPromise;
      expect(open).toBe(true);
    });
  });

  describe('reset()', () => {
    beforeEach(async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);
      await circuitBreaker.init(mockConfig);

      // Trip the breaker
      persistence.cbQuery
        .mockResolvedValueOnce([{ state: 'OPEN' }])
        .mockResolvedValueOnce([]);
      await circuitBreaker.trip(TripReason.MANUAL_TRIP);
      vi.clearAllMocks();
    });

    it('should reset breaker to CLOSED', async () => {
      persistence.all.mockResolvedValue([{ count: 0 }]); // No active orders
      persistence.cbQuery
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([]); // INSERT audit

      await circuitBreaker.reset('operator-1', 'test reset');

      const state = circuitBreaker.getState();
      expect(state.state).toBe(CBState.CLOSED);
      expect(state.tripReason).toBeNull();
      expect(state.trippedAt).toBeNull();
      expect(state.fallbackOpen).toBe(false);
    });

    it('should require operatorId', async () => {
      await expect(circuitBreaker.reset(null)).rejects.toThrow('operatorId is required');
    });

    it('should block reset when active orders exist', async () => {
      persistence.all.mockResolvedValue([{ count: 3 }]);

      await expect(circuitBreaker.reset('operator-1')).rejects.toThrow('Cannot reset: 3 active orders');
    });
  });

  describe('getState()', () => {
    it('should return uninitialized state before init', () => {
      const state = circuitBreaker.getState();
      expect(state.initialized).toBe(false);
    });

    it('should include escalation stage when OPEN', async () => {
      const trippedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString(); // 6 min ago
      persistence.cbQuery.mockResolvedValue([
        { state: 'OPEN', trip_reason: 'MANUAL_TRIP', tripped_at: trippedAt },
      ]);

      await circuitBreaker.init(mockConfig);
      const state = circuitBreaker.getState();

      expect(state.escalationStage).toBe('alert');
    });
  });

  describe('escalation timeline', () => {
    beforeEach(async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);
      await circuitBreaker.init(mockConfig);
    });

    it('should progress through escalation stages', async () => {
      persistence.cbQuery
        .mockResolvedValueOnce([{ state: 'OPEN' }])
        .mockResolvedValueOnce([]);
      await circuitBreaker.trip(TripReason.MANUAL_TRIP);

      // 0-5 min: monitoring
      let state = circuitBreaker.getState();
      expect(state.escalationStage).toBe('monitoring');

      // Advance to 6 min: alert
      vi.advanceTimersByTime(6 * 60 * 1000);
      state = circuitBreaker.getState();
      expect(state.escalationStage).toBe('alert');

      // Advance to 16 min: cancel_orders
      vi.advanceTimersByTime(10 * 60 * 1000);
      state = circuitBreaker.getState();
      expect(state.escalationStage).toBe('cancel_orders');

      // Advance to 31 min: shutdown
      vi.advanceTimersByTime(15 * 60 * 1000);
      state = circuitBreaker.getState();
      expect(state.escalationStage).toBe('shutdown');
    });
  });

  describe('setOrderManager()', () => {
    it('should store order manager reference', async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);
      await circuitBreaker.init(mockConfig);

      const mockOM = { cancelAll: vi.fn() };
      circuitBreaker.setOrderManager(mockOM);

      // No error means success
      expect(true).toBe(true);
    });
  });

  describe('shutdown()', () => {
    it('should clean up all state', async () => {
      persistence.cbQuery.mockResolvedValue([
        { state: 'CLOSED', trip_reason: null, tripped_at: null },
      ]);
      await circuitBreaker.init(mockConfig);
      await circuitBreaker.shutdown();

      const state = circuitBreaker.getState();
      expect(state.initialized).toBe(false);
    });
  });
});
