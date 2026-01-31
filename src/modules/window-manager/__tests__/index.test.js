/**
 * Window Manager Module Tests
 *
 * TEMP SOLUTION: Tests for the window discovery module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as windowManager from '../index.js';
import { SUPPORTED_CRYPTOS, WINDOW_DURATION_SECONDS } from '../types.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock fetch for API calls
global.fetch = vi.fn();

describe('Window Manager Module', () => {
  beforeEach(async () => {
    await windowManager.shutdown().catch(() => {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await windowManager.shutdown().catch(() => {});
  });

  describe('get15MinWindows', () => {
    it('should return correct number of windows', () => {
      const windows = windowManager.get15MinWindows(3);
      expect(windows).toHaveLength(3);
    });

    it('should return windows with correct structure', () => {
      const windows = windowManager.get15MinWindows(1);
      const window = windows[0];

      expect(window).toHaveProperty('epoch');
      expect(window).toHaveProperty('startTime');
      expect(window).toHaveProperty('endTime');
      expect(window).toHaveProperty('startsIn');
      expect(window).toHaveProperty('endsIn');
    });

    it('should have epochs 15 minutes apart', () => {
      const windows = windowManager.get15MinWindows(3);

      expect(windows[1].epoch - windows[0].epoch).toBe(WINDOW_DURATION_SECONDS);
      expect(windows[2].epoch - windows[1].epoch).toBe(WINDOW_DURATION_SECONDS);
    });

    it('should have current window first', () => {
      const windows = windowManager.get15MinWindows(1);
      const now = Math.floor(Date.now() / 1000);
      const currentEpoch = Math.floor(now / WINDOW_DURATION_SECONDS) * WINDOW_DURATION_SECONDS;

      expect(windows[0].epoch).toBe(currentEpoch);
    });
  });

  describe('init', () => {
    it('should initialize with default config', async () => {
      await windowManager.init();

      const state = windowManager.getState();
      expect(state.initialized).toBe(true);
      expect(state.cryptos).toEqual(SUPPORTED_CRYPTOS);
    });

    it('should initialize with custom cryptos', async () => {
      await windowManager.init({ cryptos: ['btc', 'eth'] });

      const state = windowManager.getState();
      expect(state.cryptos).toEqual(['btc', 'eth']);
    });
  });

  describe('getActiveWindows', () => {
    it('should throw if not initialized', async () => {
      await expect(windowManager.getActiveWindows()).rejects.toThrow('not initialized');
    });

    it('should return empty array when no markets found', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await windowManager.init({ cryptos: ['btc'] });
      const windows = await windowManager.getActiveWindows();

      expect(windows).toEqual([]);
    });

    it('should return windows when markets found', async () => {
      const mockEpoch = Math.floor(Date.now() / 1000 / 900) * 900;

      // Mock market discovery
      global.fetch.mockImplementation((url) => {
        if (url.includes('gamma-api')) {
          return Promise.resolve({
            ok: true,
            json: async () => [{
              slug: `btc-updown-15m-${mockEpoch}`,
              question: 'Will BTC go up?',
              clobTokenIds: JSON.stringify(['token-up-123', 'token-down-456']),
              outcomePrices: JSON.stringify(['0.55', '0.45']),
              endDate: new Date(mockEpoch * 1000 + 900000).toISOString(),
              volumeNum: 1000,
              liquidityNum: 500,
              active: true,
              closed: false,
            }],
          });
        }
        if (url.includes('clob.polymarket')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              bids: [{ price: '0.53', size: '100' }],
              asks: [{ price: '0.57', size: '100' }],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      await windowManager.init({ cryptos: ['btc'] });
      const windows = await windowManager.getActiveWindows();

      expect(windows.length).toBeGreaterThan(0);
      expect(windows[0]).toHaveProperty('window_id');
      expect(windows[0]).toHaveProperty('market_id');
      expect(windows[0]).toHaveProperty('token_id_up');
      expect(windows[0]).toHaveProperty('token_id_down');
      expect(windows[0]).toHaveProperty('market_price');
      expect(windows[0]).toHaveProperty('time_remaining_ms');
      expect(windows[0].crypto).toBe('btc');
    });

    it('should use cache on subsequent calls', async () => {
      const mockEpoch = Math.floor(Date.now() / 1000 / 900) * 900;

      // Return a valid market so cache gets populated
      global.fetch.mockImplementation((url) => {
        if (url.includes('gamma-api')) {
          return Promise.resolve({
            ok: true,
            json: async () => [{
              slug: `btc-updown-15m-${mockEpoch}`,
              question: 'Will BTC go up?',
              clobTokenIds: JSON.stringify(['token-up', 'token-down']),
              outcomePrices: JSON.stringify(['0.55', '0.45']),
              active: true,
              closed: false,
            }],
          });
        }
        if (url.includes('clob.polymarket')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              bids: [{ price: '0.50', size: '100' }],
              asks: [{ price: '0.60', size: '100' }],
            }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      await windowManager.init({ cryptos: ['btc'], cacheDurationMs: 10000 });

      await windowManager.getActiveWindows();
      const callCount1 = global.fetch.mock.calls.length;

      await windowManager.getActiveWindows();
      const callCount2 = global.fetch.mock.calls.length;

      // Should not make additional fetch calls due to cache
      expect(callCount2).toBe(callCount1);
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      await windowManager.init({ cryptos: ['btc'] });
      await windowManager.getActiveWindows();

      const stateBefore = windowManager.getState();
      expect(stateBefore.cacheAge).toBeLessThan(1000);

      windowManager.clearCache();

      const stateAfter = windowManager.getState();
      expect(stateAfter.cachedWindowCount).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should reset state', async () => {
      await windowManager.init();
      await windowManager.shutdown();

      const state = windowManager.getState();
      expect(state.initialized).toBe(false);
    });

    it('should be safe to call multiple times', async () => {
      await windowManager.init();
      await windowManager.shutdown();
      await windowManager.shutdown();
      // Should not throw
    });
  });
});
