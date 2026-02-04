/**
 * Signal Outcome Logger Class Tests
 *
 * Tests for the SignalOutcomeLogger class:
 * - Signal logging
 * - Outcome update and calculation
 * - PnL calculation
 * - Statistics queries
 * - Bucket analytics
 * - Subscription patterns
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { SignalOutcomeLogger } from '../logger.js';
import {
  SignalOutcomeLoggerError,
  SignalOutcomeLoggerErrorCodes,
  DEFAULT_CONFIG,
  BucketType,
} from '../types.js';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Mock database (V3: all methods return promises)
const createMockDb = () => {
  const rows = [];
  let nextId = 1;

  return {
    rows,
    run: vi.fn(async (sql, params) => {
      if (sql.includes('INSERT')) {
        const id = nextId++;
        rows.push({
          id,
          window_id: params[1],
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
        });
        return { lastInsertRowid: id };
      }
      if (sql.includes('UPDATE')) {
        const windowId = params[params.length - 1];
        const row = rows.find(r => r.window_id === windowId);
        if (row) {
          row.final_oracle_price = params[0];
          row.settlement_outcome = params[1];
          row.signal_correct = params[2];
          row.exit_price = params[3];
          row.pnl = params[4];
        }
        return { changes: row ? 1 : 0 };
      }
      return { lastInsertRowid: nextId - 1 };
    }),
    get: vi.fn(async (sql, params) => {
      if (sql.includes('SELECT * FROM oracle_edge_signals WHERE window_id')) {
        return rows.find(r => r.window_id === params[0]) || null;
      }
      if (sql.includes('COUNT')) {
        const withOutcome = rows.filter(r => r.settlement_outcome !== null && r.settlement_outcome !== undefined);
        const wins = withOutcome.filter(r => r.signal_correct === 1).length;
        const totalPnl = withOutcome.reduce((sum, r) => sum + (r.pnl || 0), 0);
        const avgConfidence = rows.length > 0
          ? rows.reduce((sum, r) => sum + (r.confidence || 0), 0) / rows.length
          : 0;
        return {
          total: rows.length,
          with_outcome: withOutcome.length,
          pending: rows.length - withOutcome.length,
          wins,
          total_pnl: totalPnl,
          avg_confidence: avgConfidence,
        };
      }
      return null;
    }),
    all: vi.fn(async (sql, params) => {
      if (sql.includes('ORDER BY timestamp DESC')) {
        const limit = params?.[0] || 50;
        return rows.slice(0, limit);
      }
      // Bucket queries
      return [];
    }),
    reset: () => {
      rows.length = 0;
      nextId = 1;
    },
  };
};

// Create valid signal object
const createSignal = (overrides = {}) => ({
  window_id: 'btc-15m-1706745600',
  symbol: 'btc',
  direction: 'fade_up',
  confidence: 0.78,
  token_id: '0xDOWN456',
  side: 'buy',
  inputs: {
    time_remaining_ms: 25000,
    market_price: 0.72,
    ui_price: 0.58,
    oracle_price: 0.52,
    oracle_staleness_ms: 22000,
    spread_pct: 0.003,
    strike: 0.5,
    staleness_score: 0.68,
  },
  generated_at: '2026-02-01T12:14:35.123Z',
  ...overrides,
});

// Create settlement data
const createSettlementData = (overrides = {}) => ({
  final_oracle_price: 0.48,  // Below strike (0.5), so outcome = 'down'
  settlement_time: '2026-02-01T12:15:00.000Z',
  ...overrides,
});

describe('SignalOutcomeLogger', () => {
  let logger;
  let mockLog;
  let mockDb;

  beforeEach(() => {
    mockLog = createMockLogger();
    mockDb = createMockDb();

    logger = new SignalOutcomeLogger({
      config: DEFAULT_CONFIG,
      logger: mockLog,
      db: mockDb,
    });
  });

  describe('logSignal', () => {
    test('logs signal and returns ID', async () => {
      const signal = createSignal();

      const id = await logger.logSignal(signal);

      expect(id).toBe(1);
      expect(mockDb.run).toHaveBeenCalled();
    });

    test('extracts all required fields from signal', async () => {
      const signal = createSignal();

      await logger.logSignal(signal);

      const insertCall = mockDb.run.mock.calls[0];
      expect(insertCall[1]).toContain('btc-15m-1706745600'); // window_id
      expect(insertCall[1]).toContain('btc'); // symbol
      expect(insertCall[1]).toContain(25000); // time_to_expiry_ms
      expect(insertCall[1]).toContain(0.58); // ui_price
      expect(insertCall[1]).toContain(0.52); // oracle_price
      expect(insertCall[1]).toContain(22000); // oracle_staleness_ms
      expect(insertCall[1]).toContain('fade_up'); // signal_direction
      expect(insertCall[1]).toContain(0.78); // confidence
    });

    test('logs signal generation', async () => {
      const signal = createSignal();

      await logger.logSignal(signal);

      expect(mockLog.info).toHaveBeenCalledWith('signal_logged', expect.objectContaining({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
        direction: 'fade_up',
      }));
    });

    test('increments signals_logged stat', async () => {
      await logger.logSignal(createSignal());
      await logger.logSignal(createSignal({ window_id: 'btc-15m-2' }));

      const stats = logger.getInternalStats();

      expect(stats.signals_logged).toBe(2);
    });

    test('throws for missing window_id', async () => {
      const signal = createSignal();
      delete signal.window_id;

      await expect(logger.logSignal(signal)).rejects.toThrow(SignalOutcomeLoggerError);
    });

    test('throws for null signal', async () => {
      await expect(logger.logSignal(null)).rejects.toThrow(SignalOutcomeLoggerError);
    });

    test('handles missing inputs gracefully', async () => {
      const signal = createSignal();
      delete signal.inputs;

      const id = await logger.logSignal(signal);

      expect(id).toBe(1);
    });

    test('handles database error', async () => {
      mockDb.run.mockImplementation(() => {
        throw new Error('Database error');
      });

      await expect(logger.logSignal(createSignal())).rejects.toThrow(SignalOutcomeLoggerError);
      expect(logger.getInternalStats().errors).toBe(1);
    });
  });

  describe('updateOutcome', () => {
    beforeEach(async () => {
      // Insert a signal first
      await logger.logSignal(createSignal());
    });

    test('updates signal record with settlement outcome', async () => {
      const result = await logger.updateOutcome(
        'btc-15m-1706745600',
        createSettlementData()
      );

      expect(result).toBe(true);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE oracle_edge_signals'),
        expect.any(Array)
      );
    });

    test('calculates correct settlement outcome (down)', async () => {
      await logger.updateOutcome(
        'btc-15m-1706745600',
        createSettlementData({ final_oracle_price: 0.48 }) // Below strike
      );

      // The UPDATE call params are: [final_oracle_price, settlement_outcome, signal_correct, exit_price, pnl, window_id]
      const updateCalls = mockDb.run.mock.calls.filter(
        call => call[0].includes('UPDATE')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      const params = updateCalls[updateCalls.length - 1][1];
      expect(params[1]).toBe('down'); // settlement_outcome
    });

    test('calculates correct settlement outcome (up)', async () => {
      await logger.updateOutcome(
        'btc-15m-1706745600',
        createSettlementData({ final_oracle_price: 0.52 }) // Above strike
      );

      const updateCalls = mockDb.run.mock.calls.filter(
        call => call[0].includes('UPDATE')
      );
      const params = updateCalls[updateCalls.length - 1][1];
      expect(params[1]).toBe('up'); // settlement_outcome
    });

    test('calculates signal_correct for fade_up + down outcome', async () => {
      // Signal is fade_up, outcome is down -> correct (we bet on down)
      await logger.updateOutcome(
        'btc-15m-1706745600',
        createSettlementData({ final_oracle_price: 0.48 })
      );

      const updateCalls = mockDb.run.mock.calls.filter(
        call => call[0].includes('UPDATE')
      );
      const params = updateCalls[updateCalls.length - 1][1];
      expect(params[2]).toBe(1); // signal_correct = 1
    });

    test('calculates signal_correct for fade_up + up outcome', async () => {
      // Signal is fade_up, outcome is up -> incorrect
      await logger.updateOutcome(
        'btc-15m-1706745600',
        createSettlementData({ final_oracle_price: 0.55 })
      );

      const updateCalls = mockDb.run.mock.calls.filter(
        call => call[0].includes('UPDATE')
      );
      const params = updateCalls[updateCalls.length - 1][1];
      expect(params[2]).toBe(0); // signal_correct = 0
    });

    test('logs outcome update', async () => {
      await logger.updateOutcome(
        'btc-15m-1706745600',
        createSettlementData()
      );

      expect(mockLog.info).toHaveBeenCalledWith('outcome_updated', expect.objectContaining({
        window_id: 'btc-15m-1706745600',
      }));
    });

    test('returns false for unknown window_id', async () => {
      const result = await logger.updateOutcome(
        'unknown-window',
        createSettlementData()
      );

      expect(result).toBe(false);
      expect(mockLog.debug).toHaveBeenCalledWith('settlement_no_signal', expect.any(Object));
    });

    test('throws for missing windowId', async () => {
      await expect(
        logger.updateOutcome(null, createSettlementData())
      ).rejects.toThrow(SignalOutcomeLoggerError);
    });

    test('throws for missing final_oracle_price', async () => {
      await expect(
        logger.updateOutcome('btc-15m-1706745600', {})
      ).rejects.toThrow(SignalOutcomeLoggerError);
    });
  });

  describe('calculateSignalCorrect', () => {
    test('returns 1 for fade_up when outcome is down', () => {
      const result = logger.calculateSignalCorrect('fade_up', 'down');
      expect(result).toBe(1);
    });

    test('returns 0 for fade_up when outcome is up', () => {
      const result = logger.calculateSignalCorrect('fade_up', 'up');
      expect(result).toBe(0);
    });

    test('returns 1 for fade_down when outcome is up', () => {
      const result = logger.calculateSignalCorrect('fade_down', 'up');
      expect(result).toBe(1);
    });

    test('returns 0 for fade_down when outcome is down', () => {
      const result = logger.calculateSignalCorrect('fade_down', 'down');
      expect(result).toBe(0);
    });

    test('returns 0 for null direction', () => {
      const result = logger.calculateSignalCorrect(null, 'up');
      expect(result).toBe(0);
    });

    test('returns 0 for null outcome', () => {
      const result = logger.calculateSignalCorrect('fade_up', null);
      expect(result).toBe(0);
    });

    test('returns 0 for unknown direction', () => {
      const result = logger.calculateSignalCorrect('unknown', 'up');
      expect(result).toBe(0);
    });
  });

  describe('calculatePnL', () => {
    test('calculates positive PnL for correct signal', () => {
      const signalRecord = { market_token_price: 0.30 };
      const pnl = logger.calculatePnL(signalRecord, 1, 1);

      // Won: 1 - 0.30 = 0.70
      expect(pnl).toBe(0.70);
    });

    test('calculates negative PnL for incorrect signal', () => {
      const signalRecord = { market_token_price: 0.30 };
      const pnl = logger.calculatePnL(signalRecord, 0, 1);

      // Lost: -0.30
      expect(pnl).toBe(-0.30);
    });

    test('scales PnL by position size', () => {
      const signalRecord = { market_token_price: 0.40 };
      const pnl = logger.calculatePnL(signalRecord, 1, 2);

      // Won: 2 * (1 - 0.40) = 1.20
      expect(pnl).toBe(1.20);
    });

    test('uses entry_price as fallback', () => {
      const signalRecord = { entry_price: 0.50 };
      const pnl = logger.calculatePnL(signalRecord, 1, 1);

      // Won: 1 - 0.50 = 0.50
      expect(pnl).toBe(0.50);
    });

    test('uses 0.5 default when no price available', () => {
      const signalRecord = {};
      const pnl = logger.calculatePnL(signalRecord, 1, 1);

      // Won: 1 - 0.50 = 0.50
      expect(pnl).toBe(0.50);
    });
  });

  describe('getStats', () => {
    test('returns stats structure', async () => {
      const stats = await logger.getStats();

      expect(stats).toHaveProperty('total_signals');
      expect(stats).toHaveProperty('signals_with_outcome');
      expect(stats).toHaveProperty('pending_outcomes');
      expect(stats).toHaveProperty('win_rate');
      expect(stats).toHaveProperty('total_pnl');
      expect(stats).toHaveProperty('avg_confidence');
    });

    test('returns zero stats when empty', async () => {
      const stats = await logger.getStats();

      expect(stats.total_signals).toBe(0);
      expect(stats.win_rate).toBe(0);
    });

    test('handles database error gracefully', async () => {
      mockDb.get.mockRejectedValue(new Error('Database error'));

      const stats = await logger.getStats();

      expect(stats.total_signals).toBe(0);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  describe('getStatsByBucket', () => {
    test('returns array for time_to_expiry bucket', async () => {
      const stats = await logger.getStatsByBucket(BucketType.TIME_TO_EXPIRY);

      expect(Array.isArray(stats)).toBe(true);
    });

    test('returns array for staleness bucket', async () => {
      const stats = await logger.getStatsByBucket(BucketType.STALENESS);

      expect(Array.isArray(stats)).toBe(true);
    });

    test('returns array for confidence bucket', async () => {
      const stats = await logger.getStatsByBucket(BucketType.CONFIDENCE);

      expect(Array.isArray(stats)).toBe(true);
    });

    test('returns array for symbol bucket', async () => {
      const stats = await logger.getStatsByBucket(BucketType.SYMBOL);

      expect(Array.isArray(stats)).toBe(true);
    });

    test('returns empty array for unknown bucket type', async () => {
      const stats = await logger.getStatsByBucket('unknown');

      expect(stats).toEqual([]);
    });

    test('handles database error gracefully', async () => {
      mockDb.all.mockRejectedValue(new Error('Database error'));

      const stats = await logger.getStatsByBucket(BucketType.SYMBOL);

      expect(stats).toEqual([]);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  describe('getRecentSignals', () => {
    test('returns array of signals', async () => {
      const signals = await logger.getRecentSignals(10);

      expect(Array.isArray(signals)).toBe(true);
    });

    test('respects limit parameter', async () => {
      await logger.getRecentSignals(25);

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        [25]
      );
    });

    test('defaults to 50 limit', async () => {
      await logger.getRecentSignals();

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        [50]
      );
    });

    test('handles database error gracefully', async () => {
      mockDb.all.mockRejectedValue(new Error('Database error'));

      const signals = await logger.getRecentSignals(10);

      expect(signals).toEqual([]);
      expect(mockLog.error).toHaveBeenCalled();
    });

    test('clamps negative limit to minimum', async () => {
      await logger.getRecentSignals(-10);

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        [1]
      );
      expect(mockLog.debug).toHaveBeenCalledWith('limit_clamped', expect.any(Object));
    });

    test('clamps excessive limit to maximum', async () => {
      await logger.getRecentSignals(5000);

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        [1000]
      );
      expect(mockLog.debug).toHaveBeenCalledWith('limit_clamped', expect.any(Object));
    });

    test('handles non-number limit gracefully', async () => {
      await logger.getRecentSignals('invalid');

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        [50]  // Falls back to default
      );
    });
  });

  describe('subscribeToSignals', () => {
    test('subscribes to signal module', () => {
      const mockModule = {
        subscribe: vi.fn(() => () => {}),
      };

      logger.subscribeToSignals(mockModule);

      expect(mockModule.subscribe).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith('signal_subscription_active');
    });

    test('logs signal when callback is invoked', async () => {
      let capturedCallback;
      const mockModule = {
        subscribe: vi.fn(cb => {
          capturedCallback = cb;
          return () => {};
        }),
      };

      logger.subscribeToSignals(mockModule);

      // Simulate signal
      await capturedCallback(createSignal());

      expect(mockDb.run).toHaveBeenCalled();
    });

    test('handles null module gracefully', () => {
      logger.subscribeToSignals(null);

      expect(mockLog.warn).toHaveBeenCalledWith('signal_subscription_failed', expect.any(Object));
    });

    test('handles module without subscribe function', () => {
      logger.subscribeToSignals({});

      expect(mockLog.warn).toHaveBeenCalledWith('signal_subscription_failed', expect.any(Object));
    });

    test('handles subscription error', () => {
      const mockModule = {
        subscribe: vi.fn(() => {
          throw new Error('Subscription failed');
        }),
      };

      logger.subscribeToSignals(mockModule);

      expect(mockLog.warn).toHaveBeenCalledWith('signal_subscription_failed', expect.any(Object));
    });
  });

  describe('subscribeToSettlements', () => {
    test('subscribes to settlements', () => {
      const subscribeFn = vi.fn(() => () => {});

      logger.subscribeToSettlements(subscribeFn);

      expect(subscribeFn).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith('settlement_subscription_active');
    });

    test('handles null subscribe function', () => {
      logger.subscribeToSettlements(null);

      expect(mockLog.warn).toHaveBeenCalledWith('settlement_subscription_failed', expect.any(Object));
    });

    test('handles non-function parameter', () => {
      logger.subscribeToSettlements({});

      expect(mockLog.warn).toHaveBeenCalledWith('settlement_subscription_failed', expect.any(Object));
    });
  });

  describe('clearSubscriptions', () => {
    test('clears signal subscription', () => {
      const unsubscribe = vi.fn();
      const mockModule = {
        subscribe: vi.fn(() => unsubscribe),
      };

      logger.subscribeToSignals(mockModule);
      logger.clearSubscriptions();

      expect(unsubscribe).toHaveBeenCalled();
      expect(logger.subscriptions.signalGenerator).toBeNull();
    });

    test('clears settlement subscription', () => {
      const unsubscribe = vi.fn();
      const subscribeFn = vi.fn(() => unsubscribe);

      logger.subscribeToSettlements(subscribeFn);
      logger.clearSubscriptions();

      expect(unsubscribe).toHaveBeenCalled();
      expect(logger.subscriptions.settlements).toBeNull();
    });

    test('handles missing subscriptions gracefully', () => {
      expect(() => logger.clearSubscriptions()).not.toThrow();
    });
  });

  describe('getInternalStats', () => {
    test('returns internal stats', async () => {
      await logger.logSignal(createSignal());

      const stats = logger.getInternalStats();

      expect(stats).toHaveProperty('signals_logged');
      expect(stats).toHaveProperty('outcomes_updated');
      expect(stats).toHaveProperty('errors');
    });

    test('returns copy of stats', async () => {
      const stats1 = logger.getInternalStats();
      const stats2 = logger.getInternalStats();

      expect(stats1).not.toBe(stats2);
    });
  });
});
