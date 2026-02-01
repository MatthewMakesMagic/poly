/**
 * Tests for data-loader module
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { open, close, run } from '../../persistence/database.js';
import {
  loadTicks,
  loadTicksBatched,
  getTickCount,
  getTickDateRange,
  getAvailableSymbols,
  getAvailableTopics,
} from '../data-loader.js';

describe('data-loader', () => {
  beforeAll(() => {
    // Open in-memory database for testing
    open(':memory:');

    // Create rtds_ticks table
    run(`
      CREATE TABLE rtds_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        topic TEXT NOT NULL,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        raw_payload TEXT
      )
    `);

    // Insert test data
    const testData = [
      { timestamp: '2026-01-25T10:00:00Z', topic: 'binance', symbol: 'BTC', price: 50000 },
      { timestamp: '2026-01-25T10:00:01Z', topic: 'chainlink', symbol: 'BTC', price: 49990 },
      { timestamp: '2026-01-25T10:00:02Z', topic: 'binance', symbol: 'ETH', price: 3000 },
      { timestamp: '2026-01-25T10:00:03Z', topic: 'chainlink', symbol: 'ETH', price: 2998 },
      { timestamp: '2026-01-26T10:00:00Z', topic: 'binance', symbol: 'BTC', price: 51000 },
      { timestamp: '2026-01-26T10:00:01Z', topic: 'chainlink', symbol: 'BTC', price: 50990 },
    ];

    for (const row of testData) {
      run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [row.timestamp, row.topic, row.symbol, row.price]
      );
    }
  });

  afterAll(() => {
    close();
  });

  describe('loadTicks', () => {
    it('loads all ticks in date range', () => {
      const ticks = loadTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-27T00:00:00Z',
      });

      expect(ticks).toHaveLength(6);
      expect(ticks[0].symbol).toBe('BTC');
      expect(ticks[0].price).toBe(50000);
    });

    it('filters by symbol', () => {
      const ticks = loadTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-27T00:00:00Z',
        symbols: ['ETH'],
      });

      expect(ticks).toHaveLength(2);
      expect(ticks.every(t => t.symbol === 'ETH')).toBe(true);
    });

    it('filters by topic', () => {
      const ticks = loadTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-27T00:00:00Z',
        topics: ['binance'],
      });

      expect(ticks).toHaveLength(3);
      expect(ticks.every(t => t.topic === 'binance')).toBe(true);
    });

    it('filters by date range', () => {
      const ticks = loadTicks({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-25T23:59:59Z',
      });

      expect(ticks).toHaveLength(4);
    });

    it('throws on missing dates', () => {
      expect(() => loadTicks({})).toThrow('startDate and endDate are required');
    });
  });

  describe('loadTicksBatched', () => {
    it('yields batches of ticks', () => {
      const batches = [];
      for (const batch of loadTicksBatched({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-27T00:00:00Z',
        batchSize: 2,
      })) {
        batches.push(batch);
      }

      expect(batches.length).toBeGreaterThan(0);
      expect(batches[0]).toHaveLength(2);
    });
  });

  describe('getTickCount', () => {
    it('returns total tick count', () => {
      const count = getTickCount({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-27T00:00:00Z',
      });

      expect(count).toBe(6);
    });

    it('filters count by symbol', () => {
      const count = getTickCount({
        startDate: '2026-01-25T00:00:00Z',
        endDate: '2026-01-27T00:00:00Z',
        symbols: ['BTC'],
      });

      expect(count).toBe(4);
    });
  });

  describe('getTickDateRange', () => {
    it('returns earliest and latest timestamps', () => {
      const range = getTickDateRange();

      expect(range.earliest).toBe('2026-01-25T10:00:00Z');
      expect(range.latest).toBe('2026-01-26T10:00:01Z');
    });
  });

  describe('getAvailableSymbols', () => {
    it('returns unique symbols', () => {
      const symbols = getAvailableSymbols();

      expect(symbols).toContain('BTC');
      expect(symbols).toContain('ETH');
      expect(symbols).toHaveLength(2);
    });
  });

  describe('getAvailableTopics', () => {
    it('returns unique topics', () => {
      const topics = getAvailableTopics();

      expect(topics).toContain('binance');
      expect(topics).toContain('chainlink');
      expect(topics).toHaveLength(2);
    });
  });
});
