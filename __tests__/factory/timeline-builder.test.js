/**
 * Tests for Timeline Builder (Stories 1.2, 1.4)
 *
 * Verifies:
 * - mergeTimeline produces correctly shaped events for MarketState
 * - makeWindowId generates deterministic IDs
 * - Event source tagging matches MarketState.processEvent() expectations
 * - Time bounds filtering (events outside window are dropped)
 * - Stale CLOB filtering (mid outside 0.05-0.95 range)
 * - Event sort order (by _ms)
 *
 * Note: Full integration tests (PG → SQLite pipeline) are in Story 1.6.
 * These tests verify the merge/transform logic in isolation.
 */

import { describe, it, expect } from 'vitest';
import { mergeTimeline, makeWindowId } from '../../src/factory/timeline-builder.js';
import { MarketState } from '../../src/backtest/market-state.js';

const OPEN_MS = 1767268800000; // 2026-01-01T12:00:00.000Z
const CLOSE_MS = OPEN_MS + 15 * 60 * 1000; // +15 min

describe('Timeline Builder (Story 1.2)', () => {
  describe('makeWindowId', () => {
    it('generates deterministic window IDs from symbol + close time', () => {
      expect(makeWindowId('btc', '2026-01-01T12:15:00Z')).toBe('btc-2026-01-01T12:15:00Z');
    });

    it('handles Date objects', () => {
      const date = new Date('2026-01-01T12:15:00.000Z');
      expect(makeWindowId('eth', date)).toBe('eth-2026-01-01T12:15:00.000Z');
    });
  });

  describe('mergeTimeline — RTDS ticks', () => {
    it('tags crypto_prices_chainlink topic as source=chainlink', () => {
      const result = mergeTimeline({
        rtdsTicks: [
          { timestamp: new Date(OPEN_MS + 1000), topic: 'crypto_prices_chainlink', price: '50000.12' },
        ],
        clobSnapshots: [],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length).toBe(1);
      expect(result[0].source, 'crypto_prices_chainlink must map to source=chainlink').toBe('chainlink');
      expect(result[0].price, 'Price must be parsed to number').toBe(50000.12);
      expect(typeof result[0]._ms, '_ms must be pre-computed for fast comparison').toBe('number');
    });

    it('tags crypto_prices topic as source=polyRef', () => {
      const result = mergeTimeline({
        rtdsTicks: [
          { timestamp: new Date(OPEN_MS + 2000), topic: 'crypto_prices', price: '50010' },
        ],
        clobSnapshots: [],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result[0].source, 'crypto_prices must map to source=polyRef').toBe('polyRef');
    });
  });

  describe('mergeTimeline — CLOB snapshots', () => {
    it('tags btc-up symbol as source=clobUp with correct fields', () => {
      const result = mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [
          {
            timestamp: new Date(OPEN_MS + 1000),
            symbol: 'btc-up',
            token_id: '0xabc',
            best_bid: '0.48',
            best_ask: '0.50',
            mid_price: '0.49',
            spread: '0.02',
            bid_size_top: '100',
            ask_size_top: '200',
          },
        ],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length).toBe(1);
      const e = result[0];
      expect(e.source, 'btc-up symbol → clobUp source').toBe('clobUp');
      expect(e.best_bid, 'best_bid must be a number').toBe(0.48);
      expect(e.best_ask, 'best_ask must be a number').toBe(0.50);
      expect(e.mid_price, 'mid_price must be a number').toBe(0.49);
      expect(e.spread, 'spread must be a number').toBe(0.02);
      expect(e.bid_size_top, 'bid_size_top must be a number').toBe(100);
      expect(e.ask_size_top, 'ask_size_top must be a number').toBe(200);
    });

    it('tags btc-down symbol as source=clobDown', () => {
      const result = mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [
          {
            timestamp: new Date(OPEN_MS + 1000),
            symbol: 'btc-down',
            best_bid: '0.50',
            best_ask: '0.52',
            mid_price: '0.51',
            spread: '0.02',
          },
        ],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result[0].source, 'btc-down symbol → clobDown source').toBe('clobDown');
    });

    it('filters out stale CLOB data with mid outside tradeable range', () => {
      const result = mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [
          { timestamp: new Date(OPEN_MS + 1000), symbol: 'btc-up', best_bid: '0.01', best_ask: '0.03', mid_price: '0.02', spread: '0.02' },
          { timestamp: new Date(OPEN_MS + 2000), symbol: 'btc-up', best_bid: '0.48', best_ask: '0.50', mid_price: '0.49', spread: '0.02' },
          { timestamp: new Date(OPEN_MS + 3000), symbol: 'btc-up', best_bid: '0.97', best_ask: '0.99', mid_price: '0.98', spread: '0.02' },
        ],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length, 'Stale CLOB with mid < 0.05 or > 0.95 should be filtered out').toBe(1);
      expect(result[0].mid_price).toBe(0.49);
    });
  });

  describe('mergeTimeline — Exchange ticks', () => {
    it('tags exchange ticks as source=exchange_<name>', () => {
      const result = mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [],
        exchangeTicks: [
          { timestamp: new Date(OPEN_MS + 1000), exchange: 'binance', price: '50015', bid: '50014.5', ask: '50015.5' },
          { timestamp: new Date(OPEN_MS + 2000), exchange: 'coinbase', price: '50020', bid: null, ask: null },
        ],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length).toBe(2);
      expect(result[0].source, 'Binance → exchange_binance').toBe('exchange_binance');
      expect(result[1].source, 'Coinbase → exchange_coinbase').toBe('exchange_coinbase');
      expect(result[0].price).toBe(50015);
      expect(result[0].bid).toBe(50014.5);
      expect(result[1].bid, 'Null bid should be preserved').toBeNull();
    });
  });

  describe('mergeTimeline — L2 book ticks', () => {
    it('tags L2 ticks as l2Up/l2Down based on token direction', () => {
      const result = mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [
          { timestamp: new Date(OPEN_MS + 500), symbol: 'btc-up', token_id: 'tok-up', best_bid: '0.48', best_ask: '0.50', mid_price: '0.49', spread: '0.02' },
          { timestamp: new Date(OPEN_MS + 500), symbol: 'btc-down', token_id: 'tok-down', best_bid: '0.50', best_ask: '0.52', mid_price: '0.51', spread: '0.02' },
        ],
        exchangeTicks: [],
        l2BookTicks: [
          { timestamp: new Date(OPEN_MS + 1000), token_id: 'tok-up', symbol: 'btc', best_bid: '0.47', best_ask: '0.51', mid_price: '0.49', spread: '0.04', bid_depth_1pct: '500', ask_depth_1pct: '600' },
          { timestamp: new Date(OPEN_MS + 1500), token_id: 'tok-down', symbol: 'btc', best_bid: '0.49', best_ask: '0.53', mid_price: '0.51', spread: '0.04', bid_depth_1pct: '400', ask_depth_1pct: '500' },
        ],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      const l2Events = result.filter(e => e.source.startsWith('l2'));
      expect(l2Events.length).toBe(2);
      expect(l2Events[0].source, 'tok-up → l2Up').toBe('l2Up');
      expect(l2Events[1].source, 'tok-down → l2Down').toBe('l2Down');
      expect(l2Events[0].bid_depth_1pct, 'bid_depth_1pct must be a number').toBe(500);
    });
  });

  describe('mergeTimeline — CoinGecko ticks', () => {
    it('tags CoinGecko ticks as source=coingecko', () => {
      const result = mergeTimeline({
        rtdsTicks: [],
        clobSnapshots: [],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [
          { timestamp: new Date(OPEN_MS + 1000), price: '50012' },
        ],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length).toBe(1);
      expect(result[0].source).toBe('coingecko');
      expect(result[0].price).toBe(50012);
    });
  });

  describe('mergeTimeline — sorting and bounds', () => {
    it('sorts events by _ms (timestamp)', () => {
      const result = mergeTimeline({
        rtdsTicks: [
          { timestamp: new Date(OPEN_MS + 3000), topic: 'crypto_prices_chainlink', price: '50030' },
        ],
        clobSnapshots: [
          { timestamp: new Date(OPEN_MS + 1000), symbol: 'btc-up', best_bid: '0.48', best_ask: '0.50', mid_price: '0.49', spread: '0.02' },
        ],
        exchangeTicks: [
          { timestamp: new Date(OPEN_MS + 2000), exchange: 'binance', price: '50015', bid: null, ask: null },
        ],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length).toBe(3);
      expect(result[0]._ms < result[1]._ms, 'Events must be sorted by time').toBe(true);
      expect(result[1]._ms < result[2]._ms, 'Events must be sorted by time').toBe(true);
    });

    it('drops events outside [openMs, closeMs) window', () => {
      const result = mergeTimeline({
        rtdsTicks: [
          { timestamp: new Date(OPEN_MS - 1000), topic: 'crypto_prices_chainlink', price: '50000' }, // Before open
          { timestamp: new Date(OPEN_MS + 1000), topic: 'crypto_prices_chainlink', price: '50010' }, // Valid
          { timestamp: new Date(CLOSE_MS), topic: 'crypto_prices_chainlink', price: '50020' },       // At close (excluded)
          { timestamp: new Date(CLOSE_MS + 1000), topic: 'crypto_prices_chainlink', price: '50030' }, // After close
        ],
        clobSnapshots: [],
        exchangeTicks: [],
        l2BookTicks: [],
        coingeckoTicks: [],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      expect(result.length, 'Only events within [openMs, closeMs) should be included').toBe(1);
      expect(result[0].price).toBe(50010);
    });
  });

  describe('MarketState compatibility', () => {
    it('merged events are processable by MarketState.processEvent()', () => {
      const timeline = mergeTimeline({
        rtdsTicks: [
          { timestamp: new Date(OPEN_MS + 1000), topic: 'crypto_prices_chainlink', price: '50000' },
          { timestamp: new Date(OPEN_MS + 2000), topic: 'crypto_prices', price: '50010' },
        ],
        clobSnapshots: [
          { timestamp: new Date(OPEN_MS + 3000), symbol: 'btc-up', best_bid: '0.48', best_ask: '0.50', mid_price: '0.49', spread: '0.02', bid_size_top: '100', ask_size_top: '200' },
          { timestamp: new Date(OPEN_MS + 3500), symbol: 'btc-down', best_bid: '0.50', best_ask: '0.52', mid_price: '0.51', spread: '0.02', bid_size_top: '150', ask_size_top: '250' },
        ],
        exchangeTicks: [
          { timestamp: new Date(OPEN_MS + 4000), exchange: 'binance', price: '50015', bid: '50014.5', ask: '50015.5' },
        ],
        l2BookTicks: [],
        coingeckoTicks: [
          { timestamp: new Date(OPEN_MS + 5000), price: '50012' },
        ],
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
      });

      // Replay through MarketState — if event shapes are wrong, this will fail
      const state = new MarketState();

      expect(() => {
        for (const event of timeline) {
          state.processEvent(event);
        }
      }, 'MarketState.processEvent() must accept all merged events without error').not.toThrow();

      // Verify state was updated correctly
      expect(state.chainlink.price, 'Chainlink price should be set after processing chainlink event').toBe(50000);
      expect(state.polyRef.price, 'PolyRef price should be set after processing polyRef event').toBe(50010);
      expect(state.clobUp.bestBid, 'ClobUp bestBid should be set after processing clobUp event').toBe(0.48);
      expect(state.clobDown.bestBid, 'ClobDown bestBid should be set after processing clobDown event').toBe(0.50);
      expect(state.getExchange('binance').price, 'Binance price should be set after processing exchange event').toBe(50015);
      expect(state.coingecko.price, 'CoinGecko price should be set after processing coingecko event').toBe(50012);
    });
  });
});
