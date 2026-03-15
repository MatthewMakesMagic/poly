/**
 * Unit tests for Stratified Random Sampler (Story 3.1)
 *
 * What this tests:
 *   - Deterministic reproducibility: same seed + same data = identical samples
 *   - Proportional allocation across weekly strata
 *   - Edge cases: empty input, count > available, single window
 *   - Daily and monthly stratification modes
 *   - Output is sorted by window_close_time
 */

import { describe, it, expect } from 'vitest';
import { sampleWindows } from '../../../src/factory/sampler.js';

// Generate synthetic windows spanning multiple weeks
function makeWindows(count, startDate = '2026-02-01') {
  const windows = [];
  const start = new Date(startDate + 'T00:00:00Z');
  for (let i = 0; i < count; i++) {
    const closeTime = new Date(start.getTime() + i * 15 * 60 * 1000); // 15min apart
    windows.push({
      window_id: `btc-${closeTime.toISOString()}`,
      symbol: 'btc',
      window_close_time: closeTime.toISOString(),
      window_open_time: new Date(closeTime.getTime() - 5 * 60 * 1000).toISOString(),
      ground_truth: i % 2 === 0 ? 'UP' : 'DOWN',
      strike_price: 95000 + i * 10,
      event_count: 100 + i,
    });
  }
  return windows;
}

describe('sampleWindows', () => {
  it('returns empty array for empty input', () => {
    expect(sampleWindows([])).toEqual([]);
    expect(sampleWindows(null)).toEqual([]);
    expect(sampleWindows(undefined)).toEqual([]);
  });

  it('returns all windows when count >= available', () => {
    const windows = makeWindows(50);
    const result = sampleWindows(windows, { count: 200 });
    expect(result).toHaveLength(50);
  });

  it('returns all windows when count === available', () => {
    const windows = makeWindows(200);
    const result = sampleWindows(windows, { count: 200 });
    expect(result).toHaveLength(200);
  });

  it('samples exactly the requested count when count < available', () => {
    const windows = makeWindows(500);
    const result = sampleWindows(windows, { count: 100, seed: 42 });
    expect(result).toHaveLength(100);
  });

  it('default count is 200', () => {
    const windows = makeWindows(500);
    const result = sampleWindows(windows, { seed: 42 });
    expect(result).toHaveLength(200);
  });

  it('is deterministic: same seed + same data = identical samples', () => {
    const windows = makeWindows(500);
    const r1 = sampleWindows(windows, { count: 100, seed: 42 });
    const r2 = sampleWindows(windows, { count: 100, seed: 42 });
    expect(r1.map(w => w.window_id)).toEqual(r2.map(w => w.window_id));
  });

  it('different seeds produce different samples', () => {
    const windows = makeWindows(500);
    const r1 = sampleWindows(windows, { count: 100, seed: 42 });
    const r2 = sampleWindows(windows, { count: 100, seed: 123 });
    const ids1 = r1.map(w => w.window_id);
    const ids2 = r2.map(w => w.window_id);
    // They should differ (statistically guaranteed with 500 windows, 100 samples)
    expect(ids1).not.toEqual(ids2);
  });

  it('output is sorted by window_close_time', () => {
    const windows = makeWindows(500);
    const result = sampleWindows(windows, { count: 100, seed: 42 });
    for (let i = 1; i < result.length; i++) {
      expect(result[i].window_close_time >= result[i - 1].window_close_time).toBe(true);
    }
  });

  it('proportional allocation: strata with more windows get more samples', () => {
    // Create windows heavily concentrated in week 1, fewer in later weeks
    // Week 1: 400 windows (15min apart covers ~4 days)
    // Week 2-3: spread thinner
    const windows = [
      ...makeWindows(400, '2026-02-02'), // Most in week 5
      ...makeWindows(50, '2026-02-16'),  // Week 7-8
      ...makeWindows(50, '2026-03-02'),  // Week 9-10
    ];

    const result = sampleWindows(windows, { count: 100, seed: 42, stratify: 'weekly' });
    expect(result).toHaveLength(100);

    // Check that week 1 group (which has 80% of data) gets roughly 80% of samples
    const week5Count = result.filter(w => {
      const d = new Date(w.window_close_time);
      return d >= new Date('2026-02-02') && d < new Date('2026-02-09');
    }).length;
    // Allow some flexibility but it should be substantially more
    expect(week5Count).toBeGreaterThan(50);
  });

  it('supports daily stratification', () => {
    const windows = makeWindows(300);
    const result = sampleWindows(windows, { count: 50, seed: 42, stratify: 'daily' });
    expect(result).toHaveLength(50);

    // Verify determinism with daily stratify
    const result2 = sampleWindows(windows, { count: 50, seed: 42, stratify: 'daily' });
    expect(result.map(w => w.window_id)).toEqual(result2.map(w => w.window_id));
  });

  it('supports monthly stratification', () => {
    // Span multiple months
    const windows = [
      ...makeWindows(200, '2026-01-15'),
      ...makeWindows(200, '2026-02-15'),
      ...makeWindows(200, '2026-03-15'),
    ];
    const result = sampleWindows(windows, { count: 90, seed: 42, stratify: 'monthly' });
    expect(result).toHaveLength(90);

    // Each month should get roughly 30 samples (proportional)
    const jan = result.filter(w => w.window_close_time.startsWith('2026-01'));
    const feb = result.filter(w => w.window_close_time.startsWith('2026-02'));
    const mar = result.filter(w => w.window_close_time.startsWith('2026-03'));
    expect(jan.length).toBeGreaterThan(20);
    expect(feb.length).toBeGreaterThan(20);
    expect(mar.length).toBeGreaterThan(20);
  });

  it('handles single window input', () => {
    const windows = makeWindows(1);
    const result = sampleWindows(windows, { count: 200 });
    expect(result).toHaveLength(1);
    expect(result[0].window_id).toBe(windows[0].window_id);
  });

  it('sampled windows are a subset of the input', () => {
    const windows = makeWindows(500);
    const result = sampleWindows(windows, { count: 100, seed: 42 });
    const inputIds = new Set(windows.map(w => w.window_id));
    for (const w of result) {
      expect(inputIds.has(w.window_id)).toBe(true);
    }
  });

  it('no duplicate windows in sample', () => {
    const windows = makeWindows(500);
    const result = sampleWindows(windows, { count: 100, seed: 42 });
    const ids = result.map(w => w.window_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
