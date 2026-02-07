/**
 * Tests for binary option simulator
 */

import { describe, it, expect } from 'vitest';
import { Simulator, createSimulator } from '../simulator.js';

describe('Simulator', () => {
  describe('buyToken', () => {
    it('creates position and deducts cost', () => {
      const sim = createSimulator({ initialCapital: 100 });

      const pos = sim.buyToken({
        token: 'btc_down',
        price: 0.45,
        size: 10,
        timestamp: '2026-01-25T12:00:00Z',
        reason: 'test',
      });

      expect(pos.token).toBe('btc_down');
      expect(pos.entryPrice).toBe(0.45);
      expect(pos.cost).toBe(4.5); // 0.45 * 10
      expect(pos.resolved).toBe(false);
      expect(sim.getCapital()).toBe(95.5); // 100 - 4.5
      expect(sim.getOpenPositions()).toHaveLength(1);
    });
  });

  describe('sellToken', () => {
    it('sells early and calculates PnL', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_down', price: 0.45, size: 10, timestamp: 't1' });
      const sold = sim.sellToken({ token: 'btc_down', price: 0.55, timestamp: 't2', reason: 'exit' });

      expect(sold).not.toBeNull();
      expect(sold.pnl).toBeCloseTo(1.0); // (0.55 * 10) - (0.45 * 10) = 1.0
      expect(sold.exitReason).toBe('exit');
      expect(sim.getOpenPositions()).toHaveLength(0);
    });

    it('returns null when no matching position', () => {
      const sim = createSimulator();
      const result = sim.sellToken({ token: 'btc_up', price: 0.5, timestamp: 't1' });
      expect(result).toBeNull();
    });
  });

  describe('resolveWindow', () => {
    it('resolves DOWN correctly — DOWN token wins', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_down', price: 0.45, size: 10, timestamp: 't1' });
      // capital = 100 - 4.5 = 95.5

      sim.resolveWindow({ direction: 'DOWN', timestamp: 't2' });

      expect(sim.getOpenPositions()).toHaveLength(0);
      const trades = sim.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0].payout).toBe(10); // 1.00 * 10
      expect(trades[0].pnl).toBeCloseTo(5.5); // 10 - 4.5
      expect(trades[0].exitReason).toBe('resolution');
      // capital = 95.5 + 10 = 105.5
      expect(sim.getCapital()).toBeCloseTo(105.5);
    });

    it('resolves DOWN correctly — UP token loses', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_up', price: 0.60, size: 10, timestamp: 't1' });
      // capital = 100 - 6 = 94

      sim.resolveWindow({ direction: 'DOWN', timestamp: 't2' });

      const trades = sim.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0].payout).toBe(0); // UP token loses when DOWN
      expect(trades[0].pnl).toBeCloseTo(-6); // 0 - 6
      // capital = 94 + 0 = 94
      expect(sim.getCapital()).toBeCloseTo(94);
    });

    it('resolves UP correctly — UP token wins', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_up', price: 0.60, size: 10, timestamp: 't1' });

      sim.resolveWindow({ direction: 'UP', timestamp: 't2' });

      const trades = sim.getTrades();
      expect(trades[0].payout).toBe(10);
      expect(trades[0].pnl).toBeCloseTo(4); // 10 - 6
    });

    it('resolves multiple positions in same window', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_down', price: 0.45, size: 5, timestamp: 't1' });
      sim.buyToken({ token: 'btc_down', price: 0.50, size: 5, timestamp: 't2' });

      sim.resolveWindow({ direction: 'DOWN', timestamp: 't3' });

      const trades = sim.getTrades();
      expect(trades).toHaveLength(2);
      // Both win
      expect(trades[0].pnl).toBeCloseTo(2.75); // 5 - 2.25
      expect(trades[1].pnl).toBeCloseTo(2.50); // 5 - 2.50
    });
  });

  describe('getWindowPnL', () => {
    it('tracks per-window PnL', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_down', price: 0.45, size: 10, timestamp: 't1' });
      sim.resolveWindow({ direction: 'DOWN', timestamp: 't2' });

      expect(sim.getWindowPnL()).toBeCloseTo(5.5);

      sim.resetWindowPnL();
      expect(sim.getWindowPnL()).toBe(0);
    });
  });

  describe('execute', () => {
    it('fills buy at bestAsk + buffer', () => {
      const sim = createSimulator({ spreadBuffer: 0.005 });
      const state = {
        clobDown: { bestBid: 0.50, bestAsk: 0.52 },
        clobUp: { bestBid: 0.48, bestAsk: 0.50 },
      };

      const result = sim.execute(
        { action: 'buy', token: 'btc_down', size: 1 },
        state,
      );

      expect(result.filled).toBe(true);
      expect(result.fillPrice).toBeCloseTo(0.525); // 0.52 + 0.005
    });

    it('rejects when no CLOB data', () => {
      const sim = createSimulator();
      const result = sim.execute(
        { action: 'buy', token: 'btc_down', size: 1 },
        { clobDown: null, clobUp: null },
      );

      expect(result.filled).toBe(false);
      expect(result.reason).toBe('no_clob_data');
    });

    it('rejects when insufficient capital', () => {
      const sim = createSimulator({ initialCapital: 0.01 });
      const state = {
        clobDown: { bestBid: 0.50, bestAsk: 0.52 },
      };

      const result = sim.execute(
        { action: 'buy', token: 'btc_down', size: 100 },
        state,
      );

      expect(result.filled).toBe(false);
      expect(result.reason).toBe('insufficient_capital');
    });
  });

  describe('getStats', () => {
    it('returns correct stats', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_down', price: 0.45, size: 10, timestamp: 't1' });
      sim.resolveWindow({ direction: 'DOWN', timestamp: 't2' });

      const stats = sim.getStats();
      expect(stats.tradeCount).toBe(1);
      expect(stats.winCount).toBe(1);
      expect(stats.winRate).toBe(1);
      expect(stats.totalPnl).toBeCloseTo(5.5);
    });
  });

  describe('reset', () => {
    it('resets all state', () => {
      const sim = createSimulator({ initialCapital: 100 });

      sim.buyToken({ token: 'btc_down', price: 0.45, size: 10, timestamp: 't1' });
      sim.resolveWindow({ direction: 'DOWN', timestamp: 't2' });

      sim.reset();

      expect(sim.getCapital()).toBe(100);
      expect(sim.getTotalPnl()).toBe(0);
      expect(sim.getOpenPositions()).toHaveLength(0);
      expect(sim.getTrades()).toHaveLength(0);
    });
  });
});
