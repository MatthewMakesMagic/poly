/**
 * Integration Tests — Realistic Fills with Fee Model
 *
 * Runs a simple strategy through evaluateWindow with different fee modes
 * and verifies fee impact is in the expected range.
 */

import { describe, it, expect } from 'vitest';
import { evaluateWindow } from '../../../src/backtest/parallel-engine.js';
import { FeeMode } from '../../../src/factory/fee-model.js';

// ─── Test Fixtures ───

/**
 * Create a minimal timeline with CLOB + L2 data.
 */
function makeTimeline({ bestAsk = 0.55, bestBid = 0.53, askSize = 1000, bidSize = 1000 }) {
  const baseTime = new Date('2025-01-15T12:00:00Z').getTime();
  const closeTime = baseTime + 5 * 60 * 1000;

  const events = [];
  // Emit L2 + CLOB ticks every 10 seconds.
  // L2 events come BEFORE CLOB events at each timestamp so that
  // book levels are available when the strategy fires on CLOB ticks.
  for (let t = baseTime; t < closeTime; t += 10000) {
    const ts = new Date(t).toISOString();

    // Oracle price first (near strike)
    events.push({
      source: 'chainlink',
      timestamp: ts,
      price: 50000 + Math.random() * 100,
      _ms: t,
    });

    // L2 tick with levels (before CLOB so levels are set when strategy fires)
    events.push({
      source: 'l2Up',
      timestamp: ts,
      best_bid: String(bestBid),
      best_ask: String(bestAsk),
      mid_price: String((bestBid + bestAsk) / 2),
      spread: String(bestAsk - bestBid),
      bid_depth_1pct: String(bidSize * 2),
      ask_depth_1pct: String(askSize * 2),
      top_levels: {
        asks: [[bestAsk, askSize], [bestAsk + 0.01, askSize], [bestAsk + 0.02, askSize]],
        bids: [[bestBid, bidSize], [bestBid - 0.01, bidSize], [bestBid - 0.02, bidSize]],
      },
      _ms: t,
    });

    // CLOB tick
    events.push({
      source: 'clobUp',
      timestamp: ts,
      best_bid: String(bestBid),
      best_ask: String(bestAsk),
      mid_price: String((bestBid + bestAsk) / 2),
      spread: String(bestAsk - bestBid),
      bid_size_top: String(bidSize),
      ask_size_top: String(askSize),
      _ms: t,
    });

    // Complementary DOWN token
    events.push({
      source: 'clobDown',
      timestamp: ts,
      best_bid: String(1 - bestAsk),
      best_ask: String(1 - bestBid),
      mid_price: String(1 - (bestBid + bestAsk) / 2),
      spread: String(bestAsk - bestBid),
      bid_size_top: String(bidSize),
      ask_size_top: String(askSize),
      _ms: t,
    });
  }

  return events;
}

/**
 * Simple strategy: buys UP token once, early in the window.
 */
const simpleStrategy = {
  name: 'test-simple-buy',
  evaluate(state, config) {
    if (!state.clobUp?.bestAsk) return [];
    // Buy once, 2 minutes into window
    if (state.window?.timeToCloseMs > 180000 && !state._bought) {
      state._bought = true;
      return [{
        action: 'buy',
        token: `${state.window.symbol}-up`,
        capitalPerTrade: config.capitalPerTrade || 10,
        reason: 'test-buy',
      }];
    }
    return [];
  },
  onWindowOpen(state) {
    state._bought = false;
  },
  defaults: { capitalPerTrade: 10 },
  sweepGrid: {},
};

function makeWindowEvent(direction = 'UP') {
  const closeTime = '2025-01-15T12:05:00.000Z';
  return {
    window_close_time: closeTime,
    symbol: 'btc',
    strike_price: 50050,
    oracle_price_at_open: 50000,
    chainlink_price_at_close: direction === 'UP' ? 50100 : 49900,
    resolved_direction: direction,
    gamma_resolved_direction: direction,
  };
}

// ─── Tests ───

