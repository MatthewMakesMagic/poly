/**
 * Unit tests for Timeline Auto-Builder
 *
 * Tests the onWindowResolved() function with mocked persistence and msgpackr.
 * Verifies:
 *   - Ground truth resolution logic
 *   - 5-second settle delay
 *   - Timeline building and PG write
 *   - ON CONFLICT DO NOTHING semantics
 *   - Never-throw guarantee (error swallowing)
 *   - Skip behavior for no ground truth / empty timeline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock persistence before importing the module
const mockAll = vi.fn();
const mockRun = vi.fn();

vi.mock('../../../src/persistence/index.js', () => ({
  default: {
    all: (...args) => mockAll(...args),
    run: (...args) => mockRun(...args),
  },
}));

// Mock msgpackr
vi.mock('msgpackr', () => ({
  pack: vi.fn((data) => Buffer.from(JSON.stringify(data))),
}));

// Now import the module under test
const { onWindowResolved, _testing } = await import(
  '../../../src/factory/timeline-auto-builder.js'
);

// ── Helpers ───────────────────────────────────────────────────────────

function makeWindowEvent(overrides = {}) {
  return {
    symbol: 'btc',
    window_close_time: '2026-03-15T12:15:00.000Z',
    strike_price: 85000,
    oracle_price_at_open: 84950,
    chainlink_price_at_close: 85050,
    resolved_direction: 'up',
    onchain_resolved_direction: null,
    gamma_resolved_direction: null,
    ...overrides,
  };
}

function makeMockTicks() {
  return {
    rtds: [
      { timestamp: '2026-03-15T12:01:00.000Z', topic: 'crypto_prices_chainlink', symbol: 'btc', price: '85000', received_at: '2026-03-15T12:01:00.000Z' },
      { timestamp: '2026-03-15T12:10:00.000Z', topic: 'crypto_prices', symbol: 'btc', price: '85020', received_at: '2026-03-15T12:10:00.000Z' },
    ],
    clob: [
      { timestamp: '2026-03-15T12:05:00.000Z', symbol: 'btc-up', token_id: 'tok1', best_bid: '0.55', best_ask: '0.57', mid_price: '0.56', spread: '0.02', bid_size_top: '100', ask_size_top: '80', window_epoch: 123 },
    ],
    exchange: [
      { timestamp: '2026-03-15T12:08:00.000Z', exchange: 'binance', symbol: 'btc', price: '85010', bid: '85009', ask: '85011' },
    ],
    l2: [],
    coingecko: [],
  };
}

/**
 * Set up mockAll to return ticks in the expected order:
 *   call 0 → rtds, call 1 → clob, call 2 → exchange, call 3 → l2, call 4 → coingecko
 */
