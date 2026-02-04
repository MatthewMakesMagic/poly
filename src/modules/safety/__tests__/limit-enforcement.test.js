/**
 * Drawdown Limit Enforcement Tests
 *
 * Tests for Story 4.4: Drawdown Limit Enforcement & Auto-Stop
 * Covers AC1-AC7: limit configuration, warning alerts, breach detection,
 * auto-stop trigger, manual resume, module interface, and orchestrator integration.
 *
 * V3 Stage 4: Updated for DB-based auto-stop state persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
}));

// Import after mocks
import persistence from '../../../persistence/index.js';
import {
  checkDrawdownLimit,
  resetAutoStop,
  triggerAutoStop,
} from '../drawdown.js';
import {
  clearCache,
  setCachedRecord,
  setConfig,
  isAutoStopped,
  clearAutoStopState,
  setAutoStopped,
  getDrawdownLimit,
  getDrawdownWarningThreshold,
  hasWarnedAtLevel,
  markWarnedAtLevel,
  clearWarnedLevels,
  persistAutoStopState,
  loadAutoStopState,
} from '../state.js';
import { SafetyErrorCodes } from '../types.js';

describe('Drawdown Limit Enforcement (Story 4.4)', () => {
  const today = new Date().toISOString().split('T')[0];

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    clearAutoStopState();
    clearWarnedLevels();

    // Default config with 5% limit and 3% warning
    setConfig({
      safety: {
        startingCapital: 1000,
        drawdownWarningPct: 0.03,
      },
      risk: {
        dailyDrawdownLimit: 0.05,
      },
    });
  });

  afterEach(() => {
    clearCache();
    clearAutoStopState();
  });

  describe('Configuration (AC1)', () => {
    it('should read dailyDrawdownLimit from config', () => {
      const limit = getDrawdownLimit();
      expect(limit).toBe(0.05);
    });

    it('should read drawdownWarningPct from config', () => {
      const warning = getDrawdownWarningThreshold();
      expect(warning).toBe(0.03);
    });

    it('should use default values if not configured', () => {
      setConfig({});
      expect(getDrawdownLimit()).toBe(0.05);
      expect(getDrawdownWarningThreshold()).toBe(0.03);
    });

    it('should allow custom limit and warning configuration', () => {
      setConfig({
        safety: {
          drawdownWarningPct: 0.04,
        },
        risk: {
          dailyDrawdownLimit: 0.10,
        },
      });

      expect(getDrawdownLimit()).toBe(0.10);
      expect(getDrawdownWarningThreshold()).toBe(0.04);
    });
  });

  describe('checkDrawdownLimit() (AC1, AC2, AC3, AC6)', () => {
    const setupCachedRecord = (overrides = {}) => {
      const baseRecord = {
        id: 1,
        date: today,
        starting_balance: 1000,
        current_balance: 1000,
        realized_pnl: 0,
        unrealized_pnl: 0,
        drawdown_pct: 0,
        max_drawdown_pct: 0,
        trades_count: 0,
        wins: 0,
        losses: 0,
        updated_at: new Date().toISOString(),
        ...overrides,
      };
      setCachedRecord(baseRecord, today);
      return baseRecord;
    };

    it('should return breached=false when under limit', () => {
      setupCachedRecord({
        realized_pnl: -20,
        current_balance: 980,
        drawdown_pct: 0.02,
      });

      const result = checkDrawdownLimit();

      expect(result.breached).toBe(false);
      expect(result.current).toBeCloseTo(0.02);
      expect(result.limit).toBe(0.05);
      expect(result.autoStopped).toBe(false);
    });

    it('should return correct structure (AC6)', () => {
      setupCachedRecord();

      const result = checkDrawdownLimit();

      expect(result).toHaveProperty('breached');
      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('autoStopped');
      expect(typeof result.breached).toBe('boolean');
      expect(typeof result.current).toBe('number');
      expect(typeof result.limit).toBe('number');
      expect(typeof result.autoStopped).toBe('boolean');
    });

    it('should log warning when approaching limit (AC2)', () => {
      setupCachedRecord({
        realized_pnl: -35,
        current_balance: 965,
        drawdown_pct: 0.035,
      });

      const mockLog = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };

      const result = checkDrawdownLimit(mockLog);

      expect(mockLog.warn).toHaveBeenCalledWith('drawdown_warning', expect.objectContaining({
        event: 'drawdown_approaching_limit',
      }));
      expect(result.breached).toBe(false);
      expect(result.autoStopped).toBe(false);
    });

    it('should not repeat warnings at same level (AC2)', () => {
      setupCachedRecord({
        realized_pnl: -35,
        current_balance: 965,
        drawdown_pct: 0.035,
      });

      const mockLog = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };

      // First check - should warn
      checkDrawdownLimit(mockLog);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);

      // Second check at same level - should not warn again
      checkDrawdownLimit(mockLog);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    });

    it('should trigger auto-stop when limit breached (AC3)', () => {
      setupCachedRecord({
        realized_pnl: -50,
        current_balance: 950,
        drawdown_pct: 0.05,
      });

      const mockLog = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };

      const result = checkDrawdownLimit(mockLog);

      expect(result.breached).toBe(true);
      expect(result.autoStopped).toBe(true);
      expect(mockLog.error).toHaveBeenCalledWith('auto_stop_triggered', expect.objectContaining({
        event: 'AUTO-STOP',
        reason: 'drawdown_limit_breached',
      }));
    });

    it('should include unrealized losses in breach check', () => {
      // 2% realized + 3% unrealized = 5% total
      setupCachedRecord({
        realized_pnl: -20,
        current_balance: 980,
        unrealized_pnl: -30,
        drawdown_pct: 0.02,
      });

      const result = checkDrawdownLimit();

      expect(result.breached).toBe(true);
      expect(result.current).toBeCloseTo(0.05);
      expect(result.autoStopped).toBe(true);
    });

    it('should handle uninitialized state', () => {
      // Don't set up cached record
      const result = checkDrawdownLimit();

      expect(result.breached).toBe(false);
      expect(result.current).toBe(0);
      expect(result.limit).toBe(0.05);
      expect(result.autoStopped).toBe(false);
    });
  });

  describe('isAutoStopped() (AC3, AC5)', () => {
    it('should return false initially', () => {
      expect(isAutoStopped()).toBe(false);
    });

    it('should return true after auto-stop triggered', () => {
      setAutoStopped(true, 'test_reason');
      expect(isAutoStopped()).toBe(true);
    });

    it('should be fast (reads from in-memory state)', () => {
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        isAutoStopped();
      }
      const duration = performance.now() - start;

      // Should complete 10000 checks in under 10ms
      expect(duration).toBeLessThan(10);
    });
  });

  describe('resetAutoStop() (AC5)', () => {
    it('should require confirmation', async () => {
      setAutoStopped(true, 'test');

      await expect(resetAutoStop()).rejects.toThrow();
      await expect(resetAutoStop({})).rejects.toThrow();
      await expect(resetAutoStop({ confirm: false })).rejects.toThrow();
    });

    it('should clear auto-stop state with confirmation', async () => {
      setAutoStopped(true, 'test');
      expect(isAutoStopped()).toBe(true);

      await resetAutoStop({ confirm: true });

      expect(isAutoStopped()).toBe(false);
    });

    it('should log reset event', async () => {
      setAutoStopped(true, 'test');

      const mockLog = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      await resetAutoStop({ confirm: true }, mockLog);

      expect(mockLog.info).toHaveBeenCalledWith('auto_stop_reset', expect.objectContaining({
        message: 'Auto-stop manually reset by user',
      }));
    });

    it('should reset auto-stop state in database', async () => {
      setAutoStopped(true, 'test');

      await resetAutoStop({ confirm: true });

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auto_stop_state')
      );
    });

    it('should throw with correct error code', async () => {
      setAutoStopped(true, 'test');

      try {
        await resetAutoStop({ confirm: false });
      } catch (err) {
        expect(err.code).toBe(SafetyErrorCodes.RESET_REQUIRES_CONFIRMATION);
      }
    });
  });

  describe('triggerAutoStop() (AC4)', () => {
    it('should set auto-stop state', () => {
      expect(isAutoStopped()).toBe(false);

      triggerAutoStop({
        reason: 'test_breach',
        current_pct: 0.06,
        limit_pct: 0.05,
      });

      expect(isAutoStopped()).toBe(true);
    });

    it('should log error-level message (AC4)', () => {
      const mockLog = {
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      };

      triggerAutoStop({
        reason: 'drawdown_limit_breached',
        current_pct: 0.06,
        limit_pct: 0.05,
      }, mockLog);

      expect(mockLog.error).toHaveBeenCalledWith('auto_stop_triggered', expect.objectContaining({
        message: expect.stringContaining('AUTO-STOP: Drawdown limit breached'),
      }));
    });

    it('should cancel all orders when order manager provided (AC4)', () => {
      const mockOrderManager = {
        cancelAllOrders: vi.fn(),
      };

      const mockLog = {
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      };

      triggerAutoStop({
        reason: 'test',
        current_pct: 0.06,
        limit_pct: 0.05,
      }, mockLog, mockOrderManager);

      expect(mockOrderManager.cancelAllOrders).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith('auto_stop_orders_cancelled', expect.any(Object));
    });

    it('should not block on order cancel failure', () => {
      const mockOrderManager = {
        cancelAllOrders: vi.fn().mockImplementation(() => {
          throw new Error('Cancel failed');
        }),
      };

      const mockLog = {
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      };

      // Should not throw
      expect(() => {
        triggerAutoStop({
          reason: 'test',
          current_pct: 0.06,
          limit_pct: 0.05,
        }, mockLog, mockOrderManager);
      }).not.toThrow();

      expect(mockLog.warn).toHaveBeenCalledWith('auto_stop_cancel_orders_failed', expect.any(Object));
      expect(isAutoStopped()).toBe(true); // Still stopped
    });

    it('should persist auto-stop state to database (AC4)', () => {
      triggerAutoStop({
        reason: 'test',
        current_pct: 0.06,
        limit_pct: 0.05,
      });

      expect(isAutoStopped()).toBe(true);
      // persistAutoStopState is called fire-and-forget, verify the DB call was initiated
      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auto_stop_state'),
        expect.arrayContaining([true])
      );
    });
  });

  describe('Warning Level Tracking (AC2)', () => {
    it('should track warned levels', () => {
      expect(hasWarnedAtLevel(0.035)).toBe(false);

      markWarnedAtLevel(0.035);

      expect(hasWarnedAtLevel(0.035)).toBe(true);
    });

    it('should use 0.5% buckets for warnings', () => {
      markWarnedAtLevel(0.033);

      // Same bucket (0.03-0.035)
      expect(hasWarnedAtLevel(0.034)).toBe(true);

      // Different bucket
      expect(hasWarnedAtLevel(0.038)).toBe(false);
    });

    it('should clear warned levels on reset', () => {
      markWarnedAtLevel(0.035);
      expect(hasWarnedAtLevel(0.035)).toBe(true);

      clearWarnedLevels();

      expect(hasWarnedAtLevel(0.035)).toBe(false);
    });
  });

  describe('Auto-Stop State DB Persistence (AC4, AC5)', () => {
    it('should persist state to database', async () => {
      setAutoStopped(true, 'test');

      await persistAutoStopState();

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auto_stop_state'),
        expect.arrayContaining([true, expect.any(String), 'test', today])
      );
    });

    it('should load state from database if current day', async () => {
      persistence.get.mockResolvedValueOnce({
        id: 1,
        auto_stopped: true,
        auto_stopped_at: new Date().toISOString(),
        auto_stop_reason: 'persisted_test',
        date: today,
        updated_at: new Date().toISOString(),
      });

      // Clear current state first
      clearAutoStopState();
      expect(isAutoStopped()).toBe(false);

      const loaded = await loadAutoStopState();

      expect(loaded).not.toBeNull();
      expect(loaded.autoStopped).toBe(true);
      expect(isAutoStopped()).toBe(true);
    });

    it('should ignore state from previous day', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      persistence.get.mockResolvedValueOnce({
        id: 1,
        auto_stopped: true,
        auto_stopped_at: yesterday.toISOString(),
        auto_stop_reason: 'old_test',
        date: yesterdayStr,
        updated_at: yesterday.toISOString(),
      });

      const loaded = await loadAutoStopState();

      expect(loaded).toBeNull();
      expect(isAutoStopped()).toBe(false);
    });

    it('should handle missing database row gracefully', async () => {
      persistence.get.mockResolvedValueOnce(undefined);

      const loaded = await loadAutoStopState();

      expect(loaded).toBeNull();
    });

    it('should handle database errors gracefully', async () => {
      persistence.get.mockRejectedValueOnce(new Error('DB connection failed'));

      const mockLog = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      const loaded = await loadAutoStopState(mockLog);

      expect(loaded).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith('auto_stop_state_load_failed', expect.objectContaining({
        error: 'DB connection failed',
      }));
    });
  });

  describe('Auto-Stop Only Triggers Once (Edge Cases)', () => {
    it('should not trigger auto-stop twice', () => {
      const setupCachedRecord = () => {
        setCachedRecord({
          id: 1,
          date: today,
          starting_balance: 1000,
          current_balance: 940,
          realized_pnl: -60,
          unrealized_pnl: 0,
          drawdown_pct: 0.06,
          max_drawdown_pct: 0.06,
          trades_count: 1,
          wins: 0,
          losses: 1,
          updated_at: new Date().toISOString(),
        }, today);
      };

      setupCachedRecord();

      const mockLog = {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };

      // First check - triggers auto-stop
      checkDrawdownLimit(mockLog);
      expect(mockLog.error).toHaveBeenCalledTimes(1);

      // Second check - already auto-stopped, should not trigger again
      checkDrawdownLimit(mockLog);
      expect(mockLog.error).toHaveBeenCalledTimes(1); // Still 1
    });
  });
});

describe('Module Interface (AC6)', () => {
  it('should export checkDrawdownLimit from safety module', async () => {
    // This tests the public interface
    const safetyModule = await import('../index.js');

    expect(typeof safetyModule.checkDrawdownLimit).toBe('function');
    expect(typeof safetyModule.isAutoStopped).toBe('function');
    expect(typeof safetyModule.resetAutoStop).toBe('function');
  });
});