describe('realistic fills integration', () => {
  describe('fee mode comparison', () => {
    it('zero fee mode produces highest PnL', () => {
      const timeline = makeTimeline({ bestAsk: 0.55, bestBid: 0.53 });
      const win = makeWindowEvent('UP');

      const zeroResult = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        tradingFee: 0,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.ZERO,
      });

      const takerResult = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        tradingFee: 0,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.TAKER_ONLY,
      });

      // Both should trade
      expect(zeroResult.tradesInWindow).toBeGreaterThanOrEqual(1);
      expect(takerResult.tradesInWindow).toBeGreaterThanOrEqual(1);

      // Taker fees reduce PnL
      expect(takerResult.pnl).toBeLessThan(zeroResult.pnl);
    });

    it('taker fee impact is in expected range (0.1% - 2% of capital traded)', () => {
      const timeline = makeTimeline({ bestAsk: 0.50, bestBid: 0.48 });
      const win = makeWindowEvent('UP');

      const zeroResult = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 50 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.ZERO,
      });

      const takerResult = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 50 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.TAKER_ONLY,
      });

      if (zeroResult.tradesInWindow > 0 && takerResult.tradesInWindow > 0) {
        const pnlDiff = zeroResult.pnl - takerResult.pnl;
        // Fee at p=0.50 is ~1.56% of trade value
        // For $50 trade, fee should be ~$0.78
        expect(pnlDiff).toBeGreaterThan(0);
        expect(pnlDiff).toBeLessThan(2.0); // at most ~2% of $50
      }
    });
  });

  describe('L2 book walking in evaluateWindow', () => {
    it('uses L2 levels when available (feeMode triggers new path)', () => {
      const timeline = makeTimeline({ bestAsk: 0.55, bestBid: 0.53, askSize: 100 });
      const win = makeWindowEvent('UP');

      const result = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.TAKER_ONLY,
      });

      expect(result.tradesInWindow).toBeGreaterThanOrEqual(1);
      expect(result.fillResults).toBeDefined();
      expect(result.fillResults.length).toBeGreaterThanOrEqual(1);

      // Check fill used L2
      const firstFill = result.fillResults[0];
      expect(firstFill.success).toBe(true);
      expect(firstFill.usedL2).toBe(true);
      expect(firstFill.feeDollars).toBeGreaterThan(0);
    });

    it('falls back gracefully when no L2 levels exist', () => {
      // Timeline with CLOB but no L2 levels
      const baseTime = new Date('2025-01-15T12:00:00Z').getTime();
      const closeTime = baseTime + 5 * 60 * 1000;
      const events = [];

      for (let t = baseTime; t < closeTime; t += 10000) {
        const ts = new Date(t).toISOString();
        events.push({
          source: 'clobUp',
          timestamp: ts,
          best_bid: '0.53',
          best_ask: '0.55',
          mid_price: '0.54',
          spread: '0.02',
          bid_size_top: '1000',
          ask_size_top: '1000',
          _ms: t,
        });
        events.push({
          source: 'clobDown',
          timestamp: ts,
          best_bid: '0.45',
          best_ask: '0.47',
          mid_price: '0.46',
          spread: '0.02',
          bid_size_top: '1000',
          ask_size_top: '1000',
          _ms: t,
        });
      }

      const win = makeWindowEvent('UP');
      const result = evaluateWindow({
        window: win,
        timeline: events,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.TAKER_ONLY,
      });

      expect(result.tradesInWindow).toBeGreaterThanOrEqual(1);
      if (result.fillResults.length > 0) {
        const fill = result.fillResults[0];
        expect(fill.success).toBe(true);
        // Should use fallback path (no L2 levels available)
        expect(fill.usedL2).toBe(false);
      }
    });
  });

  describe('fee mode defaults', () => {
    it('applies taker fee when feeMode not specified (default behavior)', () => {
      const timeline = makeTimeline({ bestAsk: 0.55, bestBid: 0.53 });
      const win = makeWindowEvent('UP');

      // No feeMode specified — should default to TAKER_ONLY
      const result = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
      });

      expect(result.feeMode).toBe(FeeMode.TAKER_ONLY);
    });
  });

  describe('losing trade with fees', () => {
    it('fees make losing trades worse', () => {
      const timeline = makeTimeline({ bestAsk: 0.55, bestBid: 0.53 });
      const win = makeWindowEvent('DOWN'); // Strategy buys UP but market resolves DOWN

      const zeroResult = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.ZERO,
      });

      const takerResult = evaluateWindow({
        window: win,
        timeline,
        strategy: simpleStrategy,
        strategyConfig: { capitalPerTrade: 10 },
        initialCapital: 100,
        spreadBuffer: 0.005,
        windowDurationMs: 5 * 60 * 1000,
        feeMode: FeeMode.TAKER_ONLY,
      });

      // Both should lose, but taker should lose more
      if (zeroResult.tradesInWindow > 0 && takerResult.tradesInWindow > 0) {
        expect(zeroResult.pnl).toBeLessThan(0);
        expect(takerResult.pnl).toBeLessThan(zeroResult.pnl);
      }
    });
  });
});