function setupMockTicks(ticks = makeMockTicks()) {
  let callCount = 0;
  mockAll.mockImplementation(() => {
    const idx = callCount++;
    switch (idx) {
      case 0: return Promise.resolve(ticks.rtds);
      case 1: return Promise.resolve(ticks.clob);
      case 2: return Promise.resolve(ticks.exchange);
      case 3: return Promise.resolve(ticks.l2);
      case 4: return Promise.resolve(ticks.coingecko);
      default: return Promise.resolve([]);
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Timeline Auto-Builder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockAll.mockReset();
    mockRun.mockReset();
    mockRun.mockResolvedValue({ changes: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Ground truth resolution ───────────────────────────────────────

  describe('resolveGroundTruth', () => {
    it('prefers gamma_resolved_direction', () => {
      expect(_testing.resolveGroundTruth({
        gamma_resolved_direction: 'up',
        onchain_resolved_direction: 'down',
        resolved_direction: 'down',
      })).toBe('up');
    });

    it('falls back to onchain_resolved_direction', () => {
      expect(_testing.resolveGroundTruth({
        gamma_resolved_direction: null,
        onchain_resolved_direction: 'down',
        resolved_direction: 'up',
      })).toBe('down');
    });

    it('falls back to resolved_direction', () => {
      expect(_testing.resolveGroundTruth({
        gamma_resolved_direction: null,
        onchain_resolved_direction: null,
        resolved_direction: 'up',
      })).toBe('up');
    });

    it('returns null when no ground truth', () => {
      expect(_testing.resolveGroundTruth({
        gamma_resolved_direction: null,
        onchain_resolved_direction: null,
        resolved_direction: null,
      })).toBeNull();
    });
  });

  // ── makeWindowId ──────────────────────────────────────────────────

  describe('makeWindowId', () => {
    it('creates deterministic ID from symbol and close time', () => {
      expect(_testing.makeWindowId('btc', '2026-03-15T12:15:00.000Z'))
        .toBe('btc-2026-03-15T12:15:00.000Z');
    });

    it('handles Date objects', () => {
      const id = _testing.makeWindowId('eth', new Date('2026-03-15T12:15:00.000Z'));
      expect(id).toBe('eth-2026-03-15T12:15:00.000Z');
    });
  });

  // ── mergeTimeline ─────────────────────────────────────────────────

  describe('mergeTimeline', () => {
    const openMs = new Date('2026-03-15T12:00:00.000Z').getTime();
    const closeMs = new Date('2026-03-15T12:15:00.000Z').getTime();

    it('merges and sorts events from all sources', () => {
      const ticks = makeMockTicks();
      const timeline = _testing.mergeTimeline({
        rtdsTicks: ticks.rtds,
        clobSnapshots: ticks.clob,
        exchangeTicks: ticks.exchange,
        l2BookTicks: ticks.l2,
        coingeckoTicks: ticks.coingecko,
        openMs,
        closeMs,
      });

      expect(timeline.length).toBe(4); // 2 rtds + 1 clob + 1 exchange
      // Verify sorted by _ms
      for (let i = 1; i < timeline.length; i++) {
        expect(timeline[i]._ms).toBeGreaterThanOrEqual(timeline[i - 1]._ms);
      }
    });

    it('filters out-of-bounds events', () => {
      const timeline = _testing.mergeTimeline({
        rtdsTicks: [
          { timestamp: '2026-03-15T11:59:59.000Z', topic: 'crypto_prices_chainlink', price: '85000' },
          { timestamp: '2026-03-15T12:15:00.000Z', topic: 'crypto_prices_chainlink', price: '85000' },
        ],
        clobSnapshots: [],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs,
        closeMs,
      });

      expect(timeline.length).toBe(0);
    });

    it('filters stale CLOB data (mid outside 0.05-0.95)', () => {
      const timeline = _testing.mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [
          { timestamp: '2026-03-15T12:05:00.000Z', symbol: 'btc-up', best_bid: '0.01', best_ask: '0.03', mid_price: '0.02', spread: '0.02', bid_size_top: '100', ask_size_top: '80' },
          { timestamp: '2026-03-15T12:06:00.000Z', symbol: 'btc-up', best_bid: '0.97', best_ask: '0.99', mid_price: '0.98', spread: '0.02', bid_size_top: '100', ask_size_top: '80' },
        ],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs,
        closeMs,
      });

      expect(timeline.length).toBe(0);
    });

    it('tags chainlink vs polyRef correctly', () => {
      const timeline = _testing.mergeTimeline({
        rtdsTicks: [
          { timestamp: '2026-03-15T12:01:00.000Z', topic: 'crypto_prices_chainlink', price: '85000' },
          { timestamp: '2026-03-15T12:02:00.000Z', topic: 'crypto_prices', price: '85010' },
        ],
        clobSnapshots: [],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs,
        closeMs,
      });

      expect(timeline[0].source).toBe('chainlink');
      expect(timeline[1].source).toBe('polyRef');
    });
  });

  // ── validateWindow ────────────────────────────────────────────────

  describe('validateWindow', () => {
    it('flags incomplete windows with < 10 events', () => {
      const quality = _testing.validateWindow({
        timeline: [{ _ms: 1 }, { _ms: 2 }],
        rtdsCount: 1,
        clobCount: 1,
        exchangeCount: 0,
        l2Count: 0,
      });

      expect(quality.flags).toHaveLength(1);
      expect(quality.flags[0].type).toBe('incomplete');
    });

    it('reports clean for windows with 10+ events', () => {
      const events = Array.from({ length: 15 }, (_, i) => ({ _ms: i }));
      const quality = _testing.validateWindow({
        timeline: events,
        rtdsCount: 5,
        clobCount: 5,
        exchangeCount: 3,
        l2Count: 2,
      });

      expect(quality.flags).toHaveLength(0);
      expect(quality.event_count).toBe(15);
    });
  });

  // ── onWindowResolved (main function) ──────────────────────────────

  describe('onWindowResolved', () => {
    it('waits 5 seconds before building', async () => {
      setupMockTicks();
      const event = makeWindowEvent();

      const promise = onWindowResolved(event);

      // At time 0, persistence.all should not have been called yet
      expect(mockAll).not.toHaveBeenCalled();

      // Advance past the settle delay
      await vi.advanceTimersByTimeAsync(_testing.SETTLE_DELAY_MS + 100);
      await promise;

      // Now persistence.all should have been called (5 calls for tick loading)
      expect(mockAll).toHaveBeenCalled();
    });

    it('writes to pg_timelines via persistence.run', async () => {
      setupMockTicks();
      const event = makeWindowEvent();

      const promise = onWindowResolved(event);
      await vi.advanceTimersByTimeAsync(_testing.SETTLE_DELAY_MS + 100);
      await promise;

      expect(mockRun).toHaveBeenCalledTimes(1);
      const [sql, params] = mockRun.mock.calls[0];
      expect(sql).toContain('INSERT INTO pg_timelines');
      expect(sql).toContain('ON CONFLICT (window_id) DO NOTHING');
      expect(params[0]).toBe('btc-2026-03-15T12:15:00.000Z'); // window_id
      expect(params[1]).toBe('btc'); // symbol
      expect(params[4]).toBe('up'); // ground_truth
    });

    it('skips when no ground truth available', async () => {
      const event = makeWindowEvent({
        resolved_direction: null,
        onchain_resolved_direction: null,
      });

      const promise = onWindowResolved(event);
      await vi.advanceTimersByTimeAsync(100);
      await promise;

      expect(mockAll).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('skips when timeline has 0 events', async () => {
      // Return empty arrays for all tick queries
      mockAll.mockResolvedValue([]);
      const event = makeWindowEvent();

      const promise = onWindowResolved(event);
      await vi.advanceTimersByTimeAsync(_testing.SETTLE_DELAY_MS + 100);
      await promise;

      expect(mockRun).not.toHaveBeenCalled();
    });

    it('never throws on persistence error', async () => {
      setupMockTicks();
      mockRun.mockRejectedValue(new Error('PG connection lost'));
      const event = makeWindowEvent();

      // Should not throw
      const promise = onWindowResolved(event);
      await vi.advanceTimersByTimeAsync(_testing.SETTLE_DELAY_MS + 100);
      await expect(promise).resolves.toBeUndefined();
    });

    it('never throws on tick loading error', async () => {
      mockAll.mockRejectedValue(new Error('Query timeout'));
      const event = makeWindowEvent();

      const promise = onWindowResolved(event);
      await vi.advanceTimersByTimeAsync(_testing.SETTLE_DELAY_MS + 100);
      await expect(promise).resolves.toBeUndefined();
    });

    it('uses onchain_resolved_direction when available', async () => {
      setupMockTicks();
      const event = makeWindowEvent({
        resolved_direction: 'up',
        onchain_resolved_direction: 'down',
      });

      const promise = onWindowResolved(event);
      await vi.advanceTimersByTimeAsync(_testing.SETTLE_DELAY_MS + 100);
      await promise;

      const [, params] = mockRun.mock.calls[0];
      expect(params[4]).toBe('down'); // ground_truth should be onchain direction
    });
  });
});
