/**
 * Order Book Collector Module Tests
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    transaction: vi.fn().mockImplementation(async (fn) => {
      const mockClient = { run: vi.fn().mockResolvedValue({ changes: 1 }) };
      await fn(mockClient);
    }),
  },
}));

vi.mock('../../../clients/polymarket/index.js', () => ({
  getOrderBook: vi.fn().mockResolvedValue({
    bids: [
      { price: '0.45', size: '100' },
      { price: '0.44', size: '200' },
      { price: '0.43', size: '300' },
    ],
    asks: [
      { price: '0.55', size: '100' },
      { price: '0.56', size: '200' },
      { price: '0.57', size: '300' },
    ],
  }),
}));

vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import * as collector from '../index.js';

describe('order-book-collector module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    try { await collector.shutdown(); } catch { /* ignore */ }
  });

  afterEach(async () => {
    try { await collector.shutdown(); } catch { /* ignore */ }
  });

  describe('init', () => {
    test('initializes with default config', async () => {
      await collector.init({});
      const state = collector.getState();

      expect(state.initialized).toBe(true);
      expect(state.config.snapshotIntervalMs).toBe(5000);
      expect(state.config.maxActiveTokens).toBe(20);
    });

    test('accepts custom config', async () => {
      await collector.init({
        orderBookCollector: {
          snapshotIntervalMs: 1000,
          maxActiveTokens: 5,
        },
      });
      const state = collector.getState();

      expect(state.config.snapshotIntervalMs).toBe(1000);
      expect(state.config.maxActiveTokens).toBe(5);
    });

    test('is idempotent', async () => {
      await collector.init({});
      await collector.init({});
      const state = collector.getState();
      expect(state.initialized).toBe(true);
    });
  });

  describe('addToken / removeToken', () => {
    test('adds token for tracking', async () => {
      await collector.init({});
      collector.addToken('token-123', 'btc');

      const state = collector.getState();
      expect(state.activeTokens).toBe(1);
      expect(state.tokens[0].token_id).toBe('token-123');
      expect(state.tokens[0].symbol).toBe('btc');
    });

    test('removes token', async () => {
      await collector.init({});
      collector.addToken('token-123', 'btc');
      collector.removeToken('token-123');

      const state = collector.getState();
      expect(state.activeTokens).toBe(0);
    });

    test('throws when not initialized', () => {
      expect(() => collector.addToken('token-123', 'btc'))
        .toThrow('not initialized');
    });

    test('respects maxActiveTokens', async () => {
      await collector.init({
        orderBookCollector: { maxActiveTokens: 2 },
      });

      collector.addToken('token-1', 'btc');
      collector.addToken('token-2', 'eth');
      collector.addToken('token-3', 'sol'); // Should be rejected

      const state = collector.getState();
      expect(state.activeTokens).toBe(2);
    });
  });

  describe('getState', () => {
    test('returns uninitialized state before init', () => {
      const state = collector.getState();

      expect(state.initialized).toBe(false);
      expect(state.stats).toBeNull();
    });

    test('returns complete state after init', async () => {
      await collector.init({});
      const state = collector.getState();

      expect(state.initialized).toBe(true);
      expect(state.activeTokens).toBe(0);
      expect(state.stats).toBeDefined();
      expect(state.config).toBeDefined();
    });
  });

  describe('shutdown', () => {
    test('cleans up resources', async () => {
      await collector.init({});
      collector.addToken('token-1', 'btc');
      await collector.shutdown();

      const state = collector.getState();
      expect(state.initialized).toBe(false);
    });

    test('is idempotent', async () => {
      await collector.shutdown();
      await collector.shutdown();
    });
  });
});
