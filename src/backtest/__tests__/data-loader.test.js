/**
 * Tests for data-loader module (PostgreSQL async API)
 *
 * Mocks persistence module to test query construction and data flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock persistence
vi.mock('../../persistence/index.js', () => ({
  default: {
    all: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock logger
vi.mock('../../modules/logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import persistence from '../../persistence/index.js';
import {
  loadRtdsTicks,
  loadRtdsTicksBatched,
  getTickCount,
  loadClobSnapshots,
  loadExchangeTicks,
  loadWindowEvents,
  loadMergedTimeline,
  getTickDateRange,
  getAvailableSymbols,
  getAvailableTopics,
} from '../data-loader.js';

describe('data-loader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: return empty arrays for any unconfigured calls
    persistence.all.mockResolvedValue([]);
    persistence.get.mockResolvedValue(null);
  });

  describe('loadRtdsTicks', () => {
    it('throws on missing dates', async () => {
      await expect(loadRtdsTicks({})).rejects.toThrow('startDate and endDate are required');
    });

    it('loads ticks with date range', async () => {
      const mockTicks = [
        { id: 1, timestamp: '2026-01-25T10:00:00Z', topic: 'crypto_prices', symbol: 'BTC', price: 50000 },
        { id: 2, timestamp: '2026-01-25T10:00:01Z', topic: 'crypto_prices_chainlink', symbol: 'BTC', price: 49900 },
      ];

      // First batch returns data, second returns empty (end of data)
      persistence.all.mockResolvedValueOnce(mockTicks).mockResolvedValueOnce([]);

      const result = await loadRtdsTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      });

      expect(result).toHaveLength(2);
      expect(result[0].topic).toBe('crypto_prices');
      expect(persistence.all).toHaveBeenCalled();

      // Verify SQL uses $1, $2 placeholders
      const sql = persistence.all.mock.calls[0][0];
      expect(sql).toContain('$1');
      expect(sql).toContain('$2');
    });

    it('filters by symbols', async () => {
      persistence.all.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await loadRtdsTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        symbols: ['BTC'],
      });

      const sql = persistence.all.mock.calls[0][0];
      expect(sql).toContain('symbol IN');
    });

    it('filters by topics', async () => {
      persistence.all.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await loadRtdsTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        topics: ['crypto_prices_chainlink'],
      });

      const sql = persistence.all.mock.calls[0][0];
      expect(sql).toContain('topic IN');
    });
  });

  describe('loadRtdsTicksBatched', () => {
    it('yields batches', async () => {
      const batch1 = [
        { id: 1, timestamp: '2026-01-25T10:00:00Z', topic: 'crypto_prices', symbol: 'BTC', price: 50000 },
        { id: 2, timestamp: '2026-01-25T10:00:01Z', topic: 'crypto_prices', symbol: 'BTC', price: 50001 },
        { id: 3, timestamp: '2026-01-25T10:00:02Z', topic: 'crypto_prices', symbol: 'BTC', price: 50002 },
      ];

      // batchSize=3, returns 3 rows → might have more, tries again → empty
      persistence.all
        .mockResolvedValueOnce(batch1)
        .mockResolvedValueOnce([]);

      const batches = [];
      for await (const batch of loadRtdsTicksBatched({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
        batchSize: 3,
      })) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    });
  });

  describe('getTickCount', () => {
    it('returns count', async () => {
      persistence.get.mockResolvedValueOnce({ count: '42' });

      const count = await getTickCount({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      });

      expect(count).toBe(42);
    });
  });

  describe('loadClobSnapshots', () => {
    it('loads CLOB data', async () => {
      const mockSnaps = [
        { timestamp: '2026-01-25T10:00:00Z', symbol: 'BTC', token_id: 'btc_up', best_bid: 0.55, best_ask: 0.56 },
      ];
      persistence.all.mockResolvedValueOnce(mockSnaps);

      const result = await loadClobSnapshots({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0].best_bid).toBe(0.55);
    });

    it('throws on missing dates', async () => {
      await expect(loadClobSnapshots({})).rejects.toThrow('startDate and endDate are required');
    });
  });

  describe('loadExchangeTicks', () => {
    it('loads exchange data', async () => {
      const mockTicks = [
        { timestamp: '2026-01-25T10:00:00Z', exchange: 'binance', symbol: 'BTC', price: 50000 },
      ];
      persistence.all.mockResolvedValueOnce(mockTicks);

      const result = await loadExchangeTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0].exchange).toBe('binance');
    });
  });

  describe('loadWindowEvents', () => {
    it('loads window events', async () => {
      const mockWindows = [{
        window_close_time: '2026-01-25T12:30:00Z',
        symbol: 'BTC',
        strike_price: 50100,
        chainlink_price_at_close: 50020,
        resolved_direction: 'DOWN',
      }];
      persistence.all.mockResolvedValueOnce(mockWindows);

      const result = await loadWindowEvents({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      });

      expect(result).toHaveLength(1);
      expect(result[0].resolved_direction).toBe('DOWN');
    });
  });

  describe('loadMergedTimeline', () => {
    it('merges and sorts all sources', async () => {
      // Mock based on SQL content since Promise.all makes call order non-deterministic
      persistence.all.mockImplementation(async (sql) => {
        if (sql.includes('rtds_ticks')) {
          // First call returns data, subsequent (OFFSET > 0) returns empty
          if (sql.includes('OFFSET')) {
            const offsetMatch = sql.match(/OFFSET \$\d+/);
            // Check if params indicate offset > 0 by looking at actual call
            return [
              { id: 1, timestamp: '2026-01-25T10:00:01Z', topic: 'crypto_prices', symbol: 'BTC', price: 50000 },
              { id: 2, timestamp: '2026-01-25T10:00:02Z', topic: 'crypto_prices_chainlink', symbol: 'BTC', price: 49900 },
            ];
          }
          return [];
        }
        if (sql.includes('clob_price_snapshots')) {
          return [
            { timestamp: '2026-01-25T10:00:00Z', symbol: 'BTC', token_id: 'btc_up', best_bid: 0.55, best_ask: 0.56, mid_price: 0.555, spread: 0.01 },
          ];
        }
        if (sql.includes('exchange_ticks')) {
          return [
            { timestamp: '2026-01-25T10:00:03Z', exchange: 'binance', symbol: 'BTC', price: 50010, bid: 50005, ask: 50015 },
          ];
        }
        return [];
      });

      const timeline = await loadMergedTimeline({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-26T00:00:00Z',
      });

      // rtds_ticks returns on first batch call but then loadRtdsTicks may make another call
      // The key point: we get at least the data we set up
      expect(timeline.length).toBeGreaterThanOrEqual(4);

      // Check source tagging
      const sources = timeline.map(e => e.source);
      expect(sources).toContain('polyRef');
      expect(sources).toContain('chainlink');
      expect(sources).toContain('clobUp');
      expect(sources).toContain('exchange_binance');

      // Verify sorted by timestamp
      for (let i = 1; i < timeline.length; i++) {
        expect(new Date(timeline[i].timestamp).getTime())
          .toBeGreaterThanOrEqual(new Date(timeline[i-1].timestamp).getTime());
      }
    });
  });

  describe('getTickDateRange', () => {
    it('returns date range', async () => {
      persistence.get.mockResolvedValueOnce({
        earliest: '2026-01-25T10:00:00Z',
        latest: '2026-01-26T10:00:00Z',
      });

      const range = await getTickDateRange();
      expect(range.earliest).toBe('2026-01-25T10:00:00Z');
      expect(range.latest).toBe('2026-01-26T10:00:00Z');
    });
  });

  describe('getAvailableSymbols', () => {
    it('returns symbols', async () => {
      persistence.all.mockResolvedValueOnce([{ symbol: 'BTC' }, { symbol: 'ETH' }]);
      const symbols = await getAvailableSymbols();
      expect(symbols).toEqual(['BTC', 'ETH']);
    });
  });

  describe('getAvailableTopics', () => {
    it('returns topics', async () => {
      persistence.all.mockResolvedValueOnce([{ topic: 'crypto_prices' }, { topic: 'crypto_prices_chainlink' }]);
      const topics = await getAvailableTopics();
      expect(topics).toEqual(['crypto_prices', 'crypto_prices_chainlink']);
    });
  });
});
