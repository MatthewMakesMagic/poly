/**
 * Unit tests for splitWindows (Story 12.3: Out-of-sample holdout)
 */

import { describe, it, expect } from 'vitest';
import { splitWindows } from '../../../src/factory/sampler.js';

function makeWindow(closeTime) {
  return { window_close_time: closeTime, symbol: 'btc', window_id: `btc-${closeTime}` };
}

describe('splitWindows', () => {
  it('returns empty arrays for empty input', () => {
    const { train, test } = splitWindows([]);
    expect(train).toEqual([]);
    expect(test).toEqual([]);
  });

  it('splits 70/30 by default (chronological)', () => {
    const windows = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 1 + Math.floor(i / 96), (i % 96) * 15));
      return makeWindow(d.toISOString());
    });
    const { train, test } = splitWindows(windows);
    expect(train.length).toBe(70);
    expect(test.length).toBe(30);
  });

  it('respects custom trainRatio', () => {
    const windows = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 1 + Math.floor(i / 96), (i % 96) * 15));
      return makeWindow(d.toISOString());
    });
    const { train, test } = splitWindows(windows, { trainRatio: 0.8 });
    expect(train.length).toBe(80);
    expect(test.length).toBe(20);
  });

  it('splits chronologically (train is earlier, test is later)', () => {
    const windows = [
      makeWindow('2026-01-01T00:00:00Z'),
      makeWindow('2026-02-01T00:00:00Z'),
      makeWindow('2026-03-01T00:00:00Z'),
      makeWindow('2026-04-01T00:00:00Z'),
    ];
    const { train, test } = splitWindows(windows, { trainRatio: 0.5 });
    expect(train.length).toBe(2);
    expect(test.length).toBe(2);
    expect(train[0].window_close_time).toBe('2026-01-01T00:00:00Z');
    expect(train[1].window_close_time).toBe('2026-02-01T00:00:00Z');
    expect(test[0].window_close_time).toBe('2026-03-01T00:00:00Z');
    expect(test[1].window_close_time).toBe('2026-04-01T00:00:00Z');
  });

  it('handles unsorted input (sorts internally)', () => {
    const windows = [
      makeWindow('2026-04-01T00:00:00Z'),
      makeWindow('2026-01-01T00:00:00Z'),
      makeWindow('2026-03-01T00:00:00Z'),
      makeWindow('2026-02-01T00:00:00Z'),
    ];
    const { train, test } = splitWindows(windows, { trainRatio: 0.5 });
    expect(train[0].window_close_time).toBe('2026-01-01T00:00:00Z');
    expect(test[1].window_close_time).toBe('2026-04-01T00:00:00Z');
  });

  it('is deterministic (same input = same split)', () => {
    const windows = Array.from({ length: 50 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 2, 1, i * 15));
      return makeWindow(d.toISOString());
    });
    const result1 = splitWindows(windows);
    const result2 = splitWindows(windows);
    expect(result1.train.map(w => w.window_id)).toEqual(result2.train.map(w => w.window_id));
    expect(result1.test.map(w => w.window_id)).toEqual(result2.test.map(w => w.window_id));
  });
});
