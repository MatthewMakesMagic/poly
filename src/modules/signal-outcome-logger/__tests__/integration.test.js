/**
 * Signal Outcome Logger Integration Tests
 *
 * End-to-end tests:
 * - Signal → Log → Settlement → Outcome Update flow
 * - Database record verification
 * - Subscription callback handling
 * - Missing signal handling
 * - Duplicate window_id handling
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SignalOutcomeLogger } from '../logger.js';
import { DEFAULT_CONFIG, BucketType } from '../types.js';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Create in-memory database mock with realistic behavior
const createInMemoryDb = () => {
  const signals = new Map();
  let nextId = 1;

  return {
    run: vi.fn((sql, params) => {
      if (sql.includes('INSERT')) {
        const id = nextId++;
        const windowId = params[1];
        signals.set(windowId, {
          id,
          timestamp: params[0],
          window_id: windowId,
          symbol: params[2],
          time_to_expiry_ms: params[3],
          ui_price: params[4],
          oracle_price: params[5],
          oracle_staleness_ms: params[6],
          strike: params[7],
          market_token_price: params[8],
          signal_direction: params[9],
          confidence: params[10],
          token_id: params[11],
          side: params[12],
          entry_price: params[13],
          final_oracle_price: null,
          settlement_outcome: null,
          signal_correct: null,
          exit_price: null,
          pnl: null,
        });
        return { lastInsertRowid: id };
      }
      if (sql.includes('UPDATE')) {
        const windowId = params[params.length - 1];
        const record = signals.get(windowId);
        if (record) {
          record.final_oracle_price = params[0];
          record.settlement_outcome = params[1];
          record.signal_correct = params[2];
          record.exit_price = params[3];
          record.pnl = params[4];
          record.updated_at = new Date().toISOString();
        }
        return { changes: record ? 1 : 0 };
      }
      return { lastInsertRowid: 0 };
    }),

    get: vi.fn((sql, params) => {
      if (sql.includes('SELECT * FROM oracle_edge_signals WHERE window_id')) {
        return signals.get(params[0]) || null;
      }
      if (sql.includes('COUNT')) {
        const all = Array.from(signals.values());
        const withOutcome = all.filter(s => s.settlement_outcome !== null);
        const wins = withOutcome.filter(s => s.signal_correct === 1).length;
        const totalPnl = withOutcome.reduce((sum, s) => sum + (s.pnl || 0), 0);
        const avgConfidence = all.length > 0
          ? all.reduce((sum, s) => sum + (s.confidence || 0), 0) / all.length
          : 0;

        return {
          total: all.length,
          with_outcome: withOutcome.length,
          pending: all.length - withOutcome.length,
          wins,
          total_pnl: totalPnl,
          avg_confidence: avgConfidence,
        };
      }
      return null;
    }),

    all: vi.fn((sql, params) => {
      const all = Array.from(signals.values());

      if (sql.includes('ORDER BY timestamp DESC')) {
        const limit = params?.[0] || 50;
        return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
      }

      // Bucket queries - return simplified results for testing
      if (sql.includes('GROUP BY bucket') || sql.includes('GROUP BY symbol')) {
        const withOutcome = all.filter(s => s.settlement_outcome !== null);

        if (sql.includes('symbol as bucket')) {
          const bySymbol = {};
          for (const s of withOutcome) {
            if (!bySymbol[s.symbol]) {
              bySymbol[s.symbol] = { bucket: s.symbol, signals: 0, wins: 0, pnl: 0, avg_confidence: 0 };
            }
            bySymbol[s.symbol].signals++;
            bySymbol[s.symbol].wins += s.signal_correct || 0;
            bySymbol[s.symbol].pnl += s.pnl || 0;
          }
          return Object.values(bySymbol);
        }

        if (sql.includes('time_to_expiry_ms')) {
          const buckets = { '0-10s': [], '10-20s': [], '20-30s': [] };
          for (const s of withOutcome) {
            if (s.time_to_expiry_ms <= 10000) buckets['0-10s'].push(s);
            else if (s.time_to_expiry_ms <= 20000) buckets['10-20s'].push(s);
            else buckets['20-30s'].push(s);
          }
          return Object.entries(buckets)
            .filter(([, arr]) => arr.length > 0)
            .map(([bucket, arr]) => ({
              bucket,
              signals: arr.length,
              wins: arr.filter(s => s.signal_correct === 1).length,
              pnl: arr.reduce((sum, s) => sum + (s.pnl || 0), 0),
            }));
        }
      }

      return [];
    }),

    // Helper for tests
    _getSignal: (windowId) => signals.get(windowId),
    _getAllSignals: () => Array.from(signals.values()),
    _clear: () => {
      signals.clear();
      nextId = 1;
    },
  };
};

// Create test signal
const createTestSignal = (overrides = {}) => ({
  window_id: `btc-15m-${Date.now()}`,
  symbol: 'btc',
  direction: 'fade_up',
  confidence: 0.78,
  token_id: '0xDOWN456',
  side: 'buy',
  inputs: {
    time_remaining_ms: 25000,
    market_price: 0.30,
    ui_price: 0.58,
    oracle_price: 0.52,
    oracle_staleness_ms: 22000,
    spread_pct: 0.003,
    strike: 0.5,
  },
  generated_at: new Date().toISOString(),
  ...overrides,
});

describe('SignalOutcomeLogger Integration', () => {
  let logger;
  let mockLog;
  let mockDb;

  beforeEach(() => {
    mockLog = createMockLogger();
    mockDb = createInMemoryDb();

    logger = new SignalOutcomeLogger({
      config: DEFAULT_CONFIG,
      logger: mockLog,
      db: mockDb,
    });
  });

  describe('End-to-end signal flow', () => {
    test('signal → log → settlement → outcome update', async () => {
      const signal = createTestSignal({
        window_id: 'btc-15m-e2e-test',
        direction: 'fade_up',
        inputs: { ...createTestSignal().inputs, market_price: 0.30 },
      });

      // Step 1: Log signal
      const signalId = await logger.logSignal(signal);
      expect(signalId).toBe(1);

      // Verify signal recorded
      const recorded = mockDb._getSignal('btc-15m-e2e-test');
      expect(recorded).not.toBeNull();
      expect(recorded.symbol).toBe('btc');
      expect(recorded.signal_direction).toBe('fade_up');
      expect(recorded.settlement_outcome).toBeNull();

      // Step 2: Settlement comes (price below strike = down = we win with fade_up)
      const settlementData = {
        final_oracle_price: 0.48, // Below 0.5 strike
        settlement_time: new Date().toISOString(),
      };

      const updated = await logger.updateOutcome('btc-15m-e2e-test', settlementData);
      expect(updated).toBe(true);

      // Verify outcome recorded
      const afterSettlement = mockDb._getSignal('btc-15m-e2e-test');
      expect(afterSettlement.final_oracle_price).toBe(0.48);
      expect(afterSettlement.settlement_outcome).toBe('down');
      expect(afterSettlement.signal_correct).toBe(1); // fade_up + down = correct
      expect(afterSettlement.pnl).toBe(0.70); // (1 - 0.30) * 1
    });

    test('losing signal flow (fade_up + up outcome)', async () => {
      const signal = createTestSignal({
        window_id: 'btc-15m-loss-test',
        direction: 'fade_up',
        inputs: { ...createTestSignal().inputs, market_price: 0.30 },
      });

      await logger.logSignal(signal);

      // Settlement: price above strike = up = we lose with fade_up
      const updated = await logger.updateOutcome('btc-15m-loss-test', {
        final_oracle_price: 0.55,
      });
      expect(updated).toBe(true);

      const record = mockDb._getSignal('btc-15m-loss-test');
      expect(record.settlement_outcome).toBe('up');
      expect(record.signal_correct).toBe(0); // fade_up + up = incorrect
      expect(record.pnl).toBe(-0.30); // -0.30 * 1
    });

    test('fade_down winning flow', async () => {
      const signal = createTestSignal({
        window_id: 'btc-15m-fd-win-test',
        direction: 'fade_down',
        inputs: { ...createTestSignal().inputs, market_price: 0.40 },
      });

      await logger.logSignal(signal);

      // Settlement: price above strike = up = we win with fade_down
      const updated = await logger.updateOutcome('btc-15m-fd-win-test', {
        final_oracle_price: 0.55,
      });
      expect(updated).toBe(true);

      const record = mockDb._getSignal('btc-15m-fd-win-test');
      expect(record.settlement_outcome).toBe('up');
      expect(record.signal_correct).toBe(1); // fade_down + up = correct
      expect(record.pnl).toBe(0.60); // (1 - 0.40) * 1
    });
  });

  describe('Statistics after multiple signals', () => {
    test('calculates correct win rate and total PnL', async () => {
      // Signal 1: Win (fade_up + down)
      await logger.logSignal(createTestSignal({
        window_id: 'test-1',
        direction: 'fade_up',
        confidence: 0.80,
        inputs: { ...createTestSignal().inputs, market_price: 0.30 },
      }));
      await logger.updateOutcome('test-1', { final_oracle_price: 0.45 });

      // Signal 2: Lose (fade_up + up)
      await logger.logSignal(createTestSignal({
        window_id: 'test-2',
        direction: 'fade_up',
        confidence: 0.70,
        inputs: { ...createTestSignal().inputs, market_price: 0.40 },
      }));
      await logger.updateOutcome('test-2', { final_oracle_price: 0.55 });

      // Signal 3: Win (fade_down + up)
      await logger.logSignal(createTestSignal({
        window_id: 'test-3',
        direction: 'fade_down',
        confidence: 0.75,
        inputs: { ...createTestSignal().inputs, market_price: 0.35 },
      }));
      await logger.updateOutcome('test-3', { final_oracle_price: 0.52 });

      const stats = logger.getStats();

      expect(stats.total_signals).toBe(3);
      expect(stats.signals_with_outcome).toBe(3);
      expect(stats.pending_outcomes).toBe(0);
      expect(stats.win_rate).toBeCloseTo(2 / 3, 2); // 2 wins out of 3

      // PnL: 0.70 + (-0.40) + 0.65 = 0.95
      expect(stats.total_pnl).toBeCloseTo(0.95, 2);
    });

    test('handles pending outcomes in stats', async () => {
      await logger.logSignal(createTestSignal({ window_id: 'pending-1' }));
      await logger.logSignal(createTestSignal({ window_id: 'pending-2' }));

      // Only settle one
      await logger.updateOutcome('pending-1', { final_oracle_price: 0.48 });

      const stats = logger.getStats();

      expect(stats.total_signals).toBe(2);
      expect(stats.signals_with_outcome).toBe(1);
      expect(stats.pending_outcomes).toBe(1);
    });
  });

  describe('Bucket statistics', () => {
    test('groups by symbol correctly', async () => {
      // BTC signals
      await logger.logSignal(createTestSignal({ window_id: 'btc-1', symbol: 'btc' }));
      await logger.updateOutcome('btc-1', { final_oracle_price: 0.48 });
      await logger.logSignal(createTestSignal({ window_id: 'btc-2', symbol: 'btc' }));
      await logger.updateOutcome('btc-2', { final_oracle_price: 0.45 });

      // ETH signals
      await logger.logSignal(createTestSignal({ window_id: 'eth-1', symbol: 'eth' }));
      await logger.updateOutcome('eth-1', { final_oracle_price: 0.52 });

      const buckets = logger.getStatsByBucket(BucketType.SYMBOL);

      const btcBucket = buckets.find(b => b.bucket === 'btc');
      const ethBucket = buckets.find(b => b.bucket === 'eth');

      expect(btcBucket.signals).toBe(2);
      expect(ethBucket.signals).toBe(1);
    });

    test('groups by time_to_expiry correctly', async () => {
      // 5 seconds
      await logger.logSignal(createTestSignal({
        window_id: 'time-1',
        inputs: { ...createTestSignal().inputs, time_remaining_ms: 5000 },
      }));
      await logger.updateOutcome('time-1', { final_oracle_price: 0.48 });

      // 15 seconds
      await logger.logSignal(createTestSignal({
        window_id: 'time-2',
        inputs: { ...createTestSignal().inputs, time_remaining_ms: 15000 },
      }));
      await logger.updateOutcome('time-2', { final_oracle_price: 0.48 });

      // 25 seconds
      await logger.logSignal(createTestSignal({
        window_id: 'time-3',
        inputs: { ...createTestSignal().inputs, time_remaining_ms: 25000 },
      }));
      await logger.updateOutcome('time-3', { final_oracle_price: 0.48 });

      const buckets = logger.getStatsByBucket(BucketType.TIME_TO_EXPIRY);

      expect(buckets.some(b => b.bucket === '0-10s')).toBe(true);
      expect(buckets.some(b => b.bucket === '10-20s')).toBe(true);
      expect(buckets.some(b => b.bucket === '20-30s')).toBe(true);
    });
  });

  describe('Duplicate window_id handling', () => {
    test('upserts duplicate window_id', async () => {
      const windowId = 'duplicate-test';

      // First insert
      await logger.logSignal(createTestSignal({
        window_id: windowId,
        confidence: 0.70,
      }));

      // Second insert with same window_id (upsert)
      await logger.logSignal(createTestSignal({
        window_id: windowId,
        confidence: 0.80,
      }));

      const signals = mockDb._getAllSignals();
      const matchingSignals = signals.filter(s => s.window_id === windowId);

      // Should only have one record (upserted)
      expect(matchingSignals.length).toBe(1);
      expect(matchingSignals[0].confidence).toBe(0.80);
    });
  });

  describe('Missing signal handling', () => {
    test('returns false for settlement on unknown window', async () => {
      const result = await logger.updateOutcome('unknown-window-id', {
        final_oracle_price: 0.50,
      });

      expect(result).toBe(false);
      expect(mockLog.debug).toHaveBeenCalledWith('settlement_no_signal', expect.any(Object));
    });
  });

  describe('Recent signals query', () => {
    test('returns signals in reverse chronological order', async () => {
      const now = Date.now();

      await logger.logSignal(createTestSignal({
        window_id: 'old',
        generated_at: new Date(now - 10000).toISOString(),
      }));
      await logger.logSignal(createTestSignal({
        window_id: 'new',
        generated_at: new Date(now).toISOString(),
      }));

      const recent = logger.getRecentSignals(10);

      expect(recent.length).toBe(2);
      expect(recent[0].window_id).toBe('new');
      expect(recent[1].window_id).toBe('old');
    });

    test('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await logger.logSignal(createTestSignal({ window_id: `signal-${i}` }));
      }

      const recent = logger.getRecentSignals(5);

      expect(recent.length).toBe(5);
    });
  });

  describe('Subscription callback integration', () => {
    test('auto-logs signals from subscription', async () => {
      let capturedCallback;
      const mockSignalModule = {
        subscribe: vi.fn((cb) => {
          capturedCallback = cb;
          return () => {};
        }),
      };

      logger.subscribeToSignals(mockSignalModule);

      // Simulate signal event
      const signal = createTestSignal({ window_id: 'subscription-test' });
      await capturedCallback(signal);

      const recorded = mockDb._getSignal('subscription-test');
      expect(recorded).not.toBeNull();
      expect(recorded.symbol).toBe('btc');
    });

    test('auto-updates outcomes from settlement subscription', async () => {
      // First log a signal
      await logger.logSignal(createTestSignal({ window_id: 'settlement-sub-test' }));

      let settlementCallback;
      const subscribeFn = vi.fn((cb) => {
        settlementCallback = cb;
        return () => {};
      });

      logger.subscribeToSettlements(subscribeFn);

      // Simulate settlement event
      await settlementCallback({
        window_id: 'settlement-sub-test',
        final_oracle_price: 0.48,
      });

      const record = mockDb._getSignal('settlement-sub-test');
      expect(record.settlement_outcome).toBe('down');
      expect(record.signal_correct).toBe(1);
    });

    test('handles callback errors without affecting other callbacks', async () => {
      // First log a signal
      await logger.logSignal(createTestSignal({ window_id: 'error-test' }));

      const mockSignalModule = {
        subscribe: vi.fn(() => {
          throw new Error('Simulated subscription error');
        }),
      };

      // Should not throw
      expect(() => logger.subscribeToSignals(mockSignalModule)).not.toThrow();
      expect(mockLog.warn).toHaveBeenCalledWith('signal_subscription_failed', expect.any(Object));
    });
  });

  describe('Edge cases', () => {
    test('handles signal with minimal inputs', async () => {
      const minimalSignal = {
        window_id: 'minimal-test',
        generated_at: new Date().toISOString(),
      };

      const id = await logger.logSignal(minimalSignal);
      expect(id).toBe(1);
    });

    test('handles settlement at exact strike price', async () => {
      await logger.logSignal(createTestSignal({ window_id: 'strike-test' }));

      // Settlement at exactly 0.5 (strike)
      await logger.updateOutcome('strike-test', {
        final_oracle_price: 0.5,
      });

      const record = mockDb._getSignal('strike-test');
      // 0.5 is not > 0.5, so outcome should be 'down'
      expect(record.settlement_outcome).toBe('down');
    });

    test('handles very small PnL values', async () => {
      await logger.logSignal(createTestSignal({
        window_id: 'small-pnl-test',
        inputs: { ...createTestSignal().inputs, market_price: 0.999 },
      }));

      await logger.updateOutcome('small-pnl-test', {
        final_oracle_price: 0.48,
      });

      const record = mockDb._getSignal('small-pnl-test');
      // Win: 1 - 0.999 = 0.001
      expect(record.pnl).toBeCloseTo(0.001, 4);
    });

    test('handles very large PnL values', async () => {
      await logger.logSignal(createTestSignal({
        window_id: 'large-pnl-test',
        inputs: { ...createTestSignal().inputs, market_price: 0.01 },
      }));

      await logger.updateOutcome('large-pnl-test', {
        final_oracle_price: 0.48,
      });

      const record = mockDb._getSignal('large-pnl-test');
      // Win: 1 - 0.01 = 0.99
      expect(record.pnl).toBeCloseTo(0.99, 2);
    });
  });
});
