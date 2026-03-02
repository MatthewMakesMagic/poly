import { describe, it, expect } from 'vitest';
import { runBacktest } from '../backtestEngine.js';

const WINDOWS = [
  {
    window_id: 'btc-1700000000',
    symbol: 'btc',
    window_close_time: '2025-11-14T12:00:00Z',
    resolved_direction: 'up',
    market_consensus_direction: 'up',
    consensus_confidence: 0.8,
    clob_up_60s: 0.65,
    clob_down_60s: 0.35,
    clob_up_30s: 0.70,
    clob_down_30s: 0.30,
    clob_up_10s: 0.75,
    clob_down_10s: 0.25,
    clob_up_5s: 0.80,
    clob_down_5s: 0.20,
    clob_up_1s: 0.85,
    clob_down_1s: 0.15,
    oracle_open_price: 90000,
    oracle_close_price: 90100,
    strike_price: 90050,
  },
  {
    window_id: 'btc-1700001000',
    symbol: 'btc',
    window_close_time: '2025-11-14T13:00:00Z',
    resolved_direction: 'down',
    market_consensus_direction: 'up',
    consensus_confidence: 0.6,
    clob_up_60s: 0.55,
    clob_down_60s: 0.45,
    clob_up_30s: 0.52,
    clob_down_30s: 0.48,
    clob_up_10s: 0.50,
    clob_down_10s: 0.50,
    clob_up_5s: 0.48,
    clob_down_5s: 0.52,
    clob_up_1s: 0.45,
    clob_down_1s: 0.55,
    oracle_open_price: 90100,
    oracle_close_price: 89900,
    strike_price: 90000,
  },
  {
    window_id: 'eth-1700002000',
    symbol: 'eth',
    window_close_time: '2025-11-14T14:00:00Z',
    resolved_direction: 'up',
    market_consensus_direction: 'up',
    consensus_confidence: 0.9,
    clob_up_60s: 0.70,
    clob_down_60s: 0.30,
    clob_up_30s: 0.75,
    clob_down_30s: 0.25,
    clob_up_10s: 0.80,
    clob_down_10s: 0.20,
    clob_up_5s: 0.85,
    clob_down_5s: 0.15,
    clob_up_1s: 0.90,
    clob_down_1s: 0.10,
    oracle_open_price: 3200,
    oracle_close_price: 3220,
    strike_price: 3210,
  },
];

describe('runBacktest', () => {
  it('returns correct trade count and metrics for consensus strategy', () => {
    const result = runBacktest(WINDOWS);
    expect(result.totalTrades).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(1);
  });

  it('computes correct P&L for consensus @ 60s', () => {
    const result = runBacktest(WINDOWS);
    // Window 1: entry 0.65, resolves UP -> pnl = 1 - 0.65 = 0.35
    // Window 2: entry 0.55, resolves DOWN -> pnl = 0 - 0.55 = -0.55
    // Window 3: entry 0.70, resolves UP -> pnl = 1 - 0.70 = 0.30
    // Total = 0.35 - 0.55 + 0.30 = 0.10
    expect(result.trades[0].pnl).toBeCloseTo(0.35, 2);
    expect(result.trades[1].pnl).toBeCloseTo(-0.55, 2);
    expect(result.trades[2].pnl).toBeCloseTo(0.30, 2);
    expect(result.totalPnl).toBeCloseTo(0.10, 2);
  });

  it('filters by symbol', () => {
    const result = runBacktest(WINDOWS, { symbols: ['eth'] });
    expect(result.totalTrades).toBe(1);
    expect(result.trades[0].symbol).toBe('eth');
  });

  it('contrarian strategy inverts side', () => {
    // Contrarian: bet DOWN when consensus is UP
    // Window 1: entry clob_down_60s=0.35, resolves UP -> pnl = 0 - 0.35 = -0.35 (loss)
    // Window 2: entry clob_down_60s=0.45, resolves DOWN -> pnl = 1 - 0.45 = 0.55 (win)
    // Window 3: entry clob_down_60s=0.30, resolves UP -> pnl = 0 - 0.30 = -0.30 (loss)
    const result = runBacktest(WINDOWS, { strategy: 'contrarian' });
    expect(result.totalTrades).toBe(3);
    expect(result.wins).toBe(1);
    expect(result.winRate).toBeCloseTo(1 / 3, 2);
    expect(result.trades[0].pnl).toBeCloseTo(-0.35, 2);
    expect(result.trades[1].pnl).toBeCloseTo(0.55, 2);
    expect(result.trades[2].pnl).toBeCloseTo(-0.30, 2);
  });

  it('generates equity curve', () => {
    const result = runBacktest(WINDOWS);
    expect(result.equityCurve).toHaveLength(3);
    // Cumulative PnL: 0.35, 0.35 - 0.55 = -0.20, -0.20 + 0.30 = 0.10
    expect(result.equityCurve[0].pnl).toBeCloseTo(0.35, 2);
    expect(result.equityCurve[1].pnl).toBeCloseTo(-0.20, 2);
    expect(result.equityCurve[2].pnl).toBeCloseTo(0.10, 2);
  });

  it('computes bySymbol and byHour', () => {
    const result = runBacktest(WINDOWS);
    expect(result.bySymbol).toHaveProperty('btc');
    expect(result.bySymbol).toHaveProperty('eth');
    expect(result.bySymbol.btc.trades).toBe(2);
    expect(result.bySymbol.eth.trades).toBe(1);
  });

  it('respects confidence filter', () => {
    // confidenceMin=0.7 should exclude window 2 (confidence=0.6)
    const result = runBacktest(WINDOWS, { confidenceMin: 0.7 });
    expect(result.totalTrades).toBe(2);
    expect(result.wins).toBe(2);
  });

  it('handles empty windows', () => {
    const result = runBacktest([]);
    expect(result.totalTrades).toBe(0);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(0);
    expect(result.totalPnl).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.equityCurve).toHaveLength(0);
  });

  it('skips windows with invalid resolved_direction', () => {
    const invalidWindows = [
      { ...WINDOWS[0], resolved_direction: '' },
      { ...WINDOWS[1], resolved_direction: null },
      WINDOWS[2], // valid
    ];
    const result = runBacktest(invalidWindows);
    expect(result.totalTrades).toBe(1);
    expect(result.trades[0].windowId).toBe('eth-1700002000');
  });
});
