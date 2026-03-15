/**
 * Tests for Timeline Loader (Story 1.1)
 *
 * Verifies:
 * - MessagePack round-trip serialization
 * - loadTimeline returns correct structure with deserialized events
 * - loadWindowsForSymbol returns metadata without blobs
 * - loadTimelines batch loading
 * - Events match MarketState.processEvent() schema
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pack, unpack } from 'msgpackr';
import { resolve } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

import {
  insertTimeline,
  insertTimelines,
  closeDb,
} from '../../src/factory/timeline-store.js';

import {
  loadTimeline,
  loadWindowsForSymbol,
  loadTimelines,
} from '../../src/factory/timeline-loader.js';

function makeTempDbPath() {
  const dir = mkdtempSync(resolve(tmpdir(), 'timeline-loader-test-'));
  return resolve(dir, 'test-timelines.sqlite');
}

/**
 * Sample timeline matching MarketState.processEvent() schema.
 * These are the exact event shapes the backtester will replay.
 */
function makeSampleTimeline() {
  return [
    {
      source: 'chainlink',
      timestamp: '2026-01-01T12:00:00.000Z',
      price: 50000.12,
      _ms: 1767268800000,
    },
    {
      source: 'polyRef',
      timestamp: '2026-01-01T12:00:01.000Z',
      price: 50010.50,
      _ms: 1767268801000,
    },
    {
      source: 'clobUp',
      timestamp: '2026-01-01T12:00:02.000Z',
      best_bid: 0.48,
      best_ask: 0.50,
      mid_price: 0.49,
      spread: 0.02,
      bid_size_top: 100,
      ask_size_top: 200,
      _ms: 1767268802000,
    },
    {
      source: 'clobDown',
      timestamp: '2026-01-01T12:00:02.500Z',
      best_bid: 0.50,
      best_ask: 0.52,
      mid_price: 0.51,
      spread: 0.02,
      bid_size_top: 150,
      ask_size_top: 250,
      _ms: 1767268802500,
    },
    {
      source: 'exchange_binance',
      timestamp: '2026-01-01T12:00:03.000Z',
      price: 50015.0,
      bid: 50014.5,
      ask: 50015.5,
      _ms: 1767268803000,
    },
    {
      source: 'l2Up',
      timestamp: '2026-01-01T12:00:04.000Z',
      best_bid: 0.475,
      best_ask: 0.505,
      mid_price: 0.49,
      spread: 0.03,
      bid_depth_1pct: 500,
      ask_depth_1pct: 600,
      top_levels: null,
      _ms: 1767268804000,
    },
    {
      source: 'coingecko',
      timestamp: '2026-01-01T12:00:05.000Z',
      price: 50012.0,
      _ms: 1767268805000,
    },
  ];
}

