/**
 * Window-Expiry Logic Unit Tests
 *
 * Tests the core window timing and resolution evaluation logic.
 *
 * Key behaviors:
 * - Parse window_id to extract timing information
 * - Calculate time remaining in a window
 * - Detect "expiring soon" and "resolved" states
 * - Calculate P&L on resolution
 * - Block entries when insufficient time remains
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  parseWindowId,
  calculateTimeRemaining,
  checkExpiry,
  canEnterWindow,
  evaluateAll,
} from '../logic.js';
import { ExpiryReason, Resolution, WindowExpiryErrorCodes } from '../types.js';
import * as state from '../state.js';

// Mock logger
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('parseWindowId', () => {
  describe('valid window IDs', () => {
    it('parses standard window_id correctly', () => {
      const result = parseWindowId('btc-15m-2026-01-31-10:00');

      expect(result.is_valid).toBe(true);
      expect(result.asset).toBe('btc');
      expect(result.duration).toBe('15m');
      expect(result.start_time).toBe('2026-01-31T10:00:00.000Z');
      expect(result.end_time).toBe('2026-01-31T10:15:00.000Z'); // 15 min later
    });

    it('parses window_id with different asset', () => {
      const result = parseWindowId('eth-15m-2026-01-31-14:30');

      expect(result.is_valid).toBe(true);
      expect(result.asset).toBe('eth');
      expect(result.start_time).toBe('2026-01-31T14:30:00.000Z');
    });

    it('uses custom windowDurationMs when provided', () => {
      const result = parseWindowId('btc-30m-2026-01-31-10:00', {
        windowDurationMs: 30 * 60 * 1000, // 30 minutes
      });

      expect(result.is_valid).toBe(true);
      expect(result.end_time).toBe('2026-01-31T10:30:00.000Z'); // 30 min later
    });

    it('parses window at midnight correctly', () => {
      const result = parseWindowId('btc-15m-2026-01-31-00:00');

      expect(result.is_valid).toBe(true);
      expect(result.start_time).toBe('2026-01-31T00:00:00.000Z');
      expect(result.end_time).toBe('2026-01-31T00:15:00.000Z');
    });

    it('parses window at 23:45 correctly (spans midnight)', () => {
      const result = parseWindowId('btc-15m-2026-01-31-23:45');

      expect(result.is_valid).toBe(true);
      expect(result.start_time).toBe('2026-01-31T23:45:00.000Z');
      expect(result.end_time).toBe('2026-02-01T00:00:00.000Z'); // Spans to next day
    });
  });

  describe('invalid window IDs', () => {
    it('returns invalid for null window_id', () => {
      const result = parseWindowId(null);

      expect(result.is_valid).toBe(false);
      expect(result.error).toContain('required');
    });

    it('returns invalid for undefined window_id', () => {
      const result = parseWindowId(undefined);

      expect(result.is_valid).toBe(false);
    });

    it('returns invalid for empty string', () => {
      const result = parseWindowId('');

      expect(result.is_valid).toBe(false);
    });

    it('returns invalid for number instead of string', () => {
      const result = parseWindowId(12345);

      expect(result.is_valid).toBe(false);
      expect(result.error).toContain('string');
    });

    it('returns invalid for wrong format (missing parts)', () => {
      const result = parseWindowId('btc-15m-2026-01-31');

      expect(result.is_valid).toBe(false);
      expect(result.error).toContain('Invalid window_id format');
    });

    it('returns invalid for wrong date format', () => {
      const result = parseWindowId('btc-15m-31-01-2026-10:00');

      expect(result.is_valid).toBe(false);
    });

    it('returns invalid for wrong time format (missing colon)', () => {
      const result = parseWindowId('btc-15m-2026-01-31-1000');

      expect(result.is_valid).toBe(false);
    });
  });
});

describe('calculateTimeRemaining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  describe('time remaining calculation', () => {
    it('calculates remaining time correctly - 5 minutes remaining', () => {
      // Window: 10:00 - 10:15, Current time: 10:10
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBe(5 * 60 * 1000); // 5 minutes
      expect(result.is_resolved).toBe(false);
      expect(result.is_expiring).toBe(false);
    });

    it('calculates remaining time correctly - exactly at midpoint', () => {
      // Window: 10:00 - 10:15, Current time: 10:07:30
      const now = new Date('2026-01-31T10:07:30.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBe(7.5 * 60 * 1000); // 7.5 minutes
    });

    it('calculates remaining time correctly - near start', () => {
      // Window: 10:00 - 10:15, Current time: 10:00:01
      const now = new Date('2026-01-31T10:00:01.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBe(14 * 60 * 1000 + 59 * 1000); // 14:59
    });

    it('returns window start and end times', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.window_start_time).toBe('2026-01-31T10:00:00.000Z');
      expect(result.window_end_time).toBe('2026-01-31T10:15:00.000Z');
    });
  });

  describe('expiring detection', () => {
    it('detects expiring when within warning threshold (20 seconds left)', () => {
      // Window ends at 10:15, current time is 10:14:40 (20 seconds remaining)
      const now = new Date('2026-01-31T10:14:40.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', {
        now,
        expiryWarningThresholdMs: 30 * 1000, // 30 second threshold
      });

      expect(result.time_remaining_ms).toBe(20 * 1000);
      expect(result.is_expiring).toBe(true);
      expect(result.is_resolved).toBe(false);
    });

    it('detects expiring at exactly threshold boundary', () => {
      // Window ends at 10:15, current time is 10:14:30 (exactly 30 seconds remaining)
      const now = new Date('2026-01-31T10:14:30.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', {
        now,
        expiryWarningThresholdMs: 30 * 1000,
      });

      expect(result.time_remaining_ms).toBe(30 * 1000);
      expect(result.is_expiring).toBe(true);
    });

    it('is NOT expiring when outside threshold', () => {
      // Window ends at 10:15, current time is 10:14:00 (1 minute remaining)
      const now = new Date('2026-01-31T10:14:00.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', {
        now,
        expiryWarningThresholdMs: 30 * 1000,
      });

      expect(result.time_remaining_ms).toBe(60 * 1000);
      expect(result.is_expiring).toBe(false);
    });
  });

  describe('resolved detection', () => {
    it('detects resolved when window has ended', () => {
      // Window ends at 10:15, current time is 10:16
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBe(-60 * 1000); // -1 minute
      expect(result.is_resolved).toBe(true);
      expect(result.is_expiring).toBe(false);
    });

    it('detects resolved at exactly end time', () => {
      // Window ends at 10:15, current time is exactly 10:15
      const now = new Date('2026-01-31T10:15:00.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBe(0);
      expect(result.is_resolved).toBe(true);
    });

    it('detects resolved for old window (hours past)', () => {
      // Window ends at 10:15, current time is 13:00
      const now = new Date('2026-01-31T13:00:00.000Z');
      const result = calculateTimeRemaining('btc-15m-2026-01-31-10:00', { now });

      expect(result.time_remaining_ms).toBeLessThan(0);
      expect(result.is_resolved).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws WindowExpiryError for invalid window_id', () => {
      expect(() => calculateTimeRemaining('invalid-format', { now: new Date() }))
        .toThrow('Invalid window_id format');
    });

    it('throws with correct error code', () => {
      try {
        calculateTimeRemaining('invalid', { now: new Date() });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe(WindowExpiryErrorCodes.INVALID_WINDOW_ID);
      }
    });
  });
});

describe('checkExpiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  const basePosition = {
    id: 1,
    window_id: 'btc-15m-2026-01-31-10:00',
    side: 'long',
    size: 10,
    entry_price: 0.50,
    current_price: 0.55,
  };

  describe('safe positions (plenty of time)', () => {
    it('returns safe result when plenty of time remains', () => {
      const now = new Date('2026-01-31T10:10:00.000Z'); // 5 min remaining
      const result = checkExpiry(basePosition, {}, { now });

      expect(result.is_expiring).toBe(false);
      expect(result.is_resolved).toBe(false);
      expect(result.reason).toBe(ExpiryReason.SAFE);
      expect(result.outcome).toBeNull();
      expect(result.pnl).toBe(0);
    });

    it('includes position details in result', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = checkExpiry(basePosition, {}, { now });

      expect(result.position_id).toBe(1);
      expect(result.window_id).toBe('btc-15m-2026-01-31-10:00');
      expect(result.side).toBe('long');
      expect(result.entry_price).toBe(0.50);
      expect(result.current_price).toBe(0.55);
    });

    it('logs at debug level when safe', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      checkExpiry(basePosition, {}, { now, log: mockLog });

      expect(mockLog.debug).toHaveBeenCalledWith('window_expiry_checked', expect.objectContaining({
        position_id: 1,
      }));
    });
  });

  describe('expiring positions (warning zone)', () => {
    it('returns expiring result within warning threshold', () => {
      const now = new Date('2026-01-31T10:14:40.000Z'); // 20 sec remaining
      const result = checkExpiry(basePosition, {}, {
        now,
        expiryWarningThresholdMs: 30 * 1000,
      });

      expect(result.is_expiring).toBe(true);
      expect(result.is_resolved).toBe(false);
      expect(result.reason).toBe(ExpiryReason.WINDOW_EXPIRING);
      expect(result.time_remaining_ms).toBe(20 * 1000);
    });

    it('logs at info level when expiring', () => {
      const now = new Date('2026-01-31T10:14:40.000Z');
      checkExpiry(basePosition, {}, {
        now,
        expiryWarningThresholdMs: 30 * 1000,
        log: mockLog,
      });

      expect(mockLog.info).toHaveBeenCalledWith('window_expiring_soon', expect.objectContaining({
        position_id: 1,
        time_remaining_ms: 20 * 1000,
      }));
    });
  });

  describe('resolved positions (window ended)', () => {
    it('returns resolved result when window has ended', () => {
      const now = new Date('2026-01-31T10:16:00.000Z'); // 1 min past
      const result = checkExpiry(basePosition, { resolution_price: 1 }, { now });

      expect(result.is_expiring).toBe(false);
      expect(result.is_resolved).toBe(true);
      expect(result.reason).toBe(ExpiryReason.WINDOW_RESOLVED);
    });

    it('calculates WIN for long position when resolution is 1', () => {
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(basePosition, { resolution_price: 1 }, { now });

      expect(result.outcome).toBe(Resolution.WIN);
      // P&L = size * (resolution - entry) = 10 * (1 - 0.50) = 5
      expect(result.pnl).toBeCloseTo(5, 4);
      expect(result.pnl_pct).toBeCloseTo(1.0, 4); // 100% profit
    });

    it('calculates LOSE for long position when resolution is 0', () => {
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(basePosition, { resolution_price: 0 }, { now });

      expect(result.outcome).toBe(Resolution.LOSE);
      // P&L = size * (resolution - entry) = 10 * (0 - 0.50) = -5
      expect(result.pnl).toBeCloseTo(-5, 4);
      expect(result.pnl_pct).toBeCloseTo(-1.0, 4); // -100% loss
    });

    it('calculates WIN for short position when resolution is 0', () => {
      const shortPosition = { ...basePosition, id: 2, side: 'short' };
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(shortPosition, { resolution_price: 0 }, { now });

      expect(result.outcome).toBe(Resolution.WIN);
      // P&L = size * (entry - resolution) = 10 * (0.50 - 0) = 5
      expect(result.pnl).toBeCloseTo(5, 4);
    });

    it('calculates LOSE for short position when resolution is 1', () => {
      const shortPosition = { ...basePosition, id: 2, side: 'short' };
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(shortPosition, { resolution_price: 1 }, { now });

      expect(result.outcome).toBe(Resolution.LOSE);
      // P&L = size * (entry - resolution) = 10 * (0.50 - 1) = -5
      expect(result.pnl).toBeCloseTo(-5, 4);
    });

    it('handles missing resolution data gracefully', () => {
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(basePosition, {}, { now });

      expect(result.is_resolved).toBe(true);
      expect(result.resolution_price).toBeNull();
      expect(result.outcome).toBeNull();
      expect(result.pnl).toBe(0);
    });

    it('logs at info level with full details when resolved', () => {
      const now = new Date('2026-01-31T10:16:00.000Z');
      checkExpiry(basePosition, { resolution_price: 1 }, { now, log: mockLog });

      expect(mockLog.info).toHaveBeenCalledWith('window_resolved', expect.objectContaining({
        position_id: 1,
        window_id: 'btc-15m-2026-01-31-10:00',
        side: 'long',
        expected: expect.objectContaining({
          entry_price: 0.50,
          position_side: 'long',
        }),
        actual: expect.objectContaining({
          resolution_price: 1,
          outcome: 'win',
          pnl: 5,
        }),
      }));
    });
  });

  describe('P&L calculations', () => {
    it('calculates P&L percentage correctly for partial entry price', () => {
      // Entry at 0.30, resolution at 1 (long)
      const position = { ...basePosition, entry_price: 0.30 };
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(position, { resolution_price: 1 }, { now });

      // P&L = 10 * (1 - 0.30) = 7
      // P&L % = 7 / (10 * 0.30) = 7 / 3 = 2.333...
      expect(result.pnl).toBeCloseTo(7, 4);
      expect(result.pnl_pct).toBeCloseTo(7 / 3, 4);
    });

    it('calculates P&L percentage correctly for larger position', () => {
      const position = { ...basePosition, size: 100 };
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = checkExpiry(position, { resolution_price: 1 }, { now });

      // P&L = 100 * (1 - 0.50) = 50
      expect(result.pnl).toBeCloseTo(50, 4);
      expect(result.pnl_pct).toBeCloseTo(1.0, 4); // Same 100% profit
    });
  });

  describe('state tracking', () => {
    it('increments evaluation count', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      checkExpiry(basePosition, {}, { now });

      const stats = state.getStats();
      expect(stats.evaluation_count).toBe(1);
    });

    it('increments expiring count when expiring', () => {
      const now = new Date('2026-01-31T10:14:40.000Z');
      checkExpiry(basePosition, {}, { now, expiryWarningThresholdMs: 30 * 1000 });

      const stats = state.getStats();
      expect(stats.expiring_count).toBe(1);
    });

    it('increments resolved count when resolved', () => {
      const now = new Date('2026-01-31T10:16:00.000Z');
      checkExpiry(basePosition, { resolution_price: 1 }, { now });

      const stats = state.getStats();
      expect(stats.resolved_count).toBe(1);
    });

    it('increments safe count when safe', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      checkExpiry(basePosition, {}, { now });

      const stats = state.getStats();
      expect(stats.safe_count).toBe(1);
    });
  });
});

describe('canEnterWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  describe('allowed entry', () => {
    it('allows entry when plenty of time remains', () => {
      // Window: 10:00 - 10:15, Current: 10:10 (5 min remaining)
      const now = new Date('2026-01-31T10:10:00.000Z');
      const result = canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000, // Need 1 min
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('sufficient_time_remaining');
      expect(result.time_remaining_ms).toBe(5 * 60 * 1000);
    });

    it('allows entry at exactly minimum time boundary', () => {
      // Window: 10:00 - 10:15, Current: 10:14 (exactly 1 min remaining)
      const now = new Date('2026-01-31T10:14:00.000Z');
      const result = canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('blocked entry', () => {
    it('blocks entry when insufficient time remains', () => {
      // Window: 10:00 - 10:15, Current: 10:14:30 (30 sec remaining)
      const now = new Date('2026-01-31T10:14:30.000Z');
      const result = canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000, // Need 1 min
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('insufficient_time_remaining');
      expect(result.time_remaining_ms).toBe(30 * 1000);
    });

    it('blocks entry when window has already expired', () => {
      // Window: 10:00 - 10:15, Current: 10:16
      const now = new Date('2026-01-31T10:16:00.000Z');
      const result = canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000,
      });

      expect(result.allowed).toBe(false);
      expect(result.time_remaining_ms).toBeLessThan(0);
    });

    it('includes detailed reason in blocking message', () => {
      const now = new Date('2026-01-31T10:14:30.000Z');
      const result = canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000,
      });

      expect(result.reason).toContain('30000ms < 60000ms required');
    });
  });

  describe('logging', () => {
    it('logs when entry is blocked', () => {
      const now = new Date('2026-01-31T10:14:30.000Z');
      canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000,
        log: mockLog,
      });

      expect(mockLog.info).toHaveBeenCalledWith('entry_blocked_expiry', expect.objectContaining({
        window_id: 'btc-15m-2026-01-31-10:00',
        time_remaining_ms: 30 * 1000,
        min_required_ms: 60 * 1000,
      }));
    });

    it('does NOT log when entry is allowed', () => {
      const now = new Date('2026-01-31T10:10:00.000Z');
      canEnterWindow('btc-15m-2026-01-31-10:00', {
        now,
        minTimeRemainingMs: 60 * 1000,
        log: mockLog,
      });

      expect(mockLog.info).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns blocked with error reason for invalid window_id', () => {
      const result = canEnterWindow('invalid-format', {
        now: new Date(),
        minTimeRemainingMs: 60 * 1000,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('window_id_error');
      expect(result.time_remaining_ms).toBe(0);
    });
  });
});

describe('evaluateAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  const positions = [
    {
      id: 1,
      window_id: 'btc-15m-2026-01-31-10:00', // Will be resolved (ends 10:15, evaluated at 10:16:20)
      side: 'long',
      size: 10,
      entry_price: 0.50,
    },
    {
      id: 2,
      window_id: 'btc-15m-2026-01-31-10:01', // Expiring (ends 10:16, evaluated at 10:16:20 - within 30 sec before 10:16)
      side: 'long',
      size: 10,
      entry_price: 0.50,
    },
    {
      id: 3,
      window_id: 'btc-15m-2026-01-31-10:30', // Safe (ends at 10:45, plenty of time at 10:15:50)
      side: 'short',
      size: 10,
      entry_price: 0.50,
    },
  ];

  it('separates expiring and resolved positions correctly', () => {
    // Position 1: btc-15m-2026-01-31-10:00 ends at 10:15 - RESOLVED (past 10:15:50)
    // Position 2: btc-15m-2026-01-31-10:01 ends at 10:16 - EXPIRING (10 sec remaining at 10:15:50)
    // Position 3: btc-15m-2026-01-31-10:30 ends at 10:45 - SAFE (29+ min remaining)
    const now = new Date('2026-01-31T10:15:50.000Z');
    const getWindowData = (windowId) => {
      if (windowId === 'btc-15m-2026-01-31-10:00') {
        return { resolution_price: 1 };
      }
      return {};
    };

    const { expiring, resolved, summary } = evaluateAll(positions, getWindowData, {
      now,
      expiryWarningThresholdMs: 30 * 1000,
    });

    expect(resolved.length).toBe(1);
    expect(resolved[0].position_id).toBe(1);
    expect(resolved[0].outcome).toBe(Resolution.WIN);

    expect(expiring.length).toBe(1);
    expect(expiring[0].position_id).toBe(2);

    expect(summary.evaluated).toBe(3);
    expect(summary.resolved).toBe(1);
    expect(summary.expiring).toBe(1);
    expect(summary.safe).toBe(1);
  });

  it('returns empty arrays when no positions', () => {
    const { expiring, resolved, summary } = evaluateAll([], () => ({}), {
      now: new Date(),
    });

    expect(expiring.length).toBe(0);
    expect(resolved.length).toBe(0);
    expect(summary.evaluated).toBe(0);
  });

  it('handles positions without window data gracefully', () => {
    const now = new Date('2026-01-31T10:16:00.000Z');
    const { resolved, summary } = evaluateAll(
      [positions[0]], // Only the resolved one
      () => ({}), // No resolution data
      { now }
    );

    expect(summary.resolved).toBe(1);
    expect(resolved[0].resolution_price).toBeNull();
    expect(resolved[0].outcome).toBeNull();
  });

  it('continues evaluating after individual position error', () => {
    const positionsWithInvalid = [
      positions[0], // Valid
      { id: 99, window_id: 'invalid-format', side: 'long', size: 10, entry_price: 0.50 }, // Invalid
      positions[2], // Valid
    ];

    const now = new Date('2026-01-31T10:16:00.000Z');
    const { summary } = evaluateAll(positionsWithInvalid, () => ({}), {
      now,
      log: mockLog,
    });

    expect(summary.evaluated).toBe(2); // Two valid positions
    expect(mockLog.error).toHaveBeenCalledWith('window_expiry_evaluation_error', expect.objectContaining({
      position_id: 99,
    }));
  });

  it('logs summary on completion', () => {
    const now = new Date('2026-01-31T10:16:00.000Z');
    evaluateAll(positions, () => ({}), {
      now,
      log: mockLog,
    });

    expect(mockLog.info).toHaveBeenCalledWith('window_expiry_evaluation_complete', expect.objectContaining({
      total_positions: 3,
    }));
  });

  it('does not log summary when no positions', () => {
    evaluateAll([], () => ({}), { now: new Date(), log: mockLog });

    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('uses getWindowData function to fetch resolution info', () => {
    const now = new Date('2026-01-31T10:16:00.000Z');
    const mockGetWindowData = vi.fn().mockReturnValue({ resolution_price: 1 });

    const { resolved } = evaluateAll([positions[0]], mockGetWindowData, { now });

    expect(mockGetWindowData).toHaveBeenCalledWith('btc-15m-2026-01-31-10:00');
    expect(resolved[0].resolution_price).toBe(1);
  });
});
