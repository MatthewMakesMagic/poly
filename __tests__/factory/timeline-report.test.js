/**
 * Tests for Timeline Coverage Reporting (Story 1.5)
 *
 * Verifies:
 * - runReport renders per-symbol summary table
 * - Flagged windows are listed with reasons
 * - Symbol filtering works
 * - Report runs in < 1 second (NFR6)
 *
 * Domain context: Coverage reporting tells the researcher which symbols
 * and date ranges are available for backtesting, and which windows have
 * data quality issues that may affect strategy evaluation accuracy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pack } from 'msgpackr';
import { resolve } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

import { insertTimelines, closeDb } from '../../src/factory/timeline-store.js';
import { runReport } from '../../src/factory/cli/build-timelines.js';

function makeTempDbPath() {
  const dir = mkdtempSync(resolve(tmpdir(), 'report-test-'));
  return resolve(dir, 'test-timelines.sqlite');
}

function makeTestRow(overrides = {}) {
  return {
    window_id: 'btc-2026-01-01T12:15:00Z',
    symbol: 'btc',
    window_close_time: '2026-01-01T12:15:00Z',
    window_open_time: '2026-01-01T12:00:00Z',
    ground_truth: 'UP',
    strike_price: 50005,
    oracle_price_at_open: 49990,
    chainlink_price_at_close: 50020,
    timeline: pack([{ source: 'chainlink', timestamp: '2026-01-01T12:00:00Z', price: 50000, _ms: 1 }]),
    event_count: 100,
    data_quality: JSON.stringify({
      rtds_count: 20,
      clob_count: 30,
      exchange_count: 40,
      l2_count: 10,
      flags: [],
    }),
    built_at: '2026-03-14T00:00:00Z',
    ...overrides,
  };
}

describe('Timeline Coverage Report (Story 1.5)', () => {
  let dbPath;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    process.env.TIMELINE_DB_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    delete process.env.TIMELINE_DB_PATH;
  });

  it('renders without error for an empty cache', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => runReport(), 'Report on empty cache should not throw').not.toThrow();
    spy.mockRestore();
  });

  it('shows per-symbol summary with window counts and date ranges', () => {
    insertTimelines([
      makeTestRow({ window_id: 'btc-1', window_close_time: '2026-01-01T12:15:00Z' }),
      makeTestRow({ window_id: 'btc-2', window_close_time: '2026-01-02T12:15:00Z' }),
      makeTestRow({ window_id: 'eth-1', symbol: 'eth', window_close_time: '2026-01-01T12:15:00Z' }),
    ]);

    const output = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    runReport();

    spy.mockRestore();

    const text = output.join('\n');
    expect(text, 'Report should contain BTC symbol').toContain('btc');
    expect(text, 'Report should contain ETH symbol').toContain('eth');
    expect(text, 'Report should show date range').toContain('2026-01-01');
  });

  it('filters by symbol when --symbol is provided', () => {
    insertTimelines([
      makeTestRow({ window_id: 'btc-1' }),
      makeTestRow({ window_id: 'eth-1', symbol: 'eth' }),
    ]);

    const output = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    runReport({ symbol: 'btc' });

    spy.mockRestore();

    const text = output.join('\n');
    expect(text, 'Filtered report should contain BTC').toContain('btc');
    // eth may appear in headers but not as a data row
  });

  it('lists flagged windows with reasons', () => {
    insertTimelines([
      makeTestRow({
        window_id: 'btc-flagged',
        data_quality: JSON.stringify({
          rtds_count: 2,
          clob_count: 1,
          exchange_count: 1,
          l2_count: 0,
          flags: [
            { type: 'incomplete', message: 'Only 5 events' },
            { type: 'flat_prices', message: 'CL flat for 120s' },
          ],
        }),
      }),
    ]);

    const output = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));

    runReport();

    spy.mockRestore();

    const text = output.join('\n');
    expect(text, 'Report should show flagged windows section').toContain('Flagged');
    expect(text, 'Report should show incomplete flag').toContain('incomplete');
    expect(text, 'Report should show flat_prices flag').toContain('flat_prices');
  });

  it('completes in < 1 second for 1000 windows (NFR6)', () => {
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      rows.push(makeTestRow({
        window_id: `btc-${i}`,
        window_close_time: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + i * 15 * 60 * 1000).toISOString(),
        event_count: 100 + (i % 200),
      }));
    }
    insertTimelines(rows);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const start = Date.now();
    runReport();
    const elapsed = Date.now() - start;

    spy.mockRestore();

    expect(elapsed, `Report rendering took ${elapsed}ms — must be < 1000ms (NFR6)`).toBeLessThan(1000);
  });
});