describe('Timeline Loader (Story 1.1)', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    process.env.TIMELINE_DB_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    delete process.env.TIMELINE_DB_PATH;
  });

  describe('MessagePack round-trip serialization', () => {
    it('preserves all event fields through pack → store → unpack cycle', () => {
      const original = makeSampleTimeline();
      const blob = pack(original);
      const restored = unpack(blob);

      expect(restored.length, 'Deserialized timeline must have same event count as original').toBe(original.length);

      for (let i = 0; i < original.length; i++) {
        expect(
          restored[i],
          `Event ${i} (source=${original[i].source}) must survive MessagePack round-trip exactly`
        ).toEqual(original[i]);
      }
    });

    it('preserves floating point precision for prices', () => {
      const events = [
        { source: 'chainlink', timestamp: '2026-01-01T12:00:00Z', price: 50000.123456789, _ms: 1 },
        { source: 'clobUp', timestamp: '2026-01-01T12:00:01Z', best_bid: 0.4812345, best_ask: 0.5067891, mid_price: 0.4940118, spread: 0.0255546, bid_size_top: 100, ask_size_top: 200, _ms: 2 },
      ];

      const restored = unpack(pack(events));
      expect(restored[0].price, 'Float64 price must survive msgpack without precision loss').toBe(50000.123456789);
      expect(restored[1].best_bid).toBe(0.4812345);
    });

    it('handles null values in events (e.g., exchange bid/ask)', () => {
      const events = [
        { source: 'exchange_coinbase', timestamp: '2026-01-01T12:00:00Z', price: 50000, bid: null, ask: null, _ms: 1 },
      ];

      const restored = unpack(pack(events));
      expect(restored[0].bid, 'Null bid must survive serialization').toBeNull();
      expect(restored[0].ask, 'Null ask must survive serialization').toBeNull();
    });

    it('handles large timelines (1000+ events) efficiently', () => {
      const events = [];
      for (let i = 0; i < 2000; i++) {
        events.push({
          source: 'exchange_binance',
          timestamp: `2026-01-01T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
          price: 50000 + i * 0.01,
          bid: 49999.5 + i * 0.01,
          ask: 50000.5 + i * 0.01,
          _ms: 1767268800000 + i * 1000,
        });
      }

      const start = Date.now();
      const blob = pack(events);
      const restored = unpack(blob);
      const elapsed = Date.now() - start;

      expect(restored.length).toBe(2000);
      expect(elapsed, 'Pack + unpack of 2000 events should complete in <50ms').toBeLessThan(50);
    });
  });

  describe('loadTimeline', () => {
    it('returns { window, timeline, quality } with deserialized events', () => {
      const sampleTimeline = makeSampleTimeline();
      insertTimeline({
        window_id: 'btc-2026-01-01T12:15:00Z',
        symbol: 'btc',
        window_close_time: '2026-01-01T12:15:00Z',
        window_open_time: '2026-01-01T12:00:00Z',
        ground_truth: 'UP',
        strike_price: 50005.0,
        oracle_price_at_open: 49990.0,
        chainlink_price_at_close: 50020.0,
        timeline: pack(sampleTimeline),
        event_count: sampleTimeline.length,
        data_quality: JSON.stringify({ rtds_count: 2, clob_count: 2, exchange_count: 1, l2_count: 1, flags: [] }),
        built_at: '2026-03-14T00:00:00Z',
      });

      const result = loadTimeline('btc-2026-01-01T12:15:00Z');

      expect(result, 'loadTimeline should return a result for a valid window_id').toBeDefined();
      expect(result.window.window_id).toBe('btc-2026-01-01T12:15:00Z');
      expect(result.window.symbol).toBe('btc');
      expect(result.window.ground_truth).toBe('UP');
      expect(result.window.strike_price).toBe(50005.0);

      // Timeline should be deserialized from MessagePack
      expect(Array.isArray(result.timeline), 'timeline must be an array of events').toBe(true);
      expect(result.timeline.length).toBe(sampleTimeline.length);

      // Verify event shapes match what MarketState expects
      const clEvent = result.timeline.find(e => e.source === 'chainlink');
      expect(clEvent, 'Timeline must contain chainlink events').toBeDefined();
      expect(typeof clEvent.price, 'chainlink price must be a number').toBe('number');
      expect(typeof clEvent.timestamp, 'chainlink timestamp must be a string').toBe('string');
      expect(typeof clEvent._ms, '_ms must be a number for fast comparison').toBe('number');

      const clobEvent = result.timeline.find(e => e.source === 'clobUp');
      expect(clobEvent, 'Timeline must contain clobUp events').toBeDefined();
      expect(typeof clobEvent.best_bid, 'CLOB best_bid must be a number').toBe('number');
      expect(typeof clobEvent.best_ask, 'CLOB best_ask must be a number').toBe('number');

      // Quality should be parsed JSON
      expect(result.quality, 'quality must be parsed from JSON').toBeDefined();
      expect(result.quality.rtds_count).toBe(2);
    });

    it('returns null for non-existent window', () => {
      const result = loadTimeline('btc-nonexistent');
      expect(result, 'Non-existent window should return null, not throw').toBeNull();
    });
  });

  describe('loadWindowsForSymbol', () => {
    it('returns window metadata without timeline data (for sampling)', () => {
      insertTimelines([
        {
          window_id: 'btc-2026-01-01T12:15:00Z',
          symbol: 'btc',
          window_close_time: '2026-01-01T12:15:00Z',
          window_open_time: '2026-01-01T12:00:00Z',
          ground_truth: 'UP',
          strike_price: 50005.0,
          oracle_price_at_open: 49990.0,
          chainlink_price_at_close: 50020.0,
          timeline: pack([{ source: 'chainlink', timestamp: '2026-01-01T12:00:00Z', price: 50000, _ms: 1 }]),
          event_count: 1,
          data_quality: null,
          built_at: '2026-03-14T00:00:00Z',
        },
      ]);

      const windows = loadWindowsForSymbol('btc');
      expect(windows.length).toBe(1);
      expect(windows[0].window_id).toBe('btc-2026-01-01T12:15:00Z');
      expect(windows[0], 'Window metadata must NOT include timeline blob — that is the point of this function').not.toHaveProperty('timeline');
    });
  });

  describe('loadTimelines (batch)', () => {
    it('loads multiple timelines efficiently by window ID', () => {
      const timeline1 = [{ source: 'chainlink', timestamp: '2026-01-01T12:00:00Z', price: 50000, _ms: 1 }];
      const timeline2 = [{ source: 'chainlink', timestamp: '2026-01-01T12:15:00Z', price: 50100, _ms: 2 }];

      insertTimelines([
        {
          window_id: 'btc-2026-01-01T12:15:00Z',
          symbol: 'btc',
          window_close_time: '2026-01-01T12:15:00Z',
          window_open_time: '2026-01-01T12:00:00Z',
          ground_truth: 'UP',
          strike_price: 50005,
          oracle_price_at_open: 49990,
          chainlink_price_at_close: 50020,
          timeline: pack(timeline1),
          event_count: 1,
          data_quality: null,
          built_at: '2026-03-14T00:00:00Z',
        },
        {
          window_id: 'btc-2026-01-01T12:30:00Z',
          symbol: 'btc',
          window_close_time: '2026-01-01T12:30:00Z',
          window_open_time: '2026-01-01T12:15:00Z',
          ground_truth: 'DOWN',
          strike_price: 50050,
          oracle_price_at_open: 50010,
          chainlink_price_at_close: 50030,
          timeline: pack(timeline2),
          event_count: 1,
          data_quality: null,
          built_at: '2026-03-14T00:00:00Z',
        },
      ]);

      const results = loadTimelines(['btc-2026-01-01T12:15:00Z', 'btc-2026-01-01T12:30:00Z', 'btc-nonexistent']);

      expect(results.size, 'Should load 2 existing windows, skip 1 nonexistent').toBe(2);
      expect(results.get('btc-2026-01-01T12:15:00Z').window.ground_truth).toBe('UP');
      expect(results.get('btc-2026-01-01T12:30:00Z').window.ground_truth).toBe('DOWN');
    });
  });
});
