/**
 * Window-Expiry Module Integration Tests
 *
 * Tests the public interface of the window-expiry module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
import * as windowExpiry from '../index.js';
import { WindowExpiryErrorCodes, ExpiryReason, Resolution } from '../types.js';

// Test configuration
const mockConfig = {
  trading: {
    windowDurationMs: 15 * 60 * 1000,  // 15 minutes
    minTimeRemainingMs: 60 * 1000,     // 1 minute
  },
  strategy: {
    windowExpiry: {
      enabled: true,
      expiryWarningThresholdMs: 30 * 1000, // 30 seconds
    },
  },
};

// Mock positions for tests
const mockPosition = {
  id: 1,
  window_id: 'btc-15m-2026-01-31-10:00',
  side: 'long',
  size: 10,
  entry_price: 0.50,
  current_price: 0.55,
};

describe('WindowExpiry Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await windowExpiry.shutdown();
  });

  afterEach(async () => {
    await windowExpiry.shutdown();
  });

  describe('init()', () => {
    it('initializes successfully with valid config', async () => {
      await windowExpiry.init(mockConfig);

      const state = windowExpiry.getState();
      expect(state.initialized).toBe(true);
    });

    it('uses default values when config not provided', async () => {
      await windowExpiry.init({});

      const state = windowExpiry.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(true);
      expect(state.config.window_duration_ms).toBe(15 * 60 * 1000);
      expect(state.config.expiry_warning_threshold_ms).toBe(30 * 1000);
      expect(state.config.min_time_remaining_ms).toBe(60 * 1000);
    });

    it('is idempotent - multiple calls do not error', async () => {
      await windowExpiry.init(mockConfig);
      await windowExpiry.init(mockConfig);

      expect(windowExpiry.getState().initialized).toBe(true);
    });

    it('throws on invalid enabled (non-boolean)', async () => {
      await expect(windowExpiry.init({
        strategy: { windowExpiry: { enabled: 'yes' } },
      })).rejects.toThrow('enabled must be a boolean');
    });

    it('throws on invalid windowDurationMs (zero)', async () => {
      await expect(windowExpiry.init({
        trading: { windowDurationMs: 0 },
      })).rejects.toThrow('windowDurationMs must be a positive number');
    });

    it('throws on invalid windowDurationMs (negative)', async () => {
      await expect(windowExpiry.init({
        trading: { windowDurationMs: -1000 },
      })).rejects.toThrow('windowDurationMs must be a positive number');
    });

    it('throws on invalid expiryWarningThresholdMs (negative)', async () => {
      await expect(windowExpiry.init({
        strategy: { windowExpiry: { expiryWarningThresholdMs: -1000 } },
      })).rejects.toThrow('expiryWarningThresholdMs must be a non-negative number');
    });

    it('throws on invalid minTimeRemainingMs (negative)', async () => {
      await expect(windowExpiry.init({
        trading: { minTimeRemainingMs: -1000 },
      })).rejects.toThrow('minTimeRemainingMs must be a non-negative number');
    });

    it('throws when expiryWarningThresholdMs >= windowDurationMs', async () => {
      await expect(windowExpiry.init({
        trading: { windowDurationMs: 60 * 1000 }, // 1 minute
        strategy: { windowExpiry: { expiryWarningThresholdMs: 60 * 1000 } }, // Same as duration
      })).rejects.toThrow('expiryWarningThresholdMs must be less than windowDurationMs');
    });

    it('accepts disabled configuration', async () => {
      await windowExpiry.init({
        strategy: { windowExpiry: { enabled: false } },
      });

      const state = windowExpiry.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.enabled).toBe(false);
    });
  });

  describe('calculateTimeRemaining()', () => {
    beforeEach(async () => {
      await windowExpiry.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await windowExpiry.shutdown();

      expect(() => windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00'))
        .toThrow('Window-expiry module not initialized');
    });

    it('calculates time remaining correctly', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBe(5 * 60 * 1000); // 5 minutes
      expect(result.is_resolved).toBe(false);
      expect(result.is_expiring).toBe(false);
    });

    it('detects expiring window', () => {
      const now = new Date('2026-01-31T10:14:40.000Z'); // 20 seconds remaining
      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.is_expiring).toBe(true);
      expect(result.time_remaining_ms).toBe(20 * 1000);
    });

    it('detects resolved window', () => {
      const now = new Date('2026-01-31T10:16:00.000Z'); // Past expiry
      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.is_resolved).toBe(true);
    });

    it('returns window start and end times', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = windowExpiry.calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.window_start_time).toBe('2026-01-31T10:00:00.000Z');
      expect(result.window_end_time).toBe('2026-01-31T10:15:00.000Z');
    });
  });

  describe('checkExpiry()', () => {
    beforeEach(async () => {
      await windowExpiry.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await windowExpiry.shutdown();

      expect(() => windowExpiry.checkExpiry(mockPosition))
        .toThrow('Window-expiry module not initialized');
    });

    it('returns safe result when plenty of time remains', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = windowExpiry.checkExpiry(mockPosition, {}, { now });

      expect(result.is_expiring).toBe(false);
      expect(result.is_resolved).toBe(false);
      expect(result.reason).toBe(ExpiryReason.SAFE);
    });

    it('returns expiring result within warning threshold', () => {
      const now = new Date('2026-01-31T10:14:40.000Z');
      const result = windowExpiry.checkExpiry(mockPosition, {}, { now });

      expect(result.is_expiring).toBe(true);
      expect(result.reason).toBe(ExpiryReason.WINDOW_EXPIRING);
    });

    it('returns resolved result with P&L when window ended', () => {
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = windowExpiry.checkExpiry(mockPosition, { resolution_price: 1 }, { now });

      expect(result.is_resolved).toBe(true);
      expect(result.reason).toBe(ExpiryReason.WINDOW_RESOLVED);
      expect(result.outcome).toBe(Resolution.WIN);
      expect(result.pnl).toBeCloseTo(5, 4); // 10 * (1 - 0.50)
    });

    it('returns disabled result when module is disabled', async () => {
      await windowExpiry.shutdown();
      await windowExpiry.init({
        strategy: { windowExpiry: { enabled: false } },
      });

      const result = windowExpiry.checkExpiry(mockPosition);

      expect(result.is_expiring).toBe(false);
      expect(result.is_resolved).toBe(false);
      expect(result.reason).toBe('window_expiry_disabled');
    });

    it('includes all required fields in result', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = windowExpiry.checkExpiry(mockPosition, {}, { now });

      expect(result).toHaveProperty('position_id');
      expect(result).toHaveProperty('window_id');
      expect(result).toHaveProperty('side');
      expect(result).toHaveProperty('entry_price');
      expect(result).toHaveProperty('current_price');
      expect(result).toHaveProperty('window_start_time');
      expect(result).toHaveProperty('window_end_time');
      expect(result).toHaveProperty('time_remaining_ms');
      expect(result).toHaveProperty('is_expiring');
      expect(result).toHaveProperty('is_resolved');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('resolution_price');
      expect(result).toHaveProperty('outcome');
      expect(result).toHaveProperty('pnl');
      expect(result).toHaveProperty('pnl_pct');
      expect(result).toHaveProperty('evaluated_at');
    });
  });

  describe('canEnterWindow()', () => {
    beforeEach(async () => {
      await windowExpiry.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await windowExpiry.shutdown();

      expect(() => windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00'))
        .toThrow('Window-expiry module not initialized');
    });

    it('allows entry when sufficient time remains', () => {
      const now = new Date('2026-01-31T10:10:00.000Z'); // 5 min remaining
      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', { now });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('sufficient_time_remaining');
    });

    it('blocks entry when insufficient time remains', () => {
      const now = new Date('2026-01-31T10:14:30.000Z'); // 30 sec remaining
      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', { now });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('insufficient_time_remaining');
    });

    it('uses config minTimeRemainingMs by default', () => {
      // Config has 60 seconds min, window has 30 seconds remaining
      const now = new Date('2026-01-31T10:14:30.000Z');
      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', { now });

      expect(result.allowed).toBe(false);
      expect(result.time_remaining_ms).toBe(30 * 1000);
    });

    it('allows override of minTimeRemainingMs', () => {
      // Config has 60 seconds min, but override to 20 seconds
      const now = new Date('2026-01-31T10:14:30.000Z'); // 30 sec remaining
      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 20 * 1000, // Only need 20 seconds
      });

      expect(result.allowed).toBe(true);
    });

    it('returns allowed when module is disabled', async () => {
      await windowExpiry.shutdown();
      await windowExpiry.init({
        strategy: { windowExpiry: { enabled: false } },
      });

      const now = new Date('2026-01-31T10:14:30.000Z');
      const result = windowExpiry.canEnterWindow('btc-15m-2026-01-31-10:00', { now });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('window_expiry_disabled');
    });
  });

  describe('evaluateAll()', () => {
    beforeEach(async () => {
      await windowExpiry.init(mockConfig);
    });

    it('throws if not initialized', async () => {
      await windowExpiry.shutdown();

      expect(() => windowExpiry.evaluateAll([mockPosition], () => ({})))
        .toThrow('Window-expiry module not initialized');
    });

    it('evaluates multiple positions and categorizes results', () => {
      // At 10:15:50:
      // - Position 1: window 10:00-10:15 - RESOLVED (ended 50 sec ago)
      // - Position 2: window 10:01-10:16 - EXPIRING (10 sec remaining, within 30 sec threshold)
      // - Position 3: window 10:30-10:45 - SAFE (29+ min remaining)
      const positions = [
        { id: 1, window_id: 'btc-15m-2026-01-31-10:00', side: 'long', size: 10, entry_price: 0.50 }, // Resolved
        { id: 2, window_id: 'btc-15m-2026-01-31-10:01', side: 'long', size: 10, entry_price: 0.50 }, // Expiring
        { id: 3, window_id: 'btc-15m-2026-01-31-10:30', side: 'short', size: 10, entry_price: 0.50 }, // Safe
      ];

      const now = new Date('2026-01-31T10:15:50.000Z');
      const getWindowData = (windowId) => {
        if (windowId === 'btc-15m-2026-01-31-10:00') {
          return { resolution_price: 1 };
        }
        return {};
      };

      const { expiring, resolved, summary } = windowExpiry.evaluateAll(positions, getWindowData, { now });

      expect(resolved.length).toBe(1);
      expect(resolved[0].position_id).toBe(1);
      expect(expiring.length).toBe(1);
      expect(expiring[0].position_id).toBe(2);
      expect(summary.evaluated).toBe(3);
      expect(summary.resolved).toBe(1);
      expect(summary.expiring).toBe(1);
      expect(summary.safe).toBe(1);
    });

    it('returns empty arrays when no positions', () => {
      const { expiring, resolved, summary } = windowExpiry.evaluateAll([], () => ({}));

      expect(expiring.length).toBe(0);
      expect(resolved.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });

    it('returns empty arrays when positions is null', () => {
      const { expiring, resolved, summary } = windowExpiry.evaluateAll(null, () => ({}));

      expect(expiring.length).toBe(0);
      expect(resolved.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });

    it('returns empty arrays when module is disabled', async () => {
      await windowExpiry.shutdown();
      await windowExpiry.init({
        strategy: { windowExpiry: { enabled: false } },
      });

      const positions = [mockPosition];
      const { expiring, resolved, summary } = windowExpiry.evaluateAll(positions, () => ({}));

      expect(expiring.length).toBe(0);
      expect(resolved.length).toBe(0);
      expect(summary.evaluated).toBe(0);
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state before init', () => {
      const state = windowExpiry.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });

    it('returns initialized state with config after init', async () => {
      await windowExpiry.init(mockConfig);

      const state = windowExpiry.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.config.enabled).toBe(true);
      expect(state.config.window_duration_ms).toBe(15 * 60 * 1000);
      expect(state.config.expiry_warning_threshold_ms).toBe(30 * 1000);
      expect(state.config.min_time_remaining_ms).toBe(60 * 1000);
    });

    it('includes evaluation stats', async () => {
      await windowExpiry.init(mockConfig);

      const state = windowExpiry.getState();

      expect(state.evaluation_count).toBe(0);
      expect(state.expiring_count).toBe(0);
      expect(state.resolved_count).toBe(0);
      expect(state.safe_count).toBe(0);
      expect(state.last_evaluation_at).toBeNull();
    });

    it('updates stats after evaluations', async () => {
      await windowExpiry.init(mockConfig);

      // Safe position
      windowExpiry.checkExpiry(mockPosition, {}, { now: new Date('2026-01-31T10:10:00.000Z') });

      // Expiring position
      windowExpiry.checkExpiry(mockPosition, {}, { now: new Date('2026-01-31T10:14:40.000Z') });

      // Resolved position
      windowExpiry.checkExpiry(mockPosition, { resolution_price: 1 }, { now: new Date('2026-01-31T10:16:00.000Z') });

      const state = windowExpiry.getState();

      expect(state.evaluation_count).toBe(3);
      expect(state.safe_count).toBe(1);
      expect(state.expiring_count).toBe(1);
      expect(state.resolved_count).toBe(1);
      expect(state.last_evaluation_at).not.toBeNull();
    });
  });

  describe('shutdown()', () => {
    it('resets state to uninitialized', async () => {
      await windowExpiry.init(mockConfig);
      expect(windowExpiry.getState().initialized).toBe(true);

      await windowExpiry.shutdown();

      expect(windowExpiry.getState().initialized).toBe(false);
      expect(windowExpiry.getState().config).toBeNull();
    });

    it('resets evaluation stats', async () => {
      await windowExpiry.init(mockConfig);
      windowExpiry.checkExpiry(mockPosition, {}, { now: new Date('2026-01-31T10:10:00.000Z') });

      await windowExpiry.shutdown();

      const state = windowExpiry.getState();
      expect(state.evaluation_count).toBe(0);
      expect(state.resolved_count).toBe(0);
    });

    it('is idempotent - can be called multiple times', async () => {
      await windowExpiry.init(mockConfig);
      await windowExpiry.shutdown();
      await windowExpiry.shutdown();

      expect(windowExpiry.getState().initialized).toBe(false);
    });

    it('allows reinitialization after shutdown', async () => {
      await windowExpiry.init(mockConfig);
      await windowExpiry.shutdown();
      await windowExpiry.init(mockConfig);

      expect(windowExpiry.getState().initialized).toBe(true);
    });
  });

  describe('module exports', () => {
    it('exports standard interface (init, getState, shutdown)', () => {
      expect(typeof windowExpiry.init).toBe('function');
      expect(typeof windowExpiry.getState).toBe('function');
      expect(typeof windowExpiry.shutdown).toBe('function');
    });

    it('exports calculateTimeRemaining, checkExpiry, canEnterWindow, evaluateAll', () => {
      expect(typeof windowExpiry.calculateTimeRemaining).toBe('function');
      expect(typeof windowExpiry.checkExpiry).toBe('function');
      expect(typeof windowExpiry.canEnterWindow).toBe('function');
      expect(typeof windowExpiry.evaluateAll).toBe('function');
    });

    it('exports error types', () => {
      expect(windowExpiry.WindowExpiryError).toBeDefined();
      expect(windowExpiry.WindowExpiryErrorCodes).toBeDefined();
    });

    it('exports ExpiryReason constants', () => {
      expect(windowExpiry.ExpiryReason).toBeDefined();
      expect(windowExpiry.ExpiryReason.SAFE).toBe('safe');
      expect(windowExpiry.ExpiryReason.WINDOW_EXPIRING).toBe('window_expiring');
      expect(windowExpiry.ExpiryReason.WINDOW_RESOLVED).toBe('window_resolved');
    });

    it('exports Resolution constants', () => {
      expect(windowExpiry.Resolution).toBeDefined();
      expect(windowExpiry.Resolution.WIN).toBe('win');
      expect(windowExpiry.Resolution.LOSE).toBe('lose');
    });

    it('exports createWindowExpiryResult', () => {
      expect(windowExpiry.createWindowExpiryResult).toBeDefined();
      expect(typeof windowExpiry.createWindowExpiryResult).toBe('function');
    });
  });
});
