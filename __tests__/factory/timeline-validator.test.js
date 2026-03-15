/**
 * Tests for Timeline Data Validator (Story 1.3)
 *
 * Verifies:
 * - Minimum event count flagging (< 10 events)
 * - Flat chainlink price detection (> 60s unchanged)
 * - L2 gap detection (> 30s without L2 data)
 * - Out-of-bounds event detection
 * - Quality metadata structure
 *
 * Domain context: These validations catch known data anomalies that cause
 * backtester results to be unreliable. A flat chainlink price means the
 * oracle feed stalled — strategies that depend on CL movement will get
 * false signals. L2 gaps mean orderbook depth data is unreliable.
 */

import { describe, it, expect } from 'vitest';
import {
  validateWindow,
  detectFlatPrices,
  detectL2Gaps,
  countOutOfBounds,
  hasFlags,
  getFlagTypes,
} from '../../src/factory/timeline-validator.js';

// Helper: create a timeline with N events spread across a window
function makeTimeline(count, openMs, closeMs) {
  const step = (closeMs - openMs) / count;
  return Array.from({ length: count }, (_, i) => ({
    source: 'exchange_binance',
    timestamp: new Date(openMs + i * step).toISOString(),
    price: 50000 + i,
    _ms: openMs + i * step,
  }));
}

const OPEN_MS = 1767268800000; // 2026-01-01T12:00:00Z
const CLOSE_MS = OPEN_MS + 15 * 60 * 1000; // +15 min

