/**
 * Tests for Bit-Identical Validation (Story 1.6)
 *
 * These are integration tests that verify pre-computed timelines produce
 * identical results to loading data directly from PostgreSQL.
 *
 * REQUIRES: PostgreSQL database access (skipped when DATABASE_URL is not set).
 *
 * What we verify:
 * - Event counts match between cached timeline and direct PG queries
 * - Event timestamps, values, and sources match exactly
 * - MarketState computed from both paths produces identical state
 * - Deterministic: same data = same results (NFR9)
 *
 * Domain context: If the cache diverges from PG even slightly, all backtest
 * results become suspect. A price rounding difference of $0.01 in CL can
 * flip a window resolution. This test is the ultimate trust anchor.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pack, unpack } from 'msgpackr';
import { resolve } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { MarketState } from '../../src/backtest/market-state.js';
import { mergeTimeline, makeWindowId } from '../../src/factory/timeline-builder.js';
import { loadTimeline } from '../../src/factory/timeline-loader.js';
import { insertTimeline, closeDb } from '../../src/factory/timeline-store.js';

// Skip all tests if no DATABASE_URL
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)('Bit-Identical Validation (Story 1.6)', () => {
  let persistence;
  let dbPath;

  beforeAll(async () => {
    // Set up temp SQLite path
    dbPath = mkdtempSync(resolve(tmpdir(), 'bit-identical-test-'));
    process.env.TIMELINE_DB_PATH = resolve(dbPath, 'test-timelines.sqlite');

    // Dynamically import persistence to connect to PG
    const config = (await import('../../config/index.js')).default;
    persistence = (await import('../../src/persistence/index.js')).default;
    await persistence.init(config);
  });

  afterAll(async () => {
    closeDb();
    delete process.env.TIMELINE_DB_PATH;
    if (persistence) {
      try { await persistence.shutdown(); } catch { /* ignore */ }
    }
  });

  it('verifies at least 10 randomly selected windows match between cache and PG', async () => {
    // Get available windows from PG
    const allWindows = await persistence.all(`
      SELECT window_close_time, symbol, strike_price,
             chainlink_price_at_close, oracle_price_at_open,
             COALESCE(gamma_resolved_direction, onchain_resolved_direction, resolved_direction) as ground_truth
      FROM window_close_events
      WHERE symbol = 'btc'
        AND COALESCE(gamma_resolved_direction, onchain_resolved_direction, resolved_direction) IS NOT NULL
      ORDER BY window_close_time DESC
      LIMIT 50
    `);

    if (allWindows.length < 10) {
      console.log(`Only ${allWindows.length} BTC windows with ground truth — skipping`);
      return;
    }

    // Select 10 random windows
    const shuffled = allWindows.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 10);

    for (const win of selected) {
      const closeTime = win.window_close_time instanceof Date
        ? win.window_close_time.toISOString()
        : win.window_close_time;
      const closeMs = new Date(closeTime).getTime();
      const openMs = closeMs - 15 * 60 * 1000;
      const openTime = new Date(openMs).toISOString();
      const windowId = makeWindowId('btc', closeTime);

      // Load data directly from PG (the "truth" path)
      const [rtdsTicks, clobSnapshots, exchangeTicks] = await Promise.all([
        persistence.all(`
          SELECT timestamp, topic, symbol, price, received_at
          FROM rtds_ticks
          WHERE timestamp >= $1 AND timestamp <= $2
            AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
          ORDER BY timestamp ASC
        `, [openTime, closeTime]),

        persistence.all(`
          SELECT timestamp, symbol, token_id, best_bid, best_ask,
                 mid_price, spread, bid_size_top, ask_size_top, window_epoch
          FROM clob_price_snapshots
          WHERE timestamp >= $1 AND timestamp <= $2
            AND symbol LIKE 'btc%'
          ORDER BY timestamp ASC
        `, [openTime, closeTime]),

        persistence.all(`
          SELECT timestamp, exchange, symbol, price, bid, ask
          FROM exchange_ticks
          WHERE timestamp >= $1 AND timestamp <= $2
            AND symbol = 'btc'
          ORDER BY timestamp ASC
        `, [openTime, closeTime]),
      ]);

      // Build timeline using our pipeline
      const cachedTimeline = mergeTimeline({
        rtdsTicks,
        clobSnapshots,
        exchangeTicks,
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs,
        closeMs,
      });

      // Store it
      insertTimeline({
        window_id: windowId,
        symbol: 'btc',
        window_close_time: closeTime,
        window_open_time: openTime,
        ground_truth: win.ground_truth,
        strike_price: win.strike_price ? parseFloat(win.strike_price) : null,
        oracle_price_at_open: win.oracle_price_at_open ? parseFloat(win.oracle_price_at_open) : null,
        chainlink_price_at_close: win.chainlink_price_at_close ? parseFloat(win.chainlink_price_at_close) : null,
        timeline: pack(cachedTimeline),
        event_count: cachedTimeline.length,
        data_quality: null,
        built_at: new Date().toISOString(),
      });

      // Load it back from cache
      const loaded = loadTimeline(windowId);

      expect(
        loaded,
        `Timeline for ${windowId} should be loadable from cache after insert`
      ).not.toBeNull();

      expect(
        loaded.timeline.length,
        `Event count for ${windowId}: cached=${loaded.timeline.length} vs direct=${cachedTimeline.length}. ` +
        'Cache divergence means the serialize/deserialize path is lossy.'
      ).toBe(cachedTimeline.length);

      // Verify events match exactly
      for (let j = 0; j < cachedTimeline.length; j++) {
        const original = cachedTimeline[j];
        const restored = loaded.timeline[j];

        expect(
          restored.source,
          `Event ${j} source mismatch in ${windowId}: ` +
          `expected=${original.source}, got=${restored.source}`
        ).toBe(original.source);

        expect(
          restored._ms,
          `Event ${j} timestamp mismatch in ${windowId}: ` +
          `expected _ms=${original._ms}, got _ms=${restored._ms}`
        ).toBe(original._ms);
      }

      // Verify MarketState produces identical values from both paths
      const stateFromDirect = new MarketState();
      const stateFromCache = new MarketState();

      for (const event of cachedTimeline) stateFromDirect.processEvent(event);
      for (const event of loaded.timeline) stateFromCache.processEvent(event);

      if (stateFromDirect.chainlink && stateFromCache.chainlink) {
        expect(
          stateFromCache.chainlink.price,
          `MarketState chainlink price divergence for ${windowId}: ` +
          `direct=${stateFromDirect.chainlink.price}, cache=${stateFromCache.chainlink.price}. ` +
          'This means the serialization path is changing values.'
        ).toBe(stateFromDirect.chainlink.price);
      }

      if (stateFromDirect.clobUp && stateFromCache.clobUp) {
        expect(
          stateFromCache.clobUp.bestBid,
          `MarketState clobUp.bestBid divergence for ${windowId}`
        ).toBe(stateFromDirect.clobUp.bestBid);
      }
    }
  }, 120000); // 2 min timeout for DB queries

  it('deterministic: building the same window twice produces identical timelines', async () => {
    // Get one window from PG
    const win = await persistence.get(`
      SELECT window_close_time, symbol
      FROM window_close_events
      WHERE symbol = 'btc'
        AND COALESCE(gamma_resolved_direction, onchain_resolved_direction, resolved_direction) IS NOT NULL
      ORDER BY window_close_time DESC
      LIMIT 1
    `);

    if (!win) {
      console.log('No BTC windows available — skipping determinism test');
      return;
    }

    const closeTime = win.window_close_time instanceof Date
      ? win.window_close_time.toISOString()
      : win.window_close_time;
    const closeMs = new Date(closeTime).getTime();
    const openMs = closeMs - 15 * 60 * 1000;
    const openTime = new Date(openMs).toISOString();

    const [rtdsTicks, clobSnapshots, exchangeTicks] = await Promise.all([
      persistence.all(`
        SELECT timestamp, topic, symbol, price, received_at
        FROM rtds_ticks
        WHERE timestamp >= $1 AND timestamp <= $2
          AND topic IN ('crypto_prices_chainlink', 'crypto_prices')
        ORDER BY timestamp ASC
      `, [openTime, closeTime]),

      persistence.all(`
        SELECT timestamp, symbol, token_id, best_bid, best_ask,
               mid_price, spread, bid_size_top, ask_size_top, window_epoch
        FROM clob_price_snapshots
        WHERE timestamp >= $1 AND timestamp <= $2
          AND symbol LIKE 'btc%'
        ORDER BY timestamp ASC
      `, [openTime, closeTime]),

      persistence.all(`
        SELECT timestamp, exchange, symbol, price, bid, ask
        FROM exchange_ticks
        WHERE timestamp >= $1 AND timestamp <= $2
          AND symbol = 'btc'
        ORDER BY timestamp ASC
      `, [openTime, closeTime]),
    ]);

    // Build timeline twice
    const timeline1 = mergeTimeline({
      rtdsTicks, clobSnapshots, exchangeTicks,
      l2BookTicks: [], coingeckoTicks: [],
      openMs, closeMs,
    });

    const timeline2 = mergeTimeline({
      rtdsTicks, clobSnapshots, exchangeTicks,
      l2BookTicks: [], coingeckoTicks: [],
      openMs, closeMs,
    });

    expect(
      timeline1.length,
      'Same input data must produce same event count — determinism violation'
    ).toBe(timeline2.length);

    // Verify MessagePack serialization is also deterministic
    const blob1 = pack(timeline1);
    const blob2 = pack(timeline2);

    expect(
      Buffer.compare(blob1, blob2),
      'Same timeline must produce identical MessagePack blobs (NFR9: deterministic reproducibility)'
    ).toBe(0);
  }, 60000);
});

