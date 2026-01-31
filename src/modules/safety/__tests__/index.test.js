/**
 * Safety Module Public Interface Tests
 *
 * Tests the module interface: init, getState, shutdown, and public methods.
 * Uses vitest with mocked dependencies.
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
    run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  },
}));

// Import after mocks
import persistence from '../../../persistence/index.js';
import * as safety from '../index.js';
import { clearCache, setConfig } from '../state.js';

describe('Safety Module', () => {
  const mockConfig = {
    safety: {
      startingCapital: 1000,
      unrealizedUpdateIntervalMs: 5000,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
    // Ensure module is in clean state
    try {
      safety.shutdown();
    } catch {
      // Ignore if not initialized
    }
  });

  afterEach(async () => {
    try {
      await safety.shutdown();
    } catch {
      // Ignore cleanup errors
    }
    clearCache();
  });

  describe('init()', () => {
    it('should initialize successfully with valid config', async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });

      await safety.init(mockConfig);

      const state = safety.getState();
      expect(state.initialized).toBe(true);
    });

    it('should throw if already initialized', async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });

      await safety.init(mockConfig);

      await expect(safety.init(mockConfig)).rejects.toThrow('already initialized');
    });

    it('should create today\'s daily performance record', async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get
        .mockReturnValueOnce(null)
        .mockReturnValueOnce({
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
        });

      await safety.init(mockConfig);

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO daily_performance'),
        expect.any(Array)
      );
    });
  });

  describe('recordRealizedPnl()', () => {
    beforeEach(async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await safety.shutdown();

      expect(() => safety.recordRealizedPnl(-50)).toThrow('not initialized');
    });

    it('should record realized P&L and update drawdown', () => {
      const result = safety.recordRealizedPnl(-50);

      expect(result.realized_pnl).toBe(-50);
      expect(result.current_balance).toBe(950);
      expect(result.drawdown_pct).toBeCloseTo(0.05);
    });

    it('should track wins and losses', () => {
      safety.recordRealizedPnl(100); // Win
      safety.recordRealizedPnl(-50); // Loss
      const result = safety.recordRealizedPnl(-25); // Loss

      expect(result.wins).toBe(1);
      expect(result.losses).toBe(2);
      expect(result.trades_count).toBe(3);
    });
  });

  describe('updateUnrealizedPnl()', () => {
    beforeEach(async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await safety.shutdown();

      expect(() => safety.updateUnrealizedPnl(-30)).toThrow('not initialized');
    });

    it('should update unrealized P&L', () => {
      const result = safety.updateUnrealizedPnl(-30);

      expect(result.unrealized_pnl).toBe(-30);
    });
  });

  describe('getDrawdownStatus()', () => {
    beforeEach(async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await safety.shutdown();

      expect(() => safety.getDrawdownStatus()).toThrow('not initialized');
    });

    it('should return complete drawdown information', () => {
      const status = safety.getDrawdownStatus();

      expect(status.initialized).toBe(true);
      expect(status.starting_balance).toBe(1000);
      expect(status.current_balance).toBe(980);
      expect(status.realized_pnl).toBe(-20);
      expect(status.unrealized_pnl).toBe(-30);
      expect(status.effective_balance).toBe(950);
      expect(status.total_drawdown_pct).toBeCloseTo(0.05);
      expect(status.trades_count).toBe(1);
      expect(status.wins).toBe(0);
      expect(status.losses).toBe(1);
    });
  });

  describe('getState()', () => {
    it('should return uninitialized state before init', () => {
      const state = safety.getState();

      expect(state.initialized).toBe(false);
      expect(state.drawdown).toBeNull();
    });

    it('should return full state after init', async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);

      const state = safety.getState();

      expect(state.initialized).toBe(true);
      expect(state.drawdown).toBeDefined();
      expect(state.drawdown.initialized).toBe(true);
    });
  });

  describe('shutdown()', () => {
    it('should shutdown gracefully', async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);

      await safety.shutdown();

      const state = safety.getState();
      expect(state.initialized).toBe(false);
    });

    it('should be idempotent', async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);

      await safety.shutdown();
      await safety.shutdown(); // Should not throw

      const state = safety.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('Integration Scenarios', () => {
    beforeEach(async () => {
      const today = new Date().toISOString().split('T')[0];
      persistence.get.mockReturnValue({
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
      });
      await safety.init(mockConfig);
    });

    it('should track a trading day with mixed results', () => {
      // Morning: slight loss
      safety.recordRealizedPnl(-20);
      expect(safety.getDrawdownStatus().drawdown_pct).toBeCloseTo(0.02);

      // Add unrealized loss from open positions
      safety.updateUnrealizedPnl(-30);
      expect(safety.getDrawdownStatus().total_drawdown_pct).toBeCloseTo(0.05);

      // Afternoon: profit
      safety.recordRealizedPnl(50);
      expect(safety.getDrawdownStatus().realized_pnl).toBe(30);

      // End of day: close positions at small profit
      safety.updateUnrealizedPnl(0);
      safety.recordRealizedPnl(10);

      const finalStatus = safety.getDrawdownStatus();
      expect(finalStatus.realized_pnl).toBe(40);
      expect(finalStatus.trades_count).toBe(3);
      expect(finalStatus.wins).toBe(2);
      expect(finalStatus.losses).toBe(1);
      // Max drawdown should still reflect worst point
      expect(finalStatus.max_drawdown_pct).toBeCloseTo(0.02);
    });

    it('should calculate drawdown example from Dev Notes', () => {
      // Example from story:
      // Starting balance: $1000
      // Realized P&L: -$20 (lost on closed trades)
      // Current balance: $980
      // Unrealized P&L: -$30 (open positions are down)
      // Effective balance: $950
      // Realized drawdown: (1000 - 980) / 1000 = 2%
      // Total drawdown: (1000 - 950) / 1000 = 5%

      safety.recordRealizedPnl(-20);
      safety.updateUnrealizedPnl(-30);

      const status = safety.getDrawdownStatus();
      expect(status.current_balance).toBe(980);
      expect(status.effective_balance).toBe(950);
      expect(status.drawdown_pct).toBeCloseTo(0.02);       // 2% realized
      expect(status.total_drawdown_pct).toBeCloseTo(0.05); // 5% total
    });
  });
});
