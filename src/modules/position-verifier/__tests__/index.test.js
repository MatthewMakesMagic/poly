/**
 * Position Verifier Module Tests
 *
 * V3 Stage 5: Tests for position verification against
 * Polymarket Data API with cache and rate limit handling.
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

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import * as positionVerifier from '../index.js';

describe('Position Verifier Module', () => {
  const liveConfig = {
    tradingMode: 'LIVE',
    polymarket: {
      funder: '0xABC123',
    },
  };

  const paperConfig = {
    tradingMode: 'PAPER',
    polymarket: {
      funder: '0xABC123',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await positionVerifier.shutdown();
    } catch {
      // Ignore
    }
  });

  describe('init()', () => {
    it('should initialize with wallet address from config', async () => {
      await positionVerifier.init(liveConfig);
      const state = positionVerifier.getState();

      expect(state.initialized).toBe(true);
      expect(state.hasWallet).toBe(true);
      expect(state.tradingMode).toBe('LIVE');
    });

    it('should handle missing wallet address', async () => {
      await positionVerifier.init({ tradingMode: 'LIVE', polymarket: {} });
      const state = positionVerifier.getState();

      expect(state.initialized).toBe(true);
      expect(state.hasWallet).toBe(false);
    });

    it('should be idempotent', async () => {
      await positionVerifier.init(liveConfig);
      await positionVerifier.init(liveConfig);

      expect(positionVerifier.getState().initialized).toBe(true);
    });
  });

  describe('verify() - PAPER mode', () => {
    it('should skip verification in PAPER mode', async () => {
      await positionVerifier.init(paperConfig);

      const result = await positionVerifier.verify([{ token_id: 'abc' }]);

      expect(result.verified).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.mode).toBe('PAPER');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('verify() - LIVE mode', () => {
    beforeEach(async () => {
      await positionVerifier.init(liveConfig);
    });

    it('should return verified when positions match', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([
          { asset: 'token-1', size: '10' },
          { asset: 'token-2', size: '5' },
        ]),
      });

      const localPositions = [
        { token_id: 'token-1', size: 10 },
        { token_id: 'token-2', size: 5 },
      ];

      const result = await positionVerifier.verify(localPositions);

      expect(result.verified).toBe(true);
      expect(result.orphans).toHaveLength(0);
    });

    it('should ignore extra exchange positions (manual trades, stale data)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([
          { asset: 'token-1', size: '10' },
          { asset: 'token-unknown', size: '5' },
        ]),
      });

      const localPositions = [{ token_id: 'token-1', size: 10 }];
      const result = await positionVerifier.verify(localPositions);

      // Extra exchange positions are not our concern — verified passes
      expect(result.verified).toBe(true);
      expect(result.orphans).toHaveLength(0);
    });

    it('should detect orphan positions (local has, exchange does not)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([
          { asset: 'token-1', size: '10' },
        ]),
      });

      const localPositions = [
        { token_id: 'token-1', size: 10 },
        { token_id: 'token-orphan', size: 5 },
      ];

      const result = await positionVerifier.verify(localPositions);

      // Orphans are informational — verification still passes
      expect(result.verified).toBe(true);
      expect(result.orphans).toHaveLength(1);
      expect(result.orphans[0].token_id).toBe('token-orphan');
    });

    it('should return verified for empty local positions', async () => {
      const result = await positionVerifier.verify([]);

      expect(result.verified).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should cache successful responses', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ asset: 'token-1', size: '10' }]),
      });

      await positionVerifier.verify([{ token_id: 'token-1' }]);

      const state = positionVerifier.getState();
      expect(state.hasCachedData).toBe(true);
      expect(state.cacheAge).toBeLessThan(1000);
    });

    it('should return error for missing wallet', async () => {
      await positionVerifier.shutdown();
      await positionVerifier.init({ tradingMode: 'LIVE', polymarket: {} });

      const result = await positionVerifier.verify([{ token_id: 'abc' }]);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('No wallet');
    });
  });

  describe('verify() - rate limit handling', () => {
    beforeEach(async () => {
      await positionVerifier.init(liveConfig);
    });

    it('should use fresh cache on 429', async () => {
      // First call: populate cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ asset: 'token-1', size: '10' }]),
      });
      await positionVerifier.verify([{ token_id: 'token-1' }]);

      // Second call: 429 with fresh cache
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const result = await positionVerifier.verify([{ token_id: 'token-1' }]);
      expect(result.verified).toBe(true);
    });

    it('should throw on 429 with stale cache', async () => {
      // No cache populated - any 429 should throw
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(
        positionVerifier.verify([{ token_id: 'token-1' }])
      ).rejects.toThrow('rate limited');
    });
  });

  describe('getState()', () => {
    it('should return uninitialized state before init', () => {
      const state = positionVerifier.getState();
      expect(state.initialized).toBe(false);
    });

    it('should report cache state after verification', async () => {
      await positionVerifier.init(liveConfig);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await positionVerifier.verify([{ token_id: 'token-1' }]);

      const state = positionVerifier.getState();
      expect(state.hasCachedData).toBe(true);
      expect(state.cacheTimestamp).toBeTruthy();
    });
  });

  describe('shutdown()', () => {
    it('should clean up all state', async () => {
      await positionVerifier.init(liveConfig);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });
      await positionVerifier.verify([{ token_id: 'x' }]);

      await positionVerifier.shutdown();
      const state = positionVerifier.getState();

      expect(state.initialized).toBe(false);
      expect(state.hasCachedData).toBe(false);
    });
  });
});
