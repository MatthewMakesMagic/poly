/**
 * RTDS Module Interface Tests
 *
 * Tests for the public module interface (index.js).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RTDSError, RTDSErrorCodes, SUPPORTED_SYMBOLS, TOPICS } from '../types.js';

// Mock the logger module
vi.mock('../../../modules/logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock WebSocket with a proper class
vi.mock('ws', () => {
  class MockWebSocket {
    constructor() {
      this._listeners = {};
      this.readyState = 1;
      // Auto-trigger open after construction
      setTimeout(() => {
        if (this._listeners.open) {
          this._listeners.open();
        }
      }, 0);
    }
    on(event, callback) {
      this._listeners[event] = callback;
    }
    send() {}
    close() {}
    terminate() {}
    removeAllListeners() {
      this._listeners = {};
    }
  }
  MockWebSocket.OPEN = 1;
  return { default: MockWebSocket };
});

// Import after mocks are set up
const rtds = await import('../index.js');

describe('RTDS Module Interface', () => {
  afterEach(async () => {
    await rtds.shutdown();
  });

  describe('getState before init', () => {
    it('should return uninitialized state', () => {
      const state = rtds.getState();

      expect(state.initialized).toBe(false);
      expect(state.connected).toBe(false);
      expect(state.connectionState).toBe('disconnected');
      expect(state.subscribedTopics).toEqual([]);
      expect(state.prices).toEqual({});
      expect(state.stats).toEqual({
        ticks_received: 0,
        errors: 0,
        reconnects: 0,
        last_tick_at: null,
      });
    });
  });

  describe('init', () => {
    it('should initialize with default config', async () => {
      await rtds.init({});

      const state = rtds.getState();
      expect(state.initialized).toBe(true);
    });

    it('should accept custom rtds config', async () => {
      await rtds.init({
        rtds: {
          reconnectIntervalMs: 2000,
          staleThresholdMs: 10000,
        },
      });

      const state = rtds.getState();
      expect(state.initialized).toBe(true);
    });
  });

  describe('getCurrentPrice before init', () => {
    it('should throw NOT_INITIALIZED error', () => {
      expect(() => rtds.getCurrentPrice('btc')).toThrow(RTDSError);
      expect(() => rtds.getCurrentPrice('btc')).toThrow('not initialized');
    });
  });

  describe('subscribe before init', () => {
    it('should throw NOT_INITIALIZED error', () => {
      expect(() => rtds.subscribe('btc', () => {})).toThrow(RTDSError);
      expect(() => rtds.subscribe('btc', () => {})).toThrow('not initialized');
    });
  });

  describe('after init', () => {
    beforeEach(async () => {
      await rtds.init({});
    });

    describe('getCurrentPrice', () => {
      it('should return null when no price available', () => {
        const price = rtds.getCurrentPrice('btc', TOPICS.CRYPTO_PRICES);
        expect(price).toBeNull();
      });

      it('should throw for invalid symbol', () => {
        expect(() => rtds.getCurrentPrice('invalid')).toThrow(RTDSError);
      });
    });

    describe('subscribe', () => {
      it('should return unsubscribe function', () => {
        const callback = vi.fn();
        const unsubscribe = rtds.subscribe('btc', callback);

        expect(typeof unsubscribe).toBe('function');
      });

      it('should throw for invalid symbol', () => {
        expect(() => rtds.subscribe('invalid', vi.fn())).toThrow(RTDSError);
      });
    });

    describe('getState', () => {
      it('should return initialized state', () => {
        const state = rtds.getState();

        expect(state.initialized).toBe(true);
        expect(state.subscribedTopics).toEqual(Object.values(TOPICS));
      });
    });
  });

  describe('shutdown', () => {
    it('should be safe to call when not initialized', async () => {
      await expect(rtds.shutdown()).resolves.toBeUndefined();
    });

    it('should clean up after init', async () => {
      await rtds.init({});
      await rtds.shutdown();

      const state = rtds.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('exports', () => {
    it('should export error class and codes', () => {
      expect(rtds.RTDSError).toBe(RTDSError);
      expect(rtds.RTDSErrorCodes).toBe(RTDSErrorCodes);
    });

    it('should export constants', () => {
      expect(rtds.SUPPORTED_SYMBOLS).toBe(SUPPORTED_SYMBOLS);
      expect(rtds.TOPICS).toBe(TOPICS);
    });
  });
});
