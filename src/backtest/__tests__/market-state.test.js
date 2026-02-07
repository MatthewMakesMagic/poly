/**
 * Tests for market state (3-tier feed model)
 */

import { describe, it, expect } from 'vitest';
import { MarketState, createMarketState } from '../market-state.js';

describe('MarketState', () => {
  describe('processEvent', () => {
    it('processes chainlink events', () => {
      const state = createMarketState();
      state.processEvent({
        timestamp: '2026-01-25T12:00:00Z',
        source: 'chainlink',
        price: 50020,
      });

      expect(state.chainlink).toEqual({ price: 50020, ts: '2026-01-25T12:00:00Z' });
      expect(state.timestamp).toBe('2026-01-25T12:00:00Z');
    });

    it('processes polyRef events', () => {
      const state = createMarketState();
      state.processEvent({
        timestamp: '2026-01-25T12:00:00Z',
        source: 'polyRef',
        price: 50100,
      });

      expect(state.polyRef).toEqual({ price: 50100, ts: '2026-01-25T12:00:00Z' });
    });

    it('processes clobUp events', () => {
      const state = createMarketState();
      state.processEvent({
        timestamp: '2026-01-25T12:00:00Z',
        source: 'clobUp',
        best_bid: 0.48,
        best_ask: 0.50,
        mid_price: 0.49,
        spread: 0.02,
        bid_size_top: 100,
        ask_size_top: 200,
      });

      expect(state.clobUp.bestBid).toBe(0.48);
      expect(state.clobUp.bestAsk).toBe(0.50);
      expect(state.clobUp.mid).toBe(0.49);
      expect(state.clobUp.bidSize).toBe(100);
      expect(state.clobUp.askSize).toBe(200);
    });

    it('processes clobDown events', () => {
      const state = createMarketState();
      state.processEvent({
        timestamp: '2026-01-25T12:00:00Z',
        source: 'clobDown',
        best_bid: 0.50,
        best_ask: 0.52,
        mid_price: 0.51,
        spread: 0.02,
      });

      expect(state.clobDown.bestBid).toBe(0.50);
      expect(state.clobDown.bestAsk).toBe(0.52);
    });

    it('processes exchange events', () => {
      const state = createMarketState();
      state.processEvent({
        timestamp: '2026-01-25T12:00:00Z',
        source: 'exchange_binance',
        price: 50100,
        bid: 50095,
        ask: 50105,
      });

      const binance = state.getExchange('binance');
      expect(binance).toEqual({
        price: 50100,
        bid: 50095,
        ask: 50105,
        ts: '2026-01-25T12:00:00Z',
      });
    });

    it('tracks multiple exchanges', () => {
      const state = createMarketState();

      state.processEvent({ timestamp: 't1', source: 'exchange_binance', price: 50100 });
      state.processEvent({ timestamp: 't2', source: 'exchange_coinbase', price: 50050 });
      state.processEvent({ timestamp: 't3', source: 'exchange_kraken', price: 50080 });

      const all = state.getAllExchanges();
      expect(all).toHaveLength(3);
      expect(all.map(e => e.exchange).sort()).toEqual(['binance', 'coinbase', 'kraken']);
    });
  });

  describe('setWindow', () => {
    it('sets window context and strike', () => {
      const state = createMarketState();
      state.setWindow({
        window_close_time: '2026-01-25T12:30:00Z',
        symbol: 'BTC',
        strike_price: 50100,
        resolved_direction: 'DOWN',
      }, '2026-01-25T12:25:00Z');

      expect(state.strike).toBe(50100);
      expect(state.window.closeTime).toBe('2026-01-25T12:30:00Z');
      expect(state.window.openTime).toBe('2026-01-25T12:25:00Z');
      expect(state.window.symbol).toBe('BTC');
      expect(state.window.resolvedDirection).toBe('DOWN');
    });
  });

  describe('updateTimeToClose', () => {
    it('calculates time remaining', () => {
      const state = createMarketState();
      state.setWindow({
        window_close_time: '2026-01-25T12:30:00Z',
        symbol: 'BTC',
        strike_price: 50100,
      });

      state.updateTimeToClose('2026-01-25T12:28:00Z');
      expect(state.window.timeToCloseMs).toBe(120000); // 2 minutes

      state.updateTimeToClose('2026-01-25T12:30:00Z');
      expect(state.window.timeToCloseMs).toBe(0);
    });
  });

  describe('getExchangeMedian', () => {
    it('returns null with no exchanges', () => {
      const state = createMarketState();
      expect(state.getExchangeMedian()).toBeNull();
    });

    it('returns median for odd count', () => {
      const state = createMarketState();
      state.processEvent({ timestamp: 't1', source: 'exchange_a', price: 100 });
      state.processEvent({ timestamp: 't2', source: 'exchange_b', price: 200 });
      state.processEvent({ timestamp: 't3', source: 'exchange_c', price: 150 });

      expect(state.getExchangeMedian()).toBe(150);
    });

    it('returns average of middle two for even count', () => {
      const state = createMarketState();
      state.processEvent({ timestamp: 't1', source: 'exchange_a', price: 100 });
      state.processEvent({ timestamp: 't2', source: 'exchange_b', price: 200 });

      expect(state.getExchangeMedian()).toBe(150);
    });
  });

  describe('getExchangeSpread', () => {
    it('returns null with fewer than 2 exchanges', () => {
      const state = createMarketState();
      state.processEvent({ timestamp: 't1', source: 'exchange_a', price: 100 });
      expect(state.getExchangeSpread()).toBeNull();
    });

    it('returns spread metrics', () => {
      const state = createMarketState();
      state.processEvent({ timestamp: 't1', source: 'exchange_a', price: 50000 });
      state.processEvent({ timestamp: 't2', source: 'exchange_b', price: 50100 });

      const spread = state.getExchangeSpread();
      expect(spread.min).toBe(50000);
      expect(spread.max).toBe(50100);
      expect(spread.range).toBe(100);
      expect(spread.rangePct).toBeCloseTo(100 / 50000);
    });
  });

  describe('getChainlinkDeficit', () => {
    it('returns null without data', () => {
      const state = createMarketState();
      expect(state.getChainlinkDeficit()).toBeNull();
    });

    it('returns positive deficit (DOWN bias)', () => {
      const state = createMarketState();
      state.strike = 50100;
      state.processEvent({ timestamp: 't1', source: 'chainlink', price: 50020 });

      expect(state.getChainlinkDeficit()).toBe(80); // 50100 - 50020
    });
  });

  describe('getRefToStrikeGap', () => {
    it('returns gap', () => {
      const state = createMarketState();
      state.strike = 50100;
      state.processEvent({ timestamp: 't1', source: 'polyRef', price: 50090 });

      expect(state.getRefToStrikeGap()).toBe(10);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const state = createMarketState();
      state.processEvent({ timestamp: 't1', source: 'chainlink', price: 50000 });
      state.processEvent({ timestamp: 't2', source: 'exchange_binance', price: 50100 });
      state.strike = 50100;

      state.reset();

      expect(state.chainlink).toBeNull();
      expect(state.strike).toBeNull();
      expect(state.polyRef).toBeNull();
      expect(state.getExchange('binance')).toBeNull();
      expect(state.getTickCount()).toBe(0);
    });
  });
});