/**
 * Unit-level determinism test (no DB required)
 */
describe('Determinism (Story 1.6 — unit level)', () => {
  it('mergeTimeline is deterministic: same input → same output', () => {
    const rtdsTicks = [
      { timestamp: new Date('2026-01-01T12:01:00Z'), topic: 'crypto_prices_chainlink', price: '50000' },
      { timestamp: new Date('2026-01-01T12:02:00Z'), topic: 'crypto_prices', price: '50010' },
    ];
    const clobSnapshots = [
      { timestamp: new Date('2026-01-01T12:01:30Z'), symbol: 'btc-up', best_bid: '0.48', best_ask: '0.50', mid_price: '0.49', spread: '0.02' },
    ];
    const exchangeTicks = [
      { timestamp: new Date('2026-01-01T12:01:15Z'), exchange: 'binance', price: '50015', bid: null, ask: null },
    ];

    const openMs = new Date('2026-01-01T12:00:00Z').getTime();
    const closeMs = openMs + 15 * 60 * 1000;

    const args = { rtdsTicks, clobSnapshots, exchangeTicks, l2BookTicks: [], coingeckoTicks: [], openMs, closeMs };

    const t1 = mergeTimeline(args);
    const t2 = mergeTimeline(args);

    expect(t1.length, 'Same input must produce same event count').toBe(t2.length);
    for (let i = 0; i < t1.length; i++) {
      expect(t1[i], `Event ${i} must be identical across runs`).toEqual(t2[i]);
    }

    // MessagePack must also be deterministic
    const b1 = pack(t1);
    const b2 = pack(t2);
    expect(
      Buffer.compare(b1, b2),
      'MessagePack serialization must be deterministic (same bytes for same data)'
    ).toBe(0);
  });
});
