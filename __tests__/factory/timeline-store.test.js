/**
 * Tests for Timeline SQLite Store (Story 1.1)
 *
 * Verifies:
 * - Schema creation with correct table structure and indexes
 * - Insert/retrieve round-trips
 * - Batch operations
 * - Incremental build helpers (getLatestWindowTime, getExistingWindowIds)
 * - Cache summary statistics
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pack } from 'msgpackr';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// We test the store by pointing it at a temp directory
import {
  getDb,
  closeDb,
  insertTimeline,
  insertTimelines,
  getTimelineRow,
  getWindowsForSymbol,
  getLatestWindowTime,
  deleteSymbolTimelines,
  getCacheSummary,
  getExistingWindowIds,
} from '../../src/factory/timeline-store.js';

function makeTempDbPath() {
  const dir = mkdtempSync(resolve(tmpdir(), 'timeline-test-'));
  return resolve(dir, 'test-timelines.sqlite');
}

function makeTestRow(overrides = {}) {
  const sampleTimeline = [
    { source: 'chainlink', timestamp: '2026-01-01T12:00:00Z', price: 50000, _ms: 1767268800000 },
    { source: 'polyRef', timestamp: '2026-01-01T12:00:01Z', price: 50010, _ms: 1767268801000 },
  ];

  return {
    window_id: 'btc-2026-01-01T12:15:00Z',
    symbol: 'btc',
    window_close_time: '2026-01-01T12:15:00Z',
    window_open_time: '2026-01-01T12:00:00Z',
    ground_truth: 'UP',
    strike_price: 50005.0,
    oracle_price_at_open: 49990.0,
    chainlink_price_at_close: 50020.0,
    timeline: pack(sampleTimeline),
    event_count: 2,
    data_quality: JSON.stringify({ rtds_count: 1, clob_count: 0, exchange_count: 0, l2_count: 0, flags: [] }),
    built_at: '2026-03-14T00:00:00Z',
    ...overrides,
  };
}

describe('Timeline Store (Story 1.1)', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    process.env.TIMELINE_DB_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    delete process.env.TIMELINE_DB_PATH;
  });

  describe('Schema creation', () => {
    it('creates timelines table with correct columns on first access', () => {
      const db = getDb();
      const tableInfo = db.prepare("PRAGMA table_info('timelines')").all();
      const columnNames = tableInfo.map(c => c.name);

      expect(columnNames, 'Schema must include all columns from architecture spec').toEqual([
        'window_id', 'symbol', 'window_close_time', 'window_open_time',
        'ground_truth', 'strike_price', 'oracle_price_at_open', 'chainlink_price_at_close',
        'timeline', 'event_count', 'data_quality', 'built_at',
      ]);

      // Check primary key
      const pk = tableInfo.find(c => c.name === 'window_id');
      expect(pk.pk, 'window_id must be the primary key').toBe(1);
    });

    it('creates required indexes for query performance', () => {
      const db = getDb();
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='timelines'").all();
      const indexNames = indexes.map(i => i.name);

      expect(indexNames, 'Must have symbol index for per-symbol queries').toContain('idx_timelines_symbol');
      expect(indexNames, 'Must have close time index for date range queries').toContain('idx_timelines_close');
    });

    it('schema creation is idempotent — second call does not error', () => {
      getDb(); // First call creates schema
      closeDb();
      expect(() => getDb(), 'Re-opening should not throw').not.toThrow();
    });
  });

  describe('Insert and retrieve', () => {
    it('inserts and retrieves a timeline row with all fields', () => {
      const row = makeTestRow();
      insertTimeline(row);
      const retrieved = getTimelineRow('btc-2026-01-01T12:15:00Z');

      expect(retrieved, 'Row should be retrievable after insert').toBeDefined();
      expect(retrieved.window_id).toBe('btc-2026-01-01T12:15:00Z');
      expect(retrieved.symbol).toBe('btc');
      expect(retrieved.ground_truth).toBe('UP');
      expect(retrieved.strike_price).toBe(50005.0);
      expect(retrieved.event_count).toBe(2);
      expect(retrieved.timeline, 'Timeline column should be a Buffer (BLOB)').toBeInstanceOf(Buffer);
    });

    it('INSERT OR REPLACE updates existing rows', () => {
      insertTimeline(makeTestRow());
      insertTimeline(makeTestRow({ ground_truth: 'DOWN', event_count: 5 }));

      const row = getTimelineRow('btc-2026-01-01T12:15:00Z');
      expect(row.ground_truth, 'Ground truth should be updated to DOWN after replace').toBe('DOWN');
      expect(row.event_count, 'Event count should be updated after replace').toBe(5);
    });

    it('handles null optional fields (ground_truth, strike_price)', () => {
      insertTimeline(makeTestRow({ ground_truth: null, strike_price: null, oracle_price_at_open: null }));
      const row = getTimelineRow('btc-2026-01-01T12:15:00Z');
      expect(row.ground_truth).toBeNull();
      expect(row.strike_price).toBeNull();
      expect(row.oracle_price_at_open).toBeNull();
    });
  });

  describe('Batch insert', () => {
    it('inserts multiple rows in a transaction', () => {
      const rows = [
        makeTestRow({ window_id: 'btc-2026-01-01T12:15:00Z', window_close_time: '2026-01-01T12:15:00Z' }),
        makeTestRow({ window_id: 'btc-2026-01-01T12:30:00Z', window_close_time: '2026-01-01T12:30:00Z' }),
        makeTestRow({ window_id: 'btc-2026-01-01T12:45:00Z', window_close_time: '2026-01-01T12:45:00Z' }),
      ];

      insertTimelines(rows);

      expect(getTimelineRow('btc-2026-01-01T12:15:00Z'), 'First row should exist').toBeDefined();
      expect(getTimelineRow('btc-2026-01-01T12:30:00Z'), 'Second row should exist').toBeDefined();
      expect(getTimelineRow('btc-2026-01-01T12:45:00Z'), 'Third row should exist').toBeDefined();
    });
  });

  describe('Window metadata queries', () => {
    beforeEach(() => {
      insertTimelines([
        makeTestRow({ window_id: 'btc-2026-01-01T12:15:00Z', window_close_time: '2026-01-01T12:15:00Z' }),
        makeTestRow({ window_id: 'btc-2026-01-01T12:30:00Z', window_close_time: '2026-01-01T12:30:00Z' }),
        makeTestRow({ window_id: 'eth-2026-01-01T12:15:00Z', symbol: 'eth', window_close_time: '2026-01-01T12:15:00Z' }),
      ]);
    });

    it('getWindowsForSymbol returns metadata without timeline blob', () => {
      const windows = getWindowsForSymbol('btc');
      expect(windows.length, 'Should return 2 BTC windows').toBe(2);
      expect(windows[0]).not.toHaveProperty('timeline');
      expect(windows[0].window_id).toBe('btc-2026-01-01T12:15:00Z');
      expect(windows[0].symbol).toBe('btc');
    });

    it('getWindowsForSymbol filters by date range', () => {
      const windows = getWindowsForSymbol('btc', {
        startDate: '2026-01-01T12:20:00Z',
      });
      expect(windows.length, 'Only windows after 12:20 should be returned').toBe(1);
      expect(windows[0].window_close_time).toBe('2026-01-01T12:30:00Z');
    });

    it('getLatestWindowTime returns the most recent close time for a symbol', () => {
      const latest = getLatestWindowTime('btc');
      expect(latest, 'Latest BTC window should be 12:30').toBe('2026-01-01T12:30:00Z');
    });

    it('getLatestWindowTime returns null for unknown symbol', () => {
      const latest = getLatestWindowTime('sol');
      expect(latest, 'Unknown symbol should return null').toBeNull();
    });

    it('getExistingWindowIds returns a Set of cached window IDs', () => {
      const ids = getExistingWindowIds('btc');
      expect(ids.size, 'Should have 2 BTC window IDs').toBe(2);
      expect(ids.has('btc-2026-01-01T12:15:00Z')).toBe(true);
      expect(ids.has('btc-2026-01-01T12:30:00Z')).toBe(true);
    });
  });

  describe('Delete and rebuild', () => {
    it('deleteSymbolTimelines removes all windows for a symbol', () => {
      insertTimelines([
        makeTestRow({ window_id: 'btc-1', symbol: 'btc' }),
        makeTestRow({ window_id: 'btc-2', symbol: 'btc' }),
        makeTestRow({ window_id: 'eth-1', symbol: 'eth' }),
      ]);

      const deleted = deleteSymbolTimelines('btc');
      expect(deleted, 'Should delete 2 BTC windows').toBe(2);

      expect(getTimelineRow('btc-1'), 'BTC window should be gone').toBeUndefined();
      expect(getTimelineRow('eth-1'), 'ETH window should survive').toBeDefined();
    });
  });

  describe('Cache summary', () => {
    it('returns per-symbol statistics', () => {
      insertTimelines([
        makeTestRow({ window_id: 'btc-1', symbol: 'btc', window_close_time: '2026-01-01T12:15:00Z', event_count: 100 }),
        makeTestRow({ window_id: 'btc-2', symbol: 'btc', window_close_time: '2026-01-02T12:15:00Z', event_count: 200 }),
        makeTestRow({ window_id: 'eth-1', symbol: 'eth', window_close_time: '2026-01-01T12:15:00Z', event_count: 50 }),
      ]);

      const summary = getCacheSummary();
      expect(summary.length, 'Should have 2 symbols').toBe(2);

      const btc = summary.find(s => s.symbol === 'btc');
      expect(btc.total_windows, 'BTC should have 2 windows').toBe(2);
      expect(btc.avg_event_count, 'BTC avg events should be 150').toBe(150);
      expect(btc.earliest).toBe('2026-01-01T12:15:00Z');
      expect(btc.latest).toBe('2026-01-02T12:15:00Z');
    });
  });
});
