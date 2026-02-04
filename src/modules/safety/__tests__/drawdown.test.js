/**
 * Drawdown Tracking Logic Tests
 *
 * Tests the core drawdown calculation and daily performance record management.
 * Uses vitest with mocked dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn(),
    all: vi.fn().mockResolvedValue([]),
  },
}));

// Import after mocks
import persistence from '../../../persistence/index.js';
import {
  getTodayDate,
  getOrCreateTodayRecord,
  recordRealizedPnl,
  updateUnrealizedPnl,
  getDrawdownStatus,
  isCacheStale,
} from '../drawdown.js';
import { clearCache, setCachedRecord, setConfig, getCachedRecord } from '../state.js';

describe('Drawdown Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    // Set default config
    setConfig({
      safety: {
        startingCapital: 1000,
      },
    });
  });

  afterEach(() => {
    clearCache();
  });

  describe('getTodayDate()', () => {
    it('returns date in YYYY-MM-DD format', () => {
      const date = getTodayDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns current date', () => {
      const expected = new Date().toISOString().split('T')[0];
      expect(getTodayDate()).toBe(expected);
    });
  });

  describe('getOrCreateTodayRecord()', () => {
    it('should create new record for new day', () => {
      const today = getTodayDate();
      persistence.get.mockReturnValue(null);

      const record = getOrCreateTodayRecord();

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO daily_performance'),
        expect.arrayContaining([today, 1000, 1000])
      );
    });

    it('should reuse existing record for same day', () => {
      const today = getTodayDate();
      const existingRecord = {
        id: 1,
        date: today,
        starting_balance: 1000,
        current_balance: 980,
        realized_pnl: -20,
        unrealized_pnl: 0,
        drawdown_pct: 0.02,
        max_drawdown_pct: 0.02,
        trades_count: 1,
        wins: 0,
        losses: 1,
        updated_at: new Date().toISOString(),
      };

      persistence.get.mockReturnValue(existingRecord);

      const record = getOrCreateTodayRecord();

      // Should not insert new record
      expect(persistence.run).not.toHaveBeenCalled();
      expect(record.id).toBe(1);
      expect(record.realized_pnl).toBe(-20);
    });

    it('should use cached record on second call', () => {
      const today = getTodayDate();
      const dbRecord = {
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
      };

      persistence.get.mockReturnValue(dbRecord);

      // First call - loads from DB
      const record1 = getOrCreateTodayRecord();
      expect(persistence.get).toHaveBeenCalledTimes(1);

      // Second call - uses cache
      const record2 = getOrCreateTodayRecord();
      expect(persistence.get).toHaveBeenCalledTimes(1); // Not called again
      expect(record2.id).toBe(record1.id);
    });

    it('should use starting capital from config', () => {
      setConfig({
        safety: {
          startingCapital: 5000,
        },
      });

      persistence.get
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
          id: 1,
          date: getTodayDate(),
          starting_balance: 5000,
          current_balance: 5000,
          realized_pnl: 0,
          unrealized_pnl: 0,
          drawdown_pct: 0,
          max_drawdown_pct: 0,
          trades_count: 0,
          wins: 0,
          losses: 0,
          updated_at: new Date().toISOString(),
        });

      getOrCreateTodayRecord();

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO daily_performance'),
        expect.arrayContaining([5000, 5000])
      );
    });
  });

  describe('recordRealizedPnl()', () => {
    const setupCachedRecord = (overrides = {}) => {
      const today = getTodayDate();
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

    it('should update realized P&L correctly for loss', () => {
      setupCachedRecord();

      const result = recordRealizedPnl(-50);

      expect(result.realized_pnl).toBe(-50);
      expect(result.current_balance).toBe(950);
      expect(result.drawdown_pct).toBeCloseTo(0.05); // 5% drawdown
      expect(result.trades_count).toBe(1);
      expect(result.losses).toBe(1);
      expect(result.wins).toBe(0);
    });

    it('should update realized P&L correctly for profit', () => {
      setupCachedRecord();

      const result = recordRealizedPnl(100);

      expect(result.realized_pnl).toBe(100);
      expect(result.current_balance).toBe(1100);
      expect(result.drawdown_pct).toBeCloseTo(-0.10); // -10% = 10% profit
      expect(result.trades_count).toBe(1);
      expect(result.wins).toBe(1);
      expect(result.losses).toBe(0);
    });

    it('should accumulate P&L across multiple trades', () => {
      setupCachedRecord();

      recordRealizedPnl(-20); // First trade: loss
      recordRealizedPnl(50);  // Second trade: profit
      const result = recordRealizedPnl(-10); // Third trade: loss

      expect(result.realized_pnl).toBe(20); // -20 + 50 - 10 = 20
      expect(result.current_balance).toBe(1020);
      expect(result.trades_count).toBe(3);
      expect(result.wins).toBe(1);
      expect(result.losses).toBe(2);
    });

    it('should track max drawdown correctly', () => {
      setupCachedRecord();

      // First trade: 5% loss
      recordRealizedPnl(-50);
      expect(getCachedRecord().max_drawdown_pct).toBeCloseTo(0.05);

      // Second trade: recover some, but max stays at 5%
      recordRealizedPnl(30);
      expect(getCachedRecord().drawdown_pct).toBeCloseTo(0.02);
      expect(getCachedRecord().max_drawdown_pct).toBeCloseTo(0.05);

      // Third trade: new max drawdown of 7%
      recordRealizedPnl(-50);
      expect(getCachedRecord().drawdown_pct).toBeCloseTo(0.07);
      expect(getCachedRecord().max_drawdown_pct).toBeCloseTo(0.07);
    });

    it('should persist to database', () => {
      setupCachedRecord();

      recordRealizedPnl(-25);

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE daily_performance'),
        expect.arrayContaining([-25, 975])
      );
    });

    it('should throw for invalid P&L amount', () => {
      setupCachedRecord();

      expect(() => recordRealizedPnl('invalid')).toThrow('Invalid P&L amount');
      expect(() => recordRealizedPnl(NaN)).toThrow('Invalid P&L amount');
      expect(() => recordRealizedPnl(Infinity)).toThrow('Invalid P&L amount');
    });

    it('should count zero P&L trades as neither win nor loss', () => {
      setupCachedRecord();

      const result = recordRealizedPnl(0);

      expect(result.trades_count).toBe(1);
      expect(result.wins).toBe(0);
      expect(result.losses).toBe(0);
    });
  });

  describe('updateUnrealizedPnl()', () => {
    it('should update unrealized P&L', () => {
      const today = getTodayDate();
      setCachedRecord({
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
      }, today);

      const result = updateUnrealizedPnl(-30);

      expect(result.unrealized_pnl).toBe(-30);
      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE daily_performance'),
        expect.arrayContaining([-30])
      );
    });

    it('should throw for invalid amount', () => {
      const today = getTodayDate();
      setCachedRecord({
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
      }, today);

      expect(() => updateUnrealizedPnl('invalid')).toThrow('Invalid unrealized P&L amount');
    });
  });

  describe('getDrawdownStatus()', () => {
    it('should return uninitialized status when no record', () => {
      const status = getDrawdownStatus();

      expect(status.initialized).toBe(false);
      expect(status.drawdown_pct).toBe(0);
      expect(status.max_drawdown_pct).toBe(0);
      expect(status.total_drawdown_pct).toBe(0);
    });

    it('should return complete info when initialized', () => {
      const today = getTodayDate();
      setCachedRecord({
        id: 1,
        date: today,
        starting_balance: 1000,
        current_balance: 980,
        realized_pnl: -20,
        unrealized_pnl: -30,
        drawdown_pct: 0.02,
        max_drawdown_pct: 0.05,
        trades_count: 3,
        wins: 1,
        losses: 2,
        updated_at: new Date().toISOString(),
      }, today);

      const status = getDrawdownStatus();

      expect(status.initialized).toBe(true);
      expect(status.date).toBe(today);
      expect(status.starting_balance).toBe(1000);
      expect(status.current_balance).toBe(980);
      expect(status.effective_balance).toBe(950); // 980 - 30
      expect(status.realized_pnl).toBe(-20);
      expect(status.unrealized_pnl).toBe(-30);
      expect(status.drawdown_pct).toBe(0.02);
      expect(status.max_drawdown_pct).toBe(0.05);
      expect(status.total_drawdown_pct).toBeCloseTo(0.05); // (1000 - 950) / 1000
      expect(status.trades_count).toBe(3);
      expect(status.wins).toBe(1);
      expect(status.losses).toBe(2);
    });

    it('should calculate total drawdown including unrealized', () => {
      const today = getTodayDate();
      // Scenario: $20 realized loss + $30 unrealized loss = 5% total drawdown
      setCachedRecord({
        id: 1,
        date: today,
        starting_balance: 1000,
        current_balance: 980,
        realized_pnl: -20,
        unrealized_pnl: -30,
        drawdown_pct: 0.02,
        max_drawdown_pct: 0.02,
        trades_count: 1,
        wins: 0,
        losses: 1,
        updated_at: new Date().toISOString(),
      }, today);

      const status = getDrawdownStatus();

      expect(status.drawdown_pct).toBeCloseTo(0.02);       // 2% realized
      expect(status.total_drawdown_pct).toBeCloseTo(0.05); // 5% total
    });
  });

  describe('isCacheStale()', () => {
    it('should return true when cache is empty', () => {
      expect(isCacheStale()).toBe(true);
    });

    it('should return false when cache is fresh', () => {
      const today = getTodayDate();
      setCachedRecord({
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
      }, today);

      expect(isCacheStale()).toBe(false);
    });

    it('should return true when cache date differs from today', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      setCachedRecord({
        id: 1,
        date: yesterdayStr,
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
      }, yesterdayStr);

      expect(isCacheStale()).toBe(true);
    });
  });
});
