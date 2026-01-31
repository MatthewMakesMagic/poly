/**
 * Position Manager Module Tests
 *
 * Tests the public interface of the position manager module.
 * Uses vitest with mocked dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
  },
  run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../persistence/write-ahead.js', () => ({
  logIntent: vi.fn().mockReturnValue(1),
  markExecuting: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  INTENT_TYPES: { OPEN_POSITION: 'open_position', CLOSE_POSITION: 'close_position' },
}));

vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Import after mocks
import * as positionManager from '../index.js';
import * as writeAhead from '../../../persistence/write-ahead.js';
import persistence from '../../../persistence/index.js';

describe('Position Manager Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state before each test
    await positionManager.shutdown();
  });

  afterEach(async () => {
    await positionManager.shutdown();
  });

  describe('init()', () => {
    it('initializes module and updates state', async () => {
      const stateBefore = positionManager.getState();
      expect(stateBefore.initialized).toBe(false);

      await positionManager.init({});

      const stateAfter = positionManager.getState();
      expect(stateAfter.initialized).toBe(true);
    });

    it('is idempotent - can be called multiple times', async () => {
      await positionManager.init({});
      await positionManager.init({});

      expect(positionManager.getState().initialized).toBe(true);
    });

    it('loads open positions from database on init', async () => {
      persistence.all.mockReturnValueOnce([
        { id: 1, status: 'open', window_id: 'w1', market_id: 'm1', token_id: 't1', side: 'long', size: 100, entry_price: 0.5, current_price: 0.5, strategy_id: 's1', opened_at: '2026-01-30T00:00:00Z' },
      ]);

      await positionManager.init({});

      expect(persistence.all).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM positions'),
        ['open']
      );
    });
  });

  describe('addPosition()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      await expect(
        positionManager.addPosition({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: 100,
          entryPrice: 0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position manager not initialized');
    });

    it('logs intent BEFORE database insert', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      // Verify logIntent was called before database run
      const logIntentCallOrder = writeAhead.logIntent.mock.invocationCallOrder[0];
      const runCallOrder = persistence.run.mock.invocationCallOrder[0];
      expect(logIntentCallOrder).toBeLessThan(runCallOrder);

      // Verify intent was logged with correct type
      expect(writeAhead.logIntent).toHaveBeenCalledWith(
        'open_position',
        'window-1',
        expect.objectContaining({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: 100,
          entryPrice: 0.5,
        })
      );
    });

    it('marks intent as executing before database insert', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      expect(writeAhead.markExecuting).toHaveBeenCalledWith(1);

      // markExecuting should be called before database run
      const markExecutingOrder = writeAhead.markExecuting.mock.invocationCallOrder[0];
      const runOrder = persistence.run.mock.invocationCallOrder[0];
      expect(markExecutingOrder).toBeLessThan(runOrder);
    });

    it('persists position to database with correct fields', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO positions'),
        expect.arrayContaining([
          'window-1', // window_id
          'market-1', // market_id
          'token-1', // token_id
          'long', // side
          100, // size
          0.5, // entry_price
          0.5, // current_price (starts as entry_price)
          'open', // status
          'strategy-1', // strategy_id
        ])
      );
    });

    it('marks intent completed on success', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      expect(writeAhead.markCompleted).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          positionId: 1,
        })
      );
    });

    it('returns position record with id', async () => {
      const result = await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: 1,
          window_id: 'window-1',
          market_id: 'market-1',
          token_id: 'token-1',
          side: 'long',
          size: 100,
          entry_price: 0.5,
          current_price: 0.5,
          status: 'open',
          strategy_id: 'strategy-1',
        })
      );
    });

    it('rejects duplicate positions', async () => {
      persistence.run.mockImplementationOnce(() => {
        const error = new Error('UNIQUE constraint failed: positions.window_id, positions.market_id, positions.token_id');
        throw error;
      });

      await expect(
        positionManager.addPosition({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: 100,
          entryPrice: 0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position already exists');

      expect(writeAhead.markFailed).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          code: 'DUPLICATE_POSITION',
        })
      );
    });

    it('fails when limits exceeded with risk config', async () => {
      await positionManager.shutdown();

      // Initialize with risk config
      await positionManager.init({
        risk: {
          maxPositionSize: 100,
          maxExposure: 500,
          positionLimitPerMarket: 1,
        },
      });

      // Try to add position exceeding maxPositionSize
      await expect(
        positionManager.addPosition({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: 150, // Exceeds maxPositionSize of 100
          entryPrice: 0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position size 150 exceeds maximum 100');
    });
  });

  describe('validation', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws validation error for missing windowId', async () => {
      await expect(
        positionManager.addPosition({
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: 100,
          entryPrice: 0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position validation failed');
    });

    it('throws validation error for invalid side', async () => {
      await expect(
        positionManager.addPosition({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'invalid',
          size: 100,
          entryPrice: 0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position validation failed');
    });

    it('throws validation error for negative size', async () => {
      await expect(
        positionManager.addPosition({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: -100,
          entryPrice: 0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position validation failed');
    });

    it('throws validation error for negative entryPrice', async () => {
      await expect(
        positionManager.addPosition({
          windowId: 'window-1',
          marketId: 'market-1',
          tokenId: 'token-1',
          side: 'long',
          size: 100,
          entryPrice: -0.5,
          strategyId: 'strategy-1',
        })
      ).rejects.toThrow('Position validation failed');
    });
  });

  describe('getPosition()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      expect(() => positionManager.getPosition(1)).toThrow(
        'Position manager not initialized'
      );
    });

    it('returns position from cache after adding', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      const position = positionManager.getPosition(1);
      expect(position).toBeDefined();
      expect(position.id).toBe(1);
      expect(position.token_id).toBe('token-1');
    });

    it('includes unrealized_pnl in response', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      const position = positionManager.getPosition(1);
      expect(position.unrealized_pnl).toBeDefined();
      expect(position.unrealized_pnl).toBe(0); // Same entry and current price
    });

    it('falls back to database if not in cache', async () => {
      persistence.get.mockReturnValueOnce({
        id: 99,
        window_id: 'w1',
        market_id: 'm1',
        token_id: 't1',
        side: 'long',
        size: 100,
        entry_price: 0.5,
        current_price: 0.6,
        status: 'open',
        strategy_id: 's1',
        opened_at: '2026-01-30T00:00:00Z',
      });

      const position = positionManager.getPosition(99);
      expect(position).toBeDefined();
      expect(position.id).toBe(99);
      expect(persistence.get).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM positions'),
        [99]
      );
    });

    it('returns undefined for non-existent position', async () => {
      persistence.get.mockReturnValueOnce(undefined);

      const position = positionManager.getPosition(999);
      expect(position).toBeUndefined();
    });
  });

  describe('getPositions()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      expect(() => positionManager.getPositions()).toThrow(
        'Position manager not initialized'
      );
    });

    it('returns open positions from cache', async () => {
      // Add positions to cache via addPosition
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      persistence.run.mockReturnValueOnce({ lastInsertRowid: 2, changes: 1 });
      await positionManager.addPosition({
        windowId: 'window-2',
        marketId: 'market-2',
        tokenId: 'token-2',
        side: 'short',
        size: 50,
        entryPrice: 0.6,
        strategyId: 'strategy-2',
      });

      const positions = positionManager.getPositions();
      expect(positions).toHaveLength(2);
      // Verify both positions are returned from cache
      expect(positions.some((p) => p.window_id === 'window-1')).toBe(true);
      expect(positions.some((p) => p.window_id === 'window-2')).toBe(true);
    });

    it('returns only open positions', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      // Mock database to return the placed position
      persistence.all.mockReturnValueOnce([
        { id: 1, status: 'open', side: 'long', size: 100, entry_price: 0.5, current_price: 0.5 },
      ]);

      const openPositions = positionManager.getPositions();
      expect(openPositions.length).toBeGreaterThanOrEqual(1);
      expect(openPositions.every((p) => p.status === 'open')).toBe(true);
    });

    it('includes unrealized_pnl for each position', async () => {
      persistence.all.mockReturnValueOnce([
        { id: 1, status: 'open', side: 'long', size: 100, entry_price: 0.5, current_price: 0.6 },
      ]);

      const positions = positionManager.getPositions();
      expect(positions[0].unrealized_pnl).toBeDefined();
    });
  });

  describe('closePosition()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      await expect(positionManager.closePosition(1, {})).rejects.toThrow(
        'Position manager not initialized'
      );
    });

    it('throws if position not found', async () => {
      await expect(positionManager.closePosition(999, {})).rejects.toThrow(
        'Position not found: 999'
      );
    });

    it('closes position with normal close flow', async () => {
      // First add a position
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      vi.clearAllMocks();

      // Close the position
      const result = await positionManager.closePosition(1, {});

      expect(result.status).toBe('closed');
      expect(result.pnl).toBeDefined();
      expect(writeAhead.logIntent).toHaveBeenCalledWith(
        'close_position',
        'window-1',
        expect.objectContaining({
          positionId: 1,
          emergency: false,
        })
      );
    });

    it('closes position with emergency flag', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      vi.clearAllMocks();

      const result = await positionManager.closePosition(1, { emergency: true });

      expect(result.status).toBe('closed');
      expect(writeAhead.logIntent).toHaveBeenCalledWith(
        'close_position',
        'window-1',
        expect.objectContaining({
          emergency: true,
        })
      );
    });

    it('updates position status, pnl, and closed_at', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      // Update price to create P&L
      positionManager.updatePrice(1, 0.6);

      const result = await positionManager.closePosition(1, {});

      expect(result.status).toBe('closed');
      expect(result.close_price).toBe(0.6);
      expect(result.closed_at).toBeDefined();
      // (0.6 - 0.5) * 100 * 1 = 10
      expect(result.pnl).toBeCloseTo(10, 5);
    });

    it('rejects closing already closed position', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      await positionManager.closePosition(1, {});

      await expect(positionManager.closePosition(1, {})).rejects.toThrow(
        'Cannot close position with status: closed'
      );
    });
  });

  describe('reconcile()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      const mockClient = { getBalance: vi.fn() };
      await expect(positionManager.reconcile(mockClient)).rejects.toThrow(
        'Position manager not initialized'
      );
    });

    it('detects divergence when exchange balance differs', async () => {
      // Add a position
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      // Mock database to return our position
      persistence.all.mockReturnValueOnce([
        {
          id: 1,
          status: 'open',
          window_id: 'window-1',
          market_id: 'market-1',
          token_id: 'token-1',
          side: 'long',
          size: 100,
          entry_price: 0.5,
          current_price: 0.5,
        },
      ]);

      // Mock exchange returns different balance
      const mockClient = { getBalance: vi.fn().mockResolvedValue(50) }; // Exchange says 50, local says 100

      const result = await positionManager.reconcile(mockClient);

      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].type).toBe('SIZE_MISMATCH');
      expect(result.divergences[0].localState.size).toBe(100);
      expect(result.divergences[0].exchangeState.balance).toBe(50);
      expect(result.success).toBe(false);
    });

    it('updates exchange_verified_at on match', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      persistence.all.mockReturnValueOnce([
        {
          id: 1,
          status: 'open',
          window_id: 'window-1',
          market_id: 'market-1',
          token_id: 'token-1',
          side: 'long',
          size: 100,
          entry_price: 0.5,
          current_price: 0.5,
        },
      ]);

      // Mock exchange returns matching balance
      const mockClient = { getBalance: vi.fn().mockResolvedValue(100) };

      const result = await positionManager.reconcile(mockClient);

      expect(result.verified).toBe(1);
      expect(result.divergences).toHaveLength(0);
      expect(result.success).toBe(true);
      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE positions SET exchange_verified_at'),
        expect.arrayContaining([1])
      );
    });

    it('logs warning for orphaned exchange positions', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      persistence.all.mockReturnValueOnce([
        {
          id: 1,
          status: 'open',
          window_id: 'window-1',
          market_id: 'market-1',
          token_id: 'token-1',
          side: 'long',
          size: 100,
          entry_price: 0.5,
          current_price: 0.5,
        },
      ]);

      // Mock exchange returns 0 (position missing on exchange)
      const mockClient = { getBalance: vi.fn().mockResolvedValue(0) };

      const result = await positionManager.reconcile(mockClient);

      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].type).toBe('MISSING_ON_EXCHANGE');
    });
  });

  describe('getCurrentExposure()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      expect(() => positionManager.getCurrentExposure()).toThrow(
        'Position manager not initialized'
      );
    });

    it('returns total exposure from open positions', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      // 100 * 0.5 = 50
      expect(positionManager.getCurrentExposure()).toBe(50);
    });
  });

  describe('updatePrice()', () => {
    beforeEach(async () => {
      await positionManager.init({});
    });

    it('throws when called before init', async () => {
      await positionManager.shutdown();

      expect(() => positionManager.updatePrice(1, 0.6)).toThrow(
        'Position manager not initialized'
      );
    });

    it('updates current_price in cache', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      const updated = positionManager.updatePrice(1, 0.6);
      expect(updated.current_price).toBe(0.6);
    });

    it('recalculates unrealized_pnl after price update', async () => {
      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      const updated = positionManager.updatePrice(1, 0.6);
      // (0.6 - 0.5) * 100 * 1 = 10
      expect(updated.unrealized_pnl).toBeCloseTo(10, 5);
    });

    it('throws if position not found', async () => {
      expect(() => positionManager.updatePrice(999, 0.6)).toThrow(
        'Position not found'
      );
    });
  });

  describe('getState()', () => {
    it('returns initialized false before init', () => {
      const state = positionManager.getState();
      expect(state.initialized).toBe(false);
    });

    it('returns initialized true after init', async () => {
      await positionManager.init({});
      const state = positionManager.getState();
      expect(state.initialized).toBe(true);
    });

    it('includes position counts and stats after adding positions', async () => {
      await positionManager.init({});

      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      const state = positionManager.getState();
      expect(state.positions).toBeDefined();
      expect(state.positions.open).toBe(1);
      expect(state.stats).toBeDefined();
      expect(state.stats.totalOpened).toBe(1);
    });

    it('includes limits and lastReconciliation when config has risk settings', async () => {
      await positionManager.init({
        risk: {
          maxPositionSize: 100,
          maxExposure: 500,
          positionLimitPerMarket: 1,
        },
      });

      const state = positionManager.getState();
      expect(state.limits).toBeDefined();
      expect(state.limits.maxPositionSize).toBe(100);
      expect(state.limits.maxExposure).toBe(500);
      expect(state.limits.currentExposure).toBe(0);
      expect(state.limits.positionLimitPerMarket).toBe(1);
    });

    it('includes lastReconciliation after reconcile()', async () => {
      await positionManager.init({});

      persistence.all.mockReturnValueOnce([]);

      const mockClient = { getBalance: vi.fn() };
      await positionManager.reconcile(mockClient);

      const state = positionManager.getState();
      expect(state.lastReconciliation).toBeDefined();
      expect(state.lastReconciliation.timestamp).toBeDefined();
      expect(state.lastReconciliation.success).toBe(true);
    });
  });

  describe('shutdown()', () => {
    it('cleans up resources and resets state', async () => {
      await positionManager.init({});
      expect(positionManager.getState().initialized).toBe(true);

      await positionManager.shutdown();
      expect(positionManager.getState().initialized).toBe(false);
    });

    it('is idempotent - can be called multiple times', async () => {
      await positionManager.init({});
      await positionManager.shutdown();
      await positionManager.shutdown();

      expect(positionManager.getState().initialized).toBe(false);
    });

    it('clears position cache', async () => {
      await positionManager.init({});

      await positionManager.addPosition({
        windowId: 'window-1',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 100,
        entryPrice: 0.5,
        strategyId: 'strategy-1',
      });

      expect(positionManager.getState().positions.open).toBe(1);

      await positionManager.shutdown();

      expect(positionManager.getState().positions.open).toBe(0);
    });
  });
});
