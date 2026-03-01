/**
 * Position Lifecycle State Machine Tests
 *
 * Tests for lifecycle.js — state transitions, evaluateExit, and locking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock persistence
vi.mock('../../../persistence/index.js', () => ({
  default: {
    get: vi.fn(),
    run: vi.fn(),
  },
}));

import persistence from '../../../persistence/index.js';
import {
  LifecycleState,
  isValidTransition,
  isLocked,
  isMonitoring,
  transitionState,
  evaluateExit,
} from '../lifecycle.js';

describe('Position Lifecycle State Machine', () => {
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('LifecycleState constants', () => {
    it('has all expected states', () => {
      expect(LifecycleState.ENTRY).toBe('ENTRY');
      expect(LifecycleState.MONITORING).toBe('MONITORING');
      expect(LifecycleState.STOP_TRIGGERED).toBe('STOP_TRIGGERED');
      expect(LifecycleState.TP_TRIGGERED).toBe('TP_TRIGGERED');
      expect(LifecycleState.EXPIRY).toBe('EXPIRY');
      expect(LifecycleState.EXIT_PENDING).toBe('EXIT_PENDING');
      expect(LifecycleState.SETTLEMENT).toBe('SETTLEMENT');
      expect(LifecycleState.CLOSED).toBe('CLOSED');
    });
  });

  describe('isValidTransition()', () => {
    it('allows ENTRY -> MONITORING', () => {
      expect(isValidTransition('ENTRY', 'MONITORING')).toBe(true);
    });

    it('allows MONITORING -> STOP_TRIGGERED', () => {
      expect(isValidTransition('MONITORING', 'STOP_TRIGGERED')).toBe(true);
    });

    it('allows MONITORING -> TP_TRIGGERED', () => {
      expect(isValidTransition('MONITORING', 'TP_TRIGGERED')).toBe(true);
    });

    it('allows MONITORING -> EXPIRY', () => {
      expect(isValidTransition('MONITORING', 'EXPIRY')).toBe(true);
    });

    it('allows STOP_TRIGGERED -> EXIT_PENDING', () => {
      expect(isValidTransition('STOP_TRIGGERED', 'EXIT_PENDING')).toBe(true);
    });

    it('allows TP_TRIGGERED -> EXIT_PENDING', () => {
      expect(isValidTransition('TP_TRIGGERED', 'EXIT_PENDING')).toBe(true);
    });

    it('allows EXPIRY -> SETTLEMENT', () => {
      expect(isValidTransition('EXPIRY', 'SETTLEMENT')).toBe(true);
    });

    it('allows EXIT_PENDING -> CLOSED', () => {
      expect(isValidTransition('EXIT_PENDING', 'CLOSED')).toBe(true);
    });

    it('allows SETTLEMENT -> CLOSED', () => {
      expect(isValidTransition('SETTLEMENT', 'CLOSED')).toBe(true);
    });

    it('rejects ENTRY -> CLOSED (skip)', () => {
      expect(isValidTransition('ENTRY', 'CLOSED')).toBe(false);
    });

    it('rejects MONITORING -> CLOSED (skip)', () => {
      expect(isValidTransition('MONITORING', 'CLOSED')).toBe(false);
    });

    it('rejects MONITORING -> EXIT_PENDING (must go through trigger)', () => {
      expect(isValidTransition('MONITORING', 'EXIT_PENDING')).toBe(false);
    });

    it('rejects CLOSED -> anything (terminal)', () => {
      expect(isValidTransition('CLOSED', 'MONITORING')).toBe(false);
      expect(isValidTransition('CLOSED', 'ENTRY')).toBe(false);
    });

    it('rejects EXIT_PENDING -> MONITORING (backward)', () => {
      expect(isValidTransition('EXIT_PENDING', 'MONITORING')).toBe(false);
    });

    it('rejects unknown from state', () => {
      expect(isValidTransition('UNKNOWN', 'MONITORING')).toBe(false);
    });
  });

  describe('isLocked()', () => {
    it('EXIT_PENDING is locked', () => {
      expect(isLocked('EXIT_PENDING')).toBe(true);
    });

    it('SETTLEMENT is locked', () => {
      expect(isLocked('SETTLEMENT')).toBe(true);
    });

    it('CLOSED is locked', () => {
      expect(isLocked('CLOSED')).toBe(true);
    });

    it('MONITORING is not locked', () => {
      expect(isLocked('MONITORING')).toBe(false);
    });

    it('ENTRY is not locked', () => {
      expect(isLocked('ENTRY')).toBe(false);
    });

    it('STOP_TRIGGERED is not locked', () => {
      expect(isLocked('STOP_TRIGGERED')).toBe(false);
    });
  });

  describe('isMonitoring()', () => {
    it('returns true for MONITORING', () => {
      expect(isMonitoring('MONITORING')).toBe(true);
    });

    it('returns false for ENTRY', () => {
      expect(isMonitoring('ENTRY')).toBe(false);
    });

    it('returns false for EXIT_PENDING', () => {
      expect(isMonitoring('EXIT_PENDING')).toBe(false);
    });

    it('returns false for CLOSED', () => {
      expect(isMonitoring('CLOSED')).toBe(false);
    });
  });

  describe('transitionState()', () => {
    it('transitions ENTRY -> MONITORING and logs', async () => {
      persistence.get
        .mockResolvedValueOnce({ id: 1, lifecycle_state: 'ENTRY', status: 'open' })
        .mockResolvedValueOnce({ id: 1, lifecycle_state: 'MONITORING', status: 'open' });

      const result = await transitionState(1, 'MONITORING', mockLog);

      expect(result.lifecycle_state).toBe('MONITORING');
      expect(persistence.get).toHaveBeenCalledTimes(2);
      expect(mockLog.info).toHaveBeenCalledWith('lifecycle_transition', expect.objectContaining({
        positionId: 1,
        from: 'ENTRY',
        to: 'MONITORING',
      }));
    });

    it('throws NOT_FOUND for missing position', async () => {
      persistence.get.mockResolvedValueOnce(null);

      await expect(transitionState(999, 'MONITORING', mockLog))
        .rejects.toThrow('Position not found: 999');
    });

    it('throws INVALID_STATUS_TRANSITION for invalid transition', async () => {
      persistence.get.mockResolvedValueOnce({
        id: 1,
        lifecycle_state: 'ENTRY',
        status: 'open',
      });

      await expect(transitionState(1, 'CLOSED', mockLog))
        .rejects.toThrow('Invalid lifecycle transition: ENTRY -> CLOSED');
    });

    it('defaults to ENTRY if lifecycle_state is null', async () => {
      persistence.get
        .mockResolvedValueOnce({ id: 1, lifecycle_state: null, status: 'open' })
        .mockResolvedValueOnce({ id: 1, lifecycle_state: 'MONITORING', status: 'open' });

      const result = await transitionState(1, 'MONITORING', mockLog);
      expect(result.lifecycle_state).toBe('MONITORING');
    });

    it('throws DATABASE_ERROR if update returns null', async () => {
      persistence.get
        .mockResolvedValueOnce({ id: 1, lifecycle_state: 'ENTRY', status: 'open' })
        .mockResolvedValueOnce(null);

      await expect(transitionState(1, 'MONITORING', mockLog))
        .rejects.toThrow('Failed to update lifecycle state');
    });

    it('includes context in log', async () => {
      persistence.get
        .mockResolvedValueOnce({ id: 1, lifecycle_state: 'MONITORING', status: 'open' })
        .mockResolvedValueOnce({ id: 1, lifecycle_state: 'STOP_TRIGGERED', status: 'open' });

      await transitionState(1, 'STOP_TRIGGERED', mockLog, { reason: 'price_breach' });

      expect(mockLog.info).toHaveBeenCalledWith('lifecycle_transition', expect.objectContaining({
        reason: 'price_breach',
      }));
    });
  });

  describe('evaluateExit()', () => {
    const basePosition = {
      id: 1,
      window_id: 'btc-15m-2026-03-01-12:00',
      side: 'long',
      size: 5,
      entry_price: 0.50,
      current_price: 0.45,
      lifecycle_state: 'MONITORING',
    };

    it('returns null for non-MONITORING position', () => {
      const pos = { ...basePosition, lifecycle_state: 'EXIT_PENDING' };
      const result = evaluateExit(pos, 0.45, {});
      expect(result).toBeNull();
    });

    it('returns null for CLOSED position', () => {
      const pos = { ...basePosition, lifecycle_state: 'CLOSED' };
      const result = evaluateExit(pos, 0.45, {});
      expect(result).toBeNull();
    });

    it('returns STOP_LOSS trigger when stop-loss fires', () => {
      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockReturnValue({ triggered: true, loss_amount: 2.5 }),
        },
        takeProfit: {
          evaluate: vi.fn().mockReturnValue({ triggered: false }),
        },
      };

      const result = evaluateExit(basePosition, 0.45, modules);

      expect(result).not.toBeNull();
      expect(result.trigger).toBe('STOP_LOSS');
      expect(result.lifecycleTarget).toBe('STOP_TRIGGERED');
      expect(result.result.triggered).toBe(true);
    });

    it('stop-loss has priority over take-profit', () => {
      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockReturnValue({ triggered: true }),
        },
        takeProfit: {
          evaluate: vi.fn().mockReturnValue({ triggered: true }),
        },
      };

      const result = evaluateExit(basePosition, 0.45, modules);

      expect(result.trigger).toBe('STOP_LOSS');
      // take-profit should NOT have been called since stop-loss triggered first
      expect(modules.takeProfit.evaluate).not.toHaveBeenCalled();
    });

    it('returns TAKE_PROFIT trigger when take-profit fires', () => {
      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockReturnValue({ triggered: false }),
        },
        takeProfit: {
          evaluate: vi.fn().mockReturnValue({ triggered: true, profit_amount: 5.0 }),
        },
      };

      const result = evaluateExit(basePosition, 0.60, modules);

      expect(result.trigger).toBe('TAKE_PROFIT');
      expect(result.lifecycleTarget).toBe('TP_TRIGGERED');
    });

    it('returns EXPIRY trigger when window is resolved', () => {
      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockReturnValue({ triggered: false }),
        },
        takeProfit: {
          evaluate: vi.fn().mockReturnValue({ triggered: false }),
        },
        windowExpiry: {
          checkExpiry: vi.fn().mockReturnValue({ is_resolved: true, pnl: 3.0 }),
        },
      };

      const result = evaluateExit(basePosition, 0.50, modules);

      expect(result.trigger).toBe('EXPIRY');
      expect(result.lifecycleTarget).toBe('EXPIRY');
    });

    it('returns null when nothing triggers', () => {
      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockReturnValue({ triggered: false }),
        },
        takeProfit: {
          evaluate: vi.fn().mockReturnValue({ triggered: false }),
        },
        windowExpiry: {
          checkExpiry: vi.fn().mockReturnValue({ is_resolved: false }),
        },
      };

      const result = evaluateExit(basePosition, 0.50, modules);
      expect(result).toBeNull();
    });

    it('handles missing modules gracefully', () => {
      const result = evaluateExit(basePosition, 0.50, {});
      expect(result).toBeNull();
    });

    it('handles stop-loss error and falls through to take-profit', () => {
      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockImplementation(() => { throw new Error('SL error'); }),
        },
        takeProfit: {
          evaluate: vi.fn().mockReturnValue({ triggered: true }),
        },
      };

      const result = evaluateExit(basePosition, 0.60, modules);
      expect(result.trigger).toBe('TAKE_PROFIT');
    });

    it('defaults lifecycle_state to MONITORING if missing', () => {
      const pos = { ...basePosition };
      delete pos.lifecycle_state;

      const modules = {
        stopLoss: {
          evaluate: vi.fn().mockReturnValue({ triggered: true }),
        },
      };

      const result = evaluateExit(pos, 0.45, modules);
      expect(result.trigger).toBe('STOP_LOSS');
    });
  });
});