describe('Timeline Validator (Story 1.3)', () => {
  describe('validateWindow — quality metadata', () => {
    it('returns correct source counts', () => {
      const timeline = makeTimeline(20, OPEN_MS, CLOSE_MS);
      const quality = validateWindow({
        timeline,
        rtdsCount: 5,
        clobCount: 8,
        exchangeCount: 7,
        l2Count: 0,
        coingeckoCount: 3,
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
        symbol: 'btc',
      });

      expect(quality.rtds_count, 'rtds_count should match input').toBe(5);
      expect(quality.clob_count, 'clob_count should match input').toBe(8);
      expect(quality.exchange_count, 'exchange_count should match input').toBe(7);
      expect(quality.l2_count, 'l2_count should match input').toBe(0);
      expect(quality.coingecko_count, 'coingecko_count should match input').toBe(3);
      expect(quality.event_count, 'event_count should be timeline.length').toBe(20);
      expect(Array.isArray(quality.flags), 'flags must be an array').toBe(true);
    });

    it('no flags for a healthy window', () => {
      const timeline = makeTimeline(50, OPEN_MS, CLOSE_MS);
      const quality = validateWindow({
        timeline,
        rtdsCount: 10,
        clobCount: 20,
        exchangeCount: 20,
        l2Count: 0,
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
        symbol: 'btc',
      });

      expect(quality.flags.length, 'Healthy window should have no flags').toBe(0);
      expect(hasFlags(quality)).toBe(false);
    });
  });

  describe('Minimum event count check', () => {
    it('flags windows with fewer than 10 events as incomplete', () => {
      const timeline = makeTimeline(5, OPEN_MS, CLOSE_MS);
      const quality = validateWindow({
        timeline,
        rtdsCount: 2,
        clobCount: 2,
        exchangeCount: 1,
        l2Count: 0,
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
        symbol: 'btc',
      });

      expect(hasFlags(quality), 'Window with 5 events must be flagged').toBe(true);
      expect(getFlagTypes(quality), 'Flag type must be "incomplete"').toContain('incomplete');
    });

    it('does not flag windows with exactly 10 events', () => {
      const timeline = makeTimeline(10, OPEN_MS, CLOSE_MS);
      const quality = validateWindow({
        timeline,
        rtdsCount: 3,
        clobCount: 4,
        exchangeCount: 3,
        l2Count: 0,
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
        symbol: 'btc',
      });

      expect(getFlagTypes(quality), '10 events is exactly the minimum — should not flag').not.toContain('incomplete');
    });
  });

  describe('Flat chainlink price detection', () => {
    it('detects chainlink price unchanged for > 60 seconds', () => {
      const timeline = [
        { source: 'chainlink', price: 50000, _ms: OPEN_MS, timestamp: '' },
        { source: 'chainlink', price: 50000, _ms: OPEN_MS + 70000, timestamp: '' }, // 70s later, same price
        { source: 'chainlink', price: 50010, _ms: OPEN_MS + 80000, timestamp: '' }, // price changes at 80s
      ];

      const gaps = detectFlatPrices(timeline, 'chainlink', 60000);
      expect(gaps.length, 'Should detect 1 flat price gap > 60s').toBe(1);
      // Gap runs from first CL event (t=0) to the price change at t=80s = 80000ms
      expect(gaps[0].durationMs, 'Gap duration should be 80000ms (from first event to price change)').toBe(80000);
    });

    it('does not flag price changes within 60 seconds', () => {
      const timeline = [
        { source: 'chainlink', price: 50000, _ms: OPEN_MS, timestamp: '' },
        { source: 'chainlink', price: 50010, _ms: OPEN_MS + 30000, timestamp: '' }, // 30s, price changed
        { source: 'chainlink', price: 50020, _ms: OPEN_MS + 55000, timestamp: '' }, // 25s, price changed
      ];

      const gaps = detectFlatPrices(timeline, 'chainlink', 60000);
      expect(gaps.length, 'No flat price gaps should be detected when CL updates every 30s').toBe(0);
    });

    it('ignores events from other sources', () => {
      const timeline = [
        { source: 'chainlink', price: 50000, _ms: OPEN_MS, timestamp: '' },
        { source: 'exchange_binance', price: 50100, _ms: OPEN_MS + 40000, timestamp: '' }, // binance, irrelevant
        { source: 'chainlink', price: 50010, _ms: OPEN_MS + 50000, timestamp: '' }, // CL changed within 50s
      ];

      const gaps = detectFlatPrices(timeline, 'chainlink', 60000);
      expect(gaps.length, 'Exchange events should not affect CL flat detection').toBe(0);
    });

    it('is included in validateWindow output', () => {
      const timeline = [
        { source: 'chainlink', price: 50000, _ms: OPEN_MS, timestamp: '' },
        { source: 'chainlink', price: 50000, _ms: OPEN_MS + 120000, timestamp: '' }, // 120s flat
        { source: 'chainlink', price: 50010, _ms: OPEN_MS + 130000, timestamp: '' }, // price changes here, closing the gap
        ...makeTimeline(20, OPEN_MS, CLOSE_MS),
      ];

      const quality = validateWindow({
        timeline,
        rtdsCount: 2,
        clobCount: 10,
        exchangeCount: 10,
        l2Count: 0,
        openMs: OPEN_MS,
        closeMs: CLOSE_MS,
        symbol: 'btc',
      });

      expect(getFlagTypes(quality)).toContain('flat_prices');
    });
  });

  describe('L2 gap detection', () => {
    it('detects L2 data missing for > 30 seconds', () => {
      const timeline = [
        { source: 'l2Up', _ms: OPEN_MS, timestamp: '', best_bid: 0.48, best_ask: 0.50 },
        { source: 'exchange_binance', _ms: OPEN_MS + 20000, timestamp: '', price: 50000 },
        { source: 'l2Up', _ms: OPEN_MS + 50000, timestamp: '', best_bid: 0.48, best_ask: 0.50 }, // 50s gap
      ];

      const gaps = detectL2Gaps(timeline, 30000);
      expect(gaps.length, 'Should detect 1 L2 gap > 30s').toBe(1);
      expect(gaps[0].durationMs, 'Gap should be 50000ms').toBe(50000);
    });

    it('does not flag when L2 data is not present at all', () => {
      const timeline = [
        { source: 'chainlink', _ms: OPEN_MS, timestamp: '', price: 50000 },
        { source: 'exchange_binance', _ms: OPEN_MS + 60000, timestamp: '', price: 50010 },
      ];

      const gaps = detectL2Gaps(timeline, 30000);
      expect(gaps.length, 'No L2 data at all should not be flagged — not all symbols have L2').toBe(0);
    });

    it('counts both l2Up and l2Down events', () => {
      const timeline = [
        { source: 'l2Up', _ms: OPEN_MS, timestamp: '' },
        { source: 'l2Down', _ms: OPEN_MS + 5000, timestamp: '' }, // 5s gap
        { source: 'l2Up', _ms: OPEN_MS + 10000, timestamp: '' }, // 5s gap
      ];

      const gaps = detectL2Gaps(timeline, 30000);
      expect(gaps.length, 'Small L2 gaps should not be flagged').toBe(0);
    });
  });

  describe('Out-of-bounds detection', () => {
    it('counts events outside [openMs, closeMs)', () => {
      const timeline = [
        { _ms: OPEN_MS - 1000 }, // Before open
        { _ms: OPEN_MS },        // At open (valid)
        { _ms: CLOSE_MS },       // At close (invalid — half-open interval)
        { _ms: CLOSE_MS + 1000 }, // After close
      ];

      const count = countOutOfBounds(timeline, OPEN_MS, CLOSE_MS);
      expect(count, 'Events before open and at/after close should be counted as OOB').toBe(3);
    });
  });

  describe('Flag utilities', () => {
    it('hasFlags returns true when flags exist', () => {
      expect(hasFlags({ flags: [{ type: 'incomplete' }] })).toBe(true);
      expect(hasFlags({ flags: [] })).toBe(false);
      expect(hasFlags(null)).toBe(false);
    });

    it('getFlagTypes extracts flag type strings', () => {
      const quality = { flags: [{ type: 'incomplete' }, { type: 'flat_prices' }] };
      expect(getFlagTypes(quality)).toEqual(['incomplete', 'flat_prices']);
    });
  });
});
