/**
 * Tests for spot client module interface
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger first
vi.mock('../../../modules/logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock axios
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

import axios from 'axios';
import { child } from '../../../modules/logger/index.js';
import * as spotClient from '../index.js';
import { SpotClientError, SpotClientErrorCodes, SUPPORTED_CRYPTOS } from '../types.js';

describe('Spot Client Module', () => {
  let mockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-30T12:00:00.000Z'));

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(child).mockReturnValue(mockLogger);

    // Setup default successful axios response
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        parsed: [
          {
            id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
            price: {
              price: '10500000000000',
              expo: -8,
              publish_time: Math.floor(Date.now() / 1000),
            },
          },
          {
            id: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
            price: {
              price: '350000000000',
              expo: -8,
              publish_time: Math.floor(Date.now() / 1000),
            },
          },
          {
            id: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
            price: {
              price: '20000000000',
              expo: -8,
              publish_time: Math.floor(Date.now() / 1000),
            },
          },
          {
            id: 'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
            price: {
              price: '60000000',
              expo: -8,
              publish_time: Math.floor(Date.now() / 1000),
            },
          },
        ],
      },
    });
  });

  afterEach(async () => {
    await spotClient.shutdown();
    vi.useRealTimers();
  });

  describe('init()', () => {
    it('should initialize with default config', async () => {
      await spotClient.init({});

      expect(child).toHaveBeenCalledWith({ module: 'spot-client' });
      expect(mockLogger.info).toHaveBeenCalledWith('module_init_start');
      expect(mockLogger.info).toHaveBeenCalledWith('module_initialized', expect.any(Object));
    });

    it('should initialize with custom config', async () => {
      await spotClient.init({
        spot: {
          hermesUrl: 'https://custom.hermes.url',
          pollIntervalMs: 2000,
        },
      });

      const state = spotClient.getState();
      expect(state.initialized).toBe(true);
    });

    it('should create child logger with module name', async () => {
      await spotClient.init({});

      expect(child).toHaveBeenCalledWith({ module: 'spot-client' });
    });

    it('should throw for invalid hermesUrl format', async () => {
      await expect(
        spotClient.init({
          spot: {
            hermesUrl: 'not-a-valid-url',
          },
        })
      ).rejects.toThrow(SpotClientError);

      await expect(
        spotClient.init({
          spot: {
            hermesUrl: 'not-a-valid-url',
          },
        })
      ).rejects.toThrow('Invalid hermesUrl format');
    });
  });

  describe('getCurrentPrice()', () => {
    it('should throw if not initialized', () => {
      expect(() => spotClient.getCurrentPrice('btc')).toThrow(SpotClientError);
      expect(() => spotClient.getCurrentPrice('btc')).toThrow('not initialized');
    });

    it('should return normalized price for BTC', async () => {
      await spotClient.init({});

      const price = spotClient.getCurrentPrice('btc');

      expect(price).toBeTruthy();
      expect(price.price).toBe(105000);
      expect(price.source).toBe('pyth');
      expect(typeof price.staleness).toBe('number');
    });

    it('should return normalized price for ETH', async () => {
      await spotClient.init({});

      const price = spotClient.getCurrentPrice('eth');

      expect(price).toBeTruthy();
      expect(price.price).toBe(3500);
    });

    it('should return normalized price for SOL', async () => {
      await spotClient.init({});

      const price = spotClient.getCurrentPrice('sol');

      expect(price).toBeTruthy();
      expect(price.price).toBe(200);
    });

    it('should return normalized price for XRP', async () => {
      await spotClient.init({});

      const price = spotClient.getCurrentPrice('xrp');

      expect(price).toBeTruthy();
      expect(price.price).toBe(0.6);
    });

    it('should throw for unsupported crypto', async () => {
      await spotClient.init({});

      expect(() => spotClient.getCurrentPrice('doge')).toThrow(SpotClientError);
      expect(() => spotClient.getCurrentPrice('doge')).toThrow('Unsupported');
    });

    it('should handle case-insensitive crypto symbol', async () => {
      await spotClient.init({});

      const priceLower = spotClient.getCurrentPrice('btc');
      const priceUpper = spotClient.getCurrentPrice('BTC');

      expect(priceLower.price).toBe(priceUpper.price);
    });
  });

  describe('subscribe()', () => {
    it('should throw if not initialized', () => {
      const callback = vi.fn();
      expect(() => spotClient.subscribe('btc', callback)).toThrow(SpotClientError);
    });

    it('should invoke callback on price updates', async () => {
      await spotClient.init({});
      const callback = vi.fn();

      spotClient.subscribe('btc', callback);

      // Trigger polling
      await vi.advanceTimersByTimeAsync(1000);

      expect(callback).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          price: 105000,
          source: 'pyth',
        })
      );
    });

    it('should return unsubscribe function', async () => {
      await spotClient.init({});
      const callback = vi.fn();

      const unsubscribe = spotClient.subscribe('btc', callback);
      expect(typeof unsubscribe).toBe('function');

      unsubscribe();

      // Callback should not be called after unsubscribe
      callback.mockClear();
      await vi.advanceTimersByTimeAsync(1000);

      // The callback count should not increase after unsubscribe
      const callCountAfterUnsubscribe = callback.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(callback.mock.calls.length).toBe(callCountAfterUnsubscribe);
    });

    it('should support multiple subscribers', async () => {
      await spotClient.init({});
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      spotClient.subscribe('btc', callback1);
      spotClient.subscribe('btc', callback2);

      await vi.advanceTimersByTimeAsync(1000);

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    it('should throw for unsupported crypto', async () => {
      await spotClient.init({});
      const callback = vi.fn();

      expect(() => spotClient.subscribe('doge', callback)).toThrow(SpotClientError);
    });

    it('should throw if callback is not a function', async () => {
      await spotClient.init({});

      expect(() => spotClient.subscribe('btc', 'not a function')).toThrow(SpotClientError);
      expect(() => spotClient.subscribe('btc', null)).toThrow(SpotClientError);
    });

    it('should not break other subscribers when one callback throws', async () => {
      await spotClient.init({});

      const failingCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const successCallback = vi.fn();

      spotClient.subscribe('btc', failingCallback);
      spotClient.subscribe('btc', successCallback);

      // Trigger polling to invoke callbacks
      await vi.advanceTimersByTimeAsync(1000);

      // Both callbacks should have been called
      expect(failingCallback).toHaveBeenCalled();
      expect(successCallback).toHaveBeenCalled();

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'subscriber_callback_error',
        expect.objectContaining({
          crypto: 'btc',
          error: 'Callback error',
        })
      );
    });
  });

  describe('getState()', () => {
    it('should return uninitialized state before init', () => {
      const state = spotClient.getState();

      expect(state.initialized).toBe(false);
      expect(state.connected).toBe(false);
      expect(state.prices).toEqual({});
    });

    it('should return full state after init', async () => {
      await spotClient.init({});

      const state = spotClient.getState();

      expect(state.initialized).toBe(true);
      expect(state.connected).toBe(true);
      expect(state.disabled).toBe(false);
      expect(state.consecutiveErrors).toBe(0);
      expect(state.prices.btc).toBeTruthy();
      expect(state.stats).toBeTruthy();
      expect(state.stats.requests).toBeGreaterThan(0);
    });

    it('should include staleness in state prices', async () => {
      await spotClient.init({});

      const state = spotClient.getState();

      expect(state.prices.btc).toHaveProperty('staleness');
      expect(typeof state.prices.btc.staleness).toBe('number');
    });
  });

  describe('shutdown()', () => {
    it('should cleanup resources', async () => {
      await spotClient.init({});

      await spotClient.shutdown();

      const state = spotClient.getState();
      expect(state.initialized).toBe(false);
    });

    it('should stop polling', async () => {
      await spotClient.init({});
      const initialRequests = vi.mocked(axios.get).mock.calls.length;

      await spotClient.shutdown();

      // Clear mock and advance time
      vi.mocked(axios.get).mockClear();
      await vi.advanceTimersByTimeAsync(5000);

      // No new requests should be made after shutdown
      expect(vi.mocked(axios.get).mock.calls.length).toBe(0);
    });

    it('should log shutdown events', async () => {
      await spotClient.init({});

      await spotClient.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith('module_shutdown_start');
      expect(mockLogger.info).toHaveBeenCalledWith('module_shutdown_complete');
    });

    it('should be safe to call multiple times', async () => {
      await spotClient.init({});

      await spotClient.shutdown();
      await spotClient.shutdown();

      expect(spotClient.getState().initialized).toBe(false);
    });
  });

  describe('Disconnect handling (AC4)', () => {
    it('should emit warning on disconnect', async () => {
      await spotClient.init({});

      // Simulate connection failure
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'spot_feed_disconnected',
        expect.any(Object)
      );
    });

    it('should attempt reconnection with exponential backoff', async () => {
      await spotClient.init({});

      // Simulate connection failure
      vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'spot_reconnect_scheduled',
        expect.objectContaining({
          delayMs: expect.any(Number),
        })
      );
    });

    it('should update isConnected to false on disconnect', async () => {
      await spotClient.init({});

      // Simulate connection failure
      vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

      await vi.advanceTimersByTimeAsync(1000);

      const state = spotClient.getState();
      expect(state.connected).toBe(false);
    });
  });

  describe('Reconnection handling (AC5)', () => {
    it('should log reconnection success', async () => {
      await spotClient.init({});

      // Simulate disconnect
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
      await vi.advanceTimersByTimeAsync(1000);

      // Restore connection
      vi.mocked(axios.get).mockResolvedValue({
        data: {
          parsed: [
            {
              id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
              price: { price: '10500000000000', expo: -8, publish_time: Math.floor(Date.now() / 1000) },
            },
          ],
        },
      });

      // Wait for reconnect
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockLogger.info).toHaveBeenCalledWith('spot_feed_reconnected');
    });

    it('should reset consecutiveErrors on reconnection', async () => {
      await spotClient.init({});

      // Simulate disconnect
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
      await vi.advanceTimersByTimeAsync(1000);

      let state = spotClient.getState();
      expect(state.consecutiveErrors).toBeGreaterThan(0);

      // Restore connection
      vi.mocked(axios.get).mockResolvedValue({
        data: {
          parsed: [
            {
              id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
              price: { price: '10500000000000', expo: -8, publish_time: Math.floor(Date.now() / 1000) },
            },
          ],
        },
      });

      await vi.advanceTimersByTimeAsync(5000);

      state = spotClient.getState();
      expect(state.consecutiveErrors).toBe(0);
    });

    it('should update isConnected to true on reconnection', async () => {
      await spotClient.init({});

      // Simulate disconnect
      vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network error'));
      await vi.advanceTimersByTimeAsync(1000);

      expect(spotClient.getState().connected).toBe(false);

      // Restore connection
      vi.mocked(axios.get).mockResolvedValue({
        data: {
          parsed: [
            {
              id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
              price: { price: '10500000000000', expo: -8, publish_time: Math.floor(Date.now() / 1000) },
            },
          ],
        },
      });

      await vi.advanceTimersByTimeAsync(5000);

      expect(spotClient.getState().connected).toBe(true);
    });
  });

  describe('Staleness detection (AC6)', () => {
    it('should emit warning for stale price', async () => {
      await spotClient.init({});

      // Advance time to make prices stale (> 10 seconds)
      await vi.advanceTimersByTimeAsync(15000);

      // Get price should trigger staleness warning
      spotClient.getCurrentPrice('btc');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'spot_price_stale',
        expect.objectContaining({
          crypto: 'btc',
          staleness: expect.any(Number),
        })
      );
    });

    it('should include staleness in getState response', async () => {
      await spotClient.init({});

      await vi.advanceTimersByTimeAsync(5000);

      const state = spotClient.getState();

      expect(state.prices.btc.staleness).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Error threshold handling (AC7)', () => {
    it('should disable source after MAX_CONSECUTIVE_ERRORS', async () => {
      // Make the first init call succeed
      vi.mocked(axios.get).mockResolvedValueOnce({
        data: {
          parsed: [
            {
              id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
              price: { price: '10500000000000', expo: -8, publish_time: Math.floor(Date.now() / 1000) },
            },
          ],
        },
      });

      await spotClient.init({
        spot: { maxConsecutiveErrors: 3 },
      });

      // Now simulate repeated failures
      vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

      // Trigger enough errors to exceed threshold (need 3+ consecutive)
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      // After errors, reconnect attempts happen with delays
      // Need to advance enough for reconnect attempts
      await vi.advanceTimersByTimeAsync(10000);
      await vi.advanceTimersByTimeAsync(20000);
      await vi.advanceTimersByTimeAsync(40000);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'spot_source_disabled',
        expect.objectContaining({
          consecutiveErrors: expect.any(Number),
        })
      );

      const state = spotClient.getState();
      expect(state.disabled).toBe(true);
    });
  });

  describe('Exports', () => {
    it('should export SpotClientError', () => {
      expect(SpotClientError).toBeDefined();
      expect(new SpotClientError('CODE', 'message')).toBeInstanceOf(Error);
    });

    it('should export SpotClientErrorCodes', () => {
      expect(SpotClientErrorCodes).toBeDefined();
      expect(SpotClientErrorCodes.NOT_INITIALIZED).toBe('SPOT_CLIENT_NOT_INITIALIZED');
    });

    it('should export SUPPORTED_CRYPTOS', () => {
      expect(SUPPORTED_CRYPTOS).toEqual(['btc', 'eth', 'sol', 'xrp']);
    });
  });
});
