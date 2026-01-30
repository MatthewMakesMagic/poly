/**
 * Polymarket Client Wrapper Tests
 *
 * Unit tests for:
 * - Rate limiting enforcement (100ms minimum interval)
 * - Statistics tracking
 * - Client lifecycle (init/shutdown)
 * - State management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WrappedPolymarketClient, MIN_REQUEST_INTERVAL_MS, MAX_BACKOFF_MS, MAX_RETRIES } from '../client.js';
import { PolymarketError, PolymarketErrorCodes } from '../types.js';

// Mock the ClobClient from SDK
vi.mock('@polymarket/clob-client', () => {
  class MockClobClient {
    constructor() {
      this.deriveApiKey = vi.fn().mockResolvedValue({
        apiKey: 'derived-key',
        apiSecret: 'derived-secret',
        passphrase: 'derived-passphrase',
      });
      this.getOrderBook = vi.fn().mockResolvedValue({
        bids: [{ price: '0.45', size: '100' }],
        asks: [{ price: '0.55', size: '100' }],
      });
      this.getOpenOrders = vi.fn().mockResolvedValue([]);
      this.getBalanceAllowance = vi.fn().mockResolvedValue({ balance: '1000000' });
      this.createAndPostOrder = vi.fn().mockResolvedValue({
        orderID: 'test-order-id',
        status: 'matched',
        success: true,
        transactionsHashes: ['0xabc123'],
      });
      this.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      this.cancelAll = vi.fn().mockResolvedValue({ success: true });
      this.updateBalanceAllowance = vi.fn().mockResolvedValue({});
    }
  }
  return {
    ClobClient: MockClobClient,
  };
});

// Mock ethers Wallet
vi.mock('ethers', () => {
  class MockWallet {
    constructor(privateKey) {
      this.address = '0x1234567890123456789012345678901234567890';
    }
    signTypedData = vi.fn().mockResolvedValue('0xsignature');
  }
  return {
    Wallet: MockWallet,
  };
});

// Valid test configuration
const validConfig = {
  apiKey: 'test-api-key',
  apiSecret: 'dGVzdC1hcGktc2VjcmV0', // base64 encoded
  passphrase: 'test-passphrase',
  privateKey: '0x' + '1'.repeat(64),
  funder: '0x' + '2'.repeat(40),
};

describe('WrappedPolymarketClient', () => {
  let client;
  let mockLogger;

  beforeEach(async () => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    client = new WrappedPolymarketClient({ logger: mockLogger });
    await client.initialize(validConfig);
  });

  afterEach(async () => {
    if (client) {
      await client.shutdown();
    }
  });

  describe('initialization', () => {
    it('initializes successfully with valid config', () => {
      expect(client.ready).toBe(true);
      expect(client.wallet).toBeDefined();
      expect(client.funder).toBeDefined();
    });

    it('throws AUTH_FAILED with missing credentials', async () => {
      const newClient = new WrappedPolymarketClient({ logger: mockLogger });

      await expect(newClient.initialize({})).rejects.toThrow(PolymarketError);

      try {
        await newClient.initialize({});
      } catch (err) {
        expect(err.code).toBe(PolymarketErrorCodes.AUTH_FAILED);
        expect(err.context.missing).toBeDefined();
        expect(err.context.missing.length).toBeGreaterThan(0);
      }
    });
  });

  describe('rate limiting', () => {
    it('enforces minimum interval between requests', async () => {
      const start = Date.now();

      // Make two consecutive requests
      await client.getOrderBook('token1');
      await client.getOrderBook('token2');

      const elapsed = Date.now() - start;

      // Second request should have waited at least MIN_REQUEST_INTERVAL_MS
      expect(elapsed).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL_MS - 10); // Allow 10ms tolerance
    });

    it('tracks rate limit status in getState', async () => {
      await client.getOrderBook('token1');

      const state = client.getState();

      expect(state.rateLimit).toBeDefined();
      expect(state.rateLimit.lastRequestTime).toBeGreaterThan(0);
      expect(state.rateLimit.minIntervalMs).toBe(MIN_REQUEST_INTERVAL_MS);
    });
  });

  describe('statistics tracking', () => {
    it('tracks request count', async () => {
      await client.getOrderBook('token1');
      await client.getOrderBook('token2');

      const state = client.getState();
      expect(state.stats.requests).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getState', () => {
    it('returns complete state structure', () => {
      const state = client.getState();

      expect(state).toEqual(expect.objectContaining({
        initialized: true,
        address: expect.any(String),
        funder: expect.any(String),
        ready: true,
        stats: expect.objectContaining({
          requests: expect.any(Number),
          errors: expect.any(Number),
          rateLimitHits: expect.any(Number),
        }),
        rateLimit: expect.objectContaining({
          remainingMs: expect.any(Number),
          lastRequestTime: expect.any(Number),
          minIntervalMs: MIN_REQUEST_INTERVAL_MS,
        }),
      }));
    });
  });

  describe('shutdown', () => {
    it('cleans up client state', async () => {
      expect(client.ready).toBe(true);

      await client.shutdown();

      expect(client.ready).toBe(false);
      expect(client.client).toBeNull();
      expect(client.wallet).toBeNull();
    });

    it('logs shutdown with final stats', async () => {
      await client.getOrderBook('token1');
      await client.shutdown();

      const shutdownCall = mockLogger.info.mock.calls.find(
        call => call[0] === 'client_shutdown'
      );
      expect(shutdownCall).toBeDefined();
      expect(shutdownCall[1]).toHaveProperty('stats');
    });
  });
});

describe('Rate Limit Constants', () => {
  it('MIN_REQUEST_INTERVAL_MS is 100ms', () => {
    expect(MIN_REQUEST_INTERVAL_MS).toBe(100);
  });

  it('MAX_BACKOFF_MS is 10000ms (10s)', () => {
    expect(MAX_BACKOFF_MS).toBe(10000);
  });

  it('MAX_RETRIES is 3', () => {
    expect(MAX_RETRIES).toBe(3);
  });
});
