/**
 * Phase 0.7: Mode-Aware Position Query Tests
 *
 * Tests that getPositions(mode) correctly filters by mode,
 * and that positions with mode='PAPER' go through the same pipeline
 * as mode='LIVE' and mode='DRY_RUN'.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    runReturningId: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue(undefined),
    all: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../persistence/write-ahead.js', () => ({
  logIntent: vi.fn().mockReturnValue(1),
  markExecuting: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  INTENT_TYPES: { OPEN_POSITION: 'open_position', CLOSE_POSITION: 'close_position' },
}));

vi.mock('../../safety/index.js', () => ({
  recordRealizedPnl: vi.fn(),
}));

// Import after mocks
import persistence from '../../../persistence/index.js';
import * as logic from '../logic.js';

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('Mode-aware position queries (Phase 0.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPositions(mode)', () => {
    it('queries all open positions when mode is omitted', async () => {
      persistence.all.mockResolvedValue([]);
      await logic.getPositions();

      const call = persistence.all.mock.calls[0];
      expect(call[0]).toContain('WHERE status = $1');
      expect(call[0]).not.toContain('mode');
      expect(call[1]).toEqual(['open']);
    });

    it('filters by mode when mode is provided', async () => {
      persistence.all.mockResolvedValue([]);
      await logic.getPositions('PAPER');

      const call = persistence.all.mock.calls[0];
      expect(call[0]).toContain('AND mode = $2');
      expect(call[1]).toEqual(['open', 'PAPER']);
    });

    it('filters by LIVE mode', async () => {
      persistence.all.mockResolvedValue([]);
      await logic.getPositions('LIVE');

      const call = persistence.all.mock.calls[0];
      expect(call[1]).toEqual(['open', 'LIVE']);
    });

    it('filters by DRY_RUN mode', async () => {
      persistence.all.mockResolvedValue([]);
      await logic.getPositions('DRY_RUN');

      const call = persistence.all.mock.calls[0];
      expect(call[1]).toEqual(['open', 'DRY_RUN']);
    });

    it('adds unrealized_pnl to returned positions', async () => {
      persistence.all.mockResolvedValue([
        { id: 1, side: 'long', entry_price: 0.50, current_price: 0.55, size: 10 },
      ]);

      const positions = await logic.getPositions('PAPER');

      expect(positions[0].unrealized_pnl).toBeCloseTo(0.5, 4); // (0.55-0.50)*10*1
    });
  });

  describe('addPosition with mode', () => {
    it('persists PAPER mode when specified', async () => {
      persistence.get.mockResolvedValue({ count: 0, total: 0 });
      persistence.runReturningId.mockResolvedValue({ lastInsertRowid: 42, changes: 1 });

      const result = await logic.addPosition({
        windowId: 'btc-15m-1000',
        marketId: 'market-1',
        tokenId: 'token-1',
        side: 'long',
        size: 5,
        entryPrice: 0.52,
        strategyId: 'vwap-contrarian',
        mode: 'PAPER',
      }, mockLog);

      expect(result.mode).toBe('PAPER');

      // Verify the INSERT includes mode='PAPER'
      const insertCall = persistence.runReturningId.mock.calls[0];
      expect(insertCall[0]).toContain('mode');
      expect(insertCall[1]).toContain('PAPER');
    });

    it('defaults to LIVE when mode is not specified', async () => {
      persistence.get.mockResolvedValue({ count: 0, total: 0 });
      persistence.runReturningId.mockResolvedValue({ lastInsertRowid: 43, changes: 1 });

      const result = await logic.addPosition({
        windowId: 'btc-15m-1001',
        marketId: 'market-2',
        tokenId: 'token-2',
        side: 'long',
        size: 3,
        entryPrice: 0.48,
        strategyId: 'vwap-contrarian',
      }, mockLog);

      expect(result.mode).toBe('LIVE');

      // Verify the INSERT includes mode='LIVE'
      const insertCall = persistence.runReturningId.mock.calls[0];
      expect(insertCall[1]).toContain('LIVE');
    });
  });
});
