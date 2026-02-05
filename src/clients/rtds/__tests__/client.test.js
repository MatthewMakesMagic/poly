/**
 * RTDS Client Unit Tests
 *
 * Tests for RTDSClient class with mocked WebSocket.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RTDSClient } from '../client.js';
import {
  RTDSError,
  RTDSErrorCodes,
  TOPICS,
  SUPPORTED_SYMBOLS,
  ConnectionState,
} from '../types.js';

// Mock WebSocket
vi.mock('ws', () => {
  const mockWs = vi.fn().mockImplementation(() => {
    const ws = {
      on: vi.fn((event, callback) => {
        ws._listeners = ws._listeners || {};
        ws._listeners[event] = callback;
      }),
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
      readyState: 1, // WebSocket.OPEN
    };
    return ws;
  });
  mockWs.OPEN = 1;
  return { default: mockWs };
});

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe('RTDSClient', () => {
  let client;
  let mockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = createMockLogger();
    client = new RTDSClient({ logger: mockLogger });
  });

  afterEach(async () => {
    if (client && client.initialized) {
      await client.shutdown();
    }
  });

  describe('constructor', () => {
    it('should initialize with default state', () => {
      expect(client.initialized).toBe(false);
      expect(client.connectionState).toBe(ConnectionState.DISCONNECTED);
      expect(client.ws).toBeNull();
      expect(client.stats.ticks_received).toBe(0);
      expect(client.stats.errors).toBe(0);
      expect(client.stats.reconnects).toBe(0);
    });
  });

  describe('initialize', () => {
    it('should merge config with defaults', async () => {
      // Don't actually connect in tests
      vi.spyOn(client, 'connect').mockResolvedValue();

      await client.initialize({}); // Use default URL which is allowed

      expect(client.config.url).toBe('wss://ws-live-data.polymarket.com');
      expect(client.config.reconnectIntervalMs).toBe(1000);
      expect(client.config.maxReconnectIntervalMs).toBe(30000);
      expect(client.initialized).toBe(true);
    });

    it('should reject URLs with disallowed hosts', async () => {
      await expect(client.initialize({ url: 'wss://malicious.example.com' }))
        .rejects.toThrow(RTDSError);
      await expect(client.initialize({ url: 'wss://malicious.example.com' }))
        .rejects.toThrow('WebSocket host not allowed');
    });

    it('should reject invalid URL format', async () => {
      await expect(client.initialize({ url: 'not-a-url' }))
        .rejects.toThrow(RTDSError);
      await expect(client.initialize({ url: 'not-a-url' }))
        .rejects.toThrow('Invalid WebSocket URL format');
    });

    it('should reject non-websocket protocols', async () => {
      await expect(client.initialize({ url: 'http://ws-live-data.polymarket.com' }))
        .rejects.toThrow(RTDSError);
      await expect(client.initialize({ url: 'http://ws-live-data.polymarket.com' }))
        .rejects.toThrow('Invalid WebSocket protocol');
    });

    it('should initialize price storage for all symbols', async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();

      await client.initialize({});

      for (const symbol of SUPPORTED_SYMBOLS) {
        expect(client.prices[symbol]).toBeDefined();
        expect(client.prices[symbol][TOPICS.CRYPTO_PRICES]).toBeNull();
        expect(client.prices[symbol][TOPICS.CRYPTO_PRICES_CHAINLINK]).toBeNull();
        expect(client.subscribers.get(symbol)).toBeDefined();
      }
    });

    it('should log initialization', async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();

      await client.initialize({});

      expect(mockLogger.info).toHaveBeenCalledWith('rtds_client_initialize_start');
      expect(mockLogger.info).toHaveBeenCalledWith('rtds_client_initialize_complete', expect.any(Object));
    });
  });

  describe('normalizePrice', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should normalize Binance format price', () => {
      const tick = client.normalizePrice(
        { symbol: 'btcusdt', price: '95234.50', timestamp: 1700000000000 },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick).toEqual({
        timestamp: 1700000000000,
        topic: TOPICS.CRYPTO_PRICES,
        symbol: 'btc',
        price: 95234.50,
      });
    });

    it('should normalize Chainlink format price', () => {
      const tick = client.normalizePrice(
        { symbol: 'eth/usd', price: '3456.78', timestamp: 1700000000000 },
        TOPICS.CRYPTO_PRICES_CHAINLINK
      );

      expect(tick).toEqual({
        timestamp: 1700000000000,
        topic: TOPICS.CRYPTO_PRICES_CHAINLINK,
        symbol: 'eth',
        price: 3456.78,
      });
    });

    it('should handle alternative field names (s, p, t)', () => {
      const tick = client.normalizePrice(
        { s: 'solusdt', p: '123.45', t: 1700000000000 },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick).toEqual({
        timestamp: 1700000000000,
        topic: TOPICS.CRYPTO_PRICES,
        symbol: 'sol',
        price: 123.45,
      });
    });

    it('should return null for missing symbol', () => {
      const tick = client.normalizePrice(
        { price: '95234.50' },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick).toBeNull();
    });

    it('should return null for unsupported symbol', () => {
      const tick = client.normalizePrice(
        { symbol: 'dogeusdt', price: '0.10' },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick).toBeNull();
    });

    it('should return null for invalid price', () => {
      const tick = client.normalizePrice(
        { symbol: 'btcusdt', price: 'invalid' },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick).toBeNull();
    });

    it('should return null for zero or negative price', () => {
      expect(client.normalizePrice(
        { symbol: 'btcusdt', price: '0' },
        TOPICS.CRYPTO_PRICES
      )).toBeNull();

      expect(client.normalizePrice(
        { symbol: 'btcusdt', price: '-100' },
        TOPICS.CRYPTO_PRICES
      )).toBeNull();
    });

    it('should use current time if timestamp not provided', () => {
      const now = Date.now();
      const tick = client.normalizePrice(
        { symbol: 'btcusdt', price: '95234.50' },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick.timestamp).toBeGreaterThanOrEqual(now);
      expect(tick.timestamp).toBeLessThanOrEqual(now + 100);
    });

    it('should handle invalid timestamp string and use current time', () => {
      const now = Date.now();
      const tick = client.normalizePrice(
        { symbol: 'btcusdt', price: '95234.50', timestamp: 'invalid-date' },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick.timestamp).toBeGreaterThanOrEqual(now);
      expect(tick.timestamp).toBeLessThanOrEqual(now + 100);
      expect(mockLogger.warn).toHaveBeenCalledWith('rtds_invalid_timestamp_format', expect.any(Object));
    });

    it('should parse valid ISO date string', () => {
      const isoDate = '2026-01-30T10:00:00.000Z';
      const expectedTimestamp = Date.parse(isoDate);
      const tick = client.normalizePrice(
        { symbol: 'btcusdt', price: '95234.50', timestamp: isoDate },
        TOPICS.CRYPTO_PRICES
      );

      expect(tick.timestamp).toBe(expectedTimestamp);
    });
  });

  describe('subscribe', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should add subscriber for valid symbol', () => {
      const callback = vi.fn();
      const unsubscribe = client.subscribe('btc', callback);

      expect(client.subscribers.get('btc').has(callback)).toBe(true);
      expect(typeof unsubscribe).toBe('function');
    });

    it('should normalize symbol to lowercase', () => {
      const callback = vi.fn();
      client.subscribe('BTC', callback);

      expect(client.subscribers.get('btc').has(callback)).toBe(true);
    });

    it('should throw for unsupported symbol', () => {
      expect(() => client.subscribe('doge', vi.fn())).toThrow(RTDSError);
      expect(() => client.subscribe('doge', vi.fn())).toThrow('Unsupported symbol');
    });

    it('should throw if callback is not a function', () => {
      expect(() => client.subscribe('btc', 'not a function')).toThrow(RTDSError);
      expect(() => client.subscribe('btc', 'not a function')).toThrow('Callback must be a function');
    });

    it('should return unsubscribe function that removes callback', () => {
      const callback = vi.fn();
      const unsubscribe = client.subscribe('btc', callback);

      expect(client.subscribers.get('btc').has(callback)).toBe(true);

      unsubscribe();

      expect(client.subscribers.get('btc').has(callback)).toBe(false);
    });

    it('should log subscriber changes', () => {
      const callback = vi.fn();
      const unsubscribe = client.subscribe('btc', callback);

      expect(mockLogger.info).toHaveBeenCalledWith('rtds_subscriber_added', {
        symbol: 'btc',
        subscriber_count: 1,
      });

      unsubscribe();

      expect(mockLogger.info).toHaveBeenCalledWith('rtds_subscriber_removed', {
        symbol: 'btc',
        subscriber_count: 0,
      });
    });
  });

  describe('notifySubscribers', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should call all subscribers with tick data', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      client.subscribe('btc', callback1);
      client.subscribe('btc', callback2);

      const tick = { symbol: 'btc', price: 95234.50, timestamp: Date.now(), topic: TOPICS.CRYPTO_PRICES };
      client.notifySubscribers('btc', tick);

      expect(callback1).toHaveBeenCalledWith(tick);
      expect(callback2).toHaveBeenCalledWith(tick);
    });

    it('should handle callback errors gracefully', () => {
      const errorCallback = vi.fn(() => { throw new Error('Callback error'); });
      const goodCallback = vi.fn();

      client.subscribe('btc', errorCallback);
      client.subscribe('btc', goodCallback);

      const tick = { symbol: 'btc', price: 95234.50 };
      client.notifySubscribers('btc', tick);

      // Both callbacks should be called, error should be logged
      expect(errorCallback).toHaveBeenCalled();
      expect(goodCallback).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith('rtds_subscriber_callback_error', expect.any(Object));
    });
  });

  describe('getCurrentPrice', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should throw for unsupported symbol', () => {
      expect(() => client.getCurrentPrice('doge')).toThrow(RTDSError);
      expect(() => client.getCurrentPrice('doge')).toThrow('Unsupported symbol');
    });

    it('should throw for invalid topic', () => {
      expect(() => client.getCurrentPrice('btc', 'invalid_topic')).toThrow(RTDSError);
      expect(() => client.getCurrentPrice('btc', 'invalid_topic')).toThrow('Unsupported topic');
    });

    it('should return null if no price available', () => {
      const price = client.getCurrentPrice('btc', TOPICS.CRYPTO_PRICES);
      expect(price).toBeNull();
    });

    it('should return price with staleness for specific topic', () => {
      const timestamp = Date.now() - 1000;
      client.prices.btc[TOPICS.CRYPTO_PRICES] = {
        price: 95234.50,
        timestamp,
        staleness_ms: 0,
      };

      const price = client.getCurrentPrice('btc', TOPICS.CRYPTO_PRICES);

      expect(price.price).toBe(95234.50);
      expect(price.timestamp).toBe(timestamp);
      expect(price.staleness_ms).toBeGreaterThanOrEqual(1000);
    });

    it('should return all topics if no topic specified', () => {
      const timestamp = Date.now();
      client.prices.btc[TOPICS.CRYPTO_PRICES] = { price: 95234.50, timestamp, staleness_ms: 0 };
      client.prices.btc[TOPICS.CRYPTO_PRICES_CHAINLINK] = { price: 95230.00, timestamp, staleness_ms: 0 };

      const prices = client.getCurrentPrice('btc');

      expect(prices[TOPICS.CRYPTO_PRICES].price).toBe(95234.50);
      expect(prices[TOPICS.CRYPTO_PRICES_CHAINLINK].price).toBe(95230.00);
    });
  });

  describe('getState', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should return complete state object', () => {
      const state = client.getState();

      expect(state.initialized).toBe(true);
      expect(state.connected).toBe(false); // Not actually connected in test
      expect(state.connectionState).toBeDefined();
      expect(state.subscribedTopics).toEqual(Object.values(TOPICS));
      expect(state.prices).toBeDefined();
      expect(state.stats).toEqual({
        ticks_received: 0,
        messages_received: 0,
        messages_unrecognized: 0,
        errors: 0,
        reconnects: 0,
        last_tick_at: null,
      });
    });

    it('should include price data with staleness', () => {
      const timestamp = Date.now() - 2000;
      client.prices.eth[TOPICS.CRYPTO_PRICES] = { price: 3456.78, timestamp, staleness_ms: 0 };

      const state = client.getState();

      expect(state.prices.eth[TOPICS.CRYPTO_PRICES].price).toBe(3456.78);
      expect(state.prices.eth[TOPICS.CRYPTO_PRICES].staleness_ms).toBeGreaterThanOrEqual(2000);
    });
  });

  describe('shutdown', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should clean up all resources', async () => {
      const callback = vi.fn();
      client.subscribe('btc', callback);

      await client.shutdown();

      expect(client.initialized).toBe(false);
      expect(client.connectionState).toBe(ConnectionState.DISCONNECTED);
      expect(client.subscribers.get('btc').size).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith('rtds_client_shutdown_complete');
    });

    it('should clear reconnect timeout if pending', async () => {
      client.reconnectTimeout = setTimeout(() => {}, 10000);
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      await client.shutdown();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(client.reconnectTimeout).toBeNull();
    });
  });

  describe('handleMessage', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should reject messages exceeding size limit', () => {
      const oversizedData = Buffer.alloc(2 * 1024 * 1024); // 2MB > 1MB limit

      client.handleMessage(oversizedData);

      expect(mockLogger.warn).toHaveBeenCalledWith('rtds_message_too_large', expect.objectContaining({
        size: 2 * 1024 * 1024,
        max: 1024 * 1024,
      }));
      expect(client.stats.errors).toBe(1);
    });

    it('should process messages within size limit', () => {
      const validMessage = JSON.stringify({
        topic: TOPICS.CRYPTO_PRICES,
        type: 'price',
        timestamp: Date.now(),
        payload: { symbol: 'BTCUSDT', value: '95234.50', timestamp: Date.now() },
      });

      client.handleMessage(validMessage);

      expect(client.prices.btc[TOPICS.CRYPTO_PRICES].price).toBe(95234.50);
    });
  });

  describe('handlePriceUpdate', () => {
    beforeEach(async () => {
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    it('should update prices and notify subscribers', () => {
      const callback = vi.fn();
      client.subscribe('btc', callback);

      client.handlePriceUpdate({
        topic: TOPICS.CRYPTO_PRICES,
        prices: [{ symbol: 'btcusdt', price: '95234.50', timestamp: Date.now() }],
      });

      expect(client.prices.btc[TOPICS.CRYPTO_PRICES].price).toBe(95234.50);
      expect(callback).toHaveBeenCalled();
      expect(client.stats.ticks_received).toBe(1);
    });

    it('should handle single price object (not array)', () => {
      client.handlePriceUpdate({
        topic: TOPICS.CRYPTO_PRICES,
        symbol: 'ethusdt',
        price: '3456.78',
        timestamp: Date.now(),
      });

      expect(client.prices.eth[TOPICS.CRYPTO_PRICES].price).toBe(3456.78);
    });

    it('should skip invalid prices gracefully', () => {
      const initialErrorCount = client.stats.errors;

      client.handlePriceUpdate({
        topic: TOPICS.CRYPTO_PRICES,
        prices: [
          { symbol: 'btcusdt', price: '95234.50', timestamp: Date.now() },
          { symbol: 'invalid', price: '100' },
          { symbol: 'ethusdt', price: 'bad', timestamp: Date.now() },
        ],
      });

      // Only BTC should be updated
      expect(client.prices.btc[TOPICS.CRYPTO_PRICES].price).toBe(95234.50);
      expect(client.prices.eth[TOPICS.CRYPTO_PRICES]).toBeNull();
    });

    it('should reject messages with missing topic', () => {
      client.handlePriceUpdate({
        prices: [{ symbol: 'btcusdt', price: '95234.50', timestamp: Date.now() }],
      });

      expect(mockLogger.warn).toHaveBeenCalledWith('rtds_invalid_topic_in_message', expect.any(Object));
      expect(client.prices.btc[TOPICS.CRYPTO_PRICES]).toBeNull();
    });

    it('should reject messages with invalid topic', () => {
      client.handlePriceUpdate({
        topic: 'invalid_topic',
        prices: [{ symbol: 'btcusdt', price: '95234.50', timestamp: Date.now() }],
      });

      expect(mockLogger.warn).toHaveBeenCalledWith('rtds_invalid_topic_in_message', expect.any(Object));
      expect(client.prices.btc[TOPICS.CRYPTO_PRICES]).toBeNull();
    });
  });

  describe('reconnection logic', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should calculate exponential backoff delay', () => {
      // Manually trigger reconnect scheduling
      client.reconnectAttempts = 0;
      client.scheduleReconnect();

      // First attempt: 1000ms
      expect(mockLogger.info).toHaveBeenCalledWith('rtds_reconnect_scheduled', {
        attempt: 1,
        delay_ms: 1000,
      });
    });

    it('should cap delay at maxReconnectIntervalMs', () => {
      client.reconnectAttempts = 10; // 2^10 * 1000 = 1024000 > 30000
      client.scheduleReconnect();

      expect(mockLogger.info).toHaveBeenCalledWith('rtds_reconnect_scheduled', {
        attempt: 11,
        delay_ms: 30000,
      });
    });

    it('should emit stale data warning when delay exceeds threshold', () => {
      client.reconnectAttempts = 3; // 2^3 * 1000 = 8000 > 5000
      client.scheduleReconnect();

      expect(mockLogger.warn).toHaveBeenCalledWith('rtds_stale_data_warning', expect.objectContaining({
        reconnect_delay_ms: 8000,
        stale_threshold_ms: 5000,
      }));
    });
  });

  describe('stale monitoring', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.spyOn(client, 'connect').mockResolvedValue();
      await client.initialize({});
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should rate limit stale warnings', () => {
      // Set up stale price
      const oldTimestamp = Date.now() - 10000; // 10s ago
      client.prices.btc[TOPICS.CRYPTO_PRICES] = {
        price: 95234.50,
        timestamp: oldTimestamp,
        staleness_ms: 0,
      };

      client.startStaleMonitoring();

      // First check - should warn
      vi.advanceTimersByTime(1000);
      expect(mockLogger.warn).toHaveBeenCalledWith('rtds_price_stale', expect.any(Object));
      const warnCount1 = mockLogger.warn.mock.calls.filter(c => c[0] === 'rtds_price_stale').length;

      // Advance 5 more seconds - should NOT warn again (30s interval)
      vi.advanceTimersByTime(5000);
      const warnCount2 = mockLogger.warn.mock.calls.filter(c => c[0] === 'rtds_price_stale').length;
      expect(warnCount2).toBe(warnCount1);

      // Advance to 31s - should warn again
      vi.advanceTimersByTime(30000);
      const warnCount3 = mockLogger.warn.mock.calls.filter(c => c[0] === 'rtds_price_stale').length;
      expect(warnCount3).toBeGreaterThan(warnCount1);
    });
  });

  describe('URL validation', () => {
    it('should validate URL format', () => {
      expect(() => client.validateUrl('not-a-url')).toThrow(RTDSError);
      expect(() => client.validateUrl('not-a-url')).toThrow('Invalid WebSocket URL format');
    });

    it('should validate WebSocket protocol', () => {
      expect(() => client.validateUrl('http://ws-live-data.polymarket.com')).toThrow(RTDSError);
      expect(() => client.validateUrl('http://ws-live-data.polymarket.com')).toThrow('Invalid WebSocket protocol');
    });

    it('should validate allowed hosts', () => {
      expect(() => client.validateUrl('wss://evil.example.com')).toThrow(RTDSError);
      expect(() => client.validateUrl('wss://evil.example.com')).toThrow('WebSocket host not allowed');
    });

    it('should accept allowed hosts', () => {
      expect(() => client.validateUrl('wss://ws-live-data.polymarket.com')).not.toThrow();
    });
  });
});
