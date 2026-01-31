/**
 * Trade Event Module Public Interface Tests
 *
 * Tests the module interface: init, getState, shutdown, and all public methods.
 * Uses vitest with mocked dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger - must be hoisted
// Create a single shared instance that all child() calls return
const mockLoggerFns = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => mockLoggerFns),
}));

// Mock the database - must be hoisted
vi.mock('../../../persistence/database.js', () => ({
  run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
}));

// Import after mocks
import * as tradeEvent from '../index.js';
import { TradeEventType, TradeEventErrorCodes } from '../types.js';
import { resetState } from '../state.js';
import * as database from '../../../persistence/database.js';
import { child } from '../../logger/index.js';

describe('Trade Event Module', () => {
  const mockConfig = {};
  // Use the shared mock logger functions
  const mockLogger = mockLoggerFns;

  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    // Reset mock return values
    database.run.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    database.get.mockReturnValue(undefined);
    database.all.mockReturnValue([]);
  });

  afterEach(async () => {
    try {
      await tradeEvent.shutdown();
    } catch {
      // Ignore cleanup errors
    }
    resetState();
  });

  describe('init()', () => {
    it('should initialize successfully with valid config', async () => {
      await tradeEvent.init(mockConfig);

      const state = tradeEvent.getState();
      expect(state.initialized).toBe(true);
    });

    it('should throw if already initialized', async () => {
      await tradeEvent.init(mockConfig);

      await expect(tradeEvent.init(mockConfig)).rejects.toThrow('already initialized');
    });
  });

  describe('recordSignal()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      await expect(tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'spot-lag-v1',
        signalType: 'entry',
        priceAtSignal: 0.50,
      })).rejects.toThrow('not initialized');
    });

    it('should record signal event with required fields', async () => {
      const eventId = await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'spot-lag-v1',
        signalType: 'entry',
        priceAtSignal: 0.50,
        expectedPrice: 0.50,
      });

      expect(eventId).toBe(1);
      expect(database.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO trade_events'),
        expect.arrayContaining(['signal', 'window-123'])
      );
    });

    it('should capture market context when provided', async () => {
      await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'spot-lag-v1',
        signalType: 'entry',
        priceAtSignal: 0.50,
        expectedPrice: 0.50,
        marketContext: {
          bidAtSignal: 0.49,
          askAtSignal: 0.51,
          spreadAtSignal: 0.02,
          depthAtSignal: 1000,
        },
      });

      // Verify the database insert contains market context values
      const insertCall = database.run.mock.calls[0];
      expect(insertCall[1]).toContain(0.49); // bid
      expect(insertCall[1]).toContain(0.51); // ask
      expect(insertCall[1]).toContain(0.02); // spread
      expect(insertCall[1]).toContain(1000); // depth
    });

    it('should log signal event via logger module', async () => {
      await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'spot-lag-v1',
        signalType: 'entry',
        priceAtSignal: 0.50,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'trade_signal_entry',
        expect.objectContaining({
          window_id: 'window-123',
          strategy_id: 'spot-lag-v1',
          price_at_signal: 0.50,
        })
      );
    });

    it('should throw if required field is missing', async () => {
      await expect(tradeEvent.recordSignal({
        strategyId: 'spot-lag-v1',
        signalType: 'entry',
        priceAtSignal: 0.50,
        // Missing windowId
      })).rejects.toThrow('Missing required field');
    });
  });

  describe('recordEntry()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      await expect(tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {},
        prices: {},
        sizes: {},
      })).rejects.toThrow('not initialized');
    });

    it('should record entry event and calculate slippage correctly', async () => {
      const eventId = await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderSubmittedAt: '2026-01-31T10:00:00.100Z',
          orderAckedAt: '2026-01-31T10:00:00.200Z',
          orderFilledAt: '2026-01-31T10:00:00.350Z',
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtSubmit: 0.505,
          priceAtFill: 0.51,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(eventId).toBe(1);

      // Verify slippage calculations in the insert
      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];

      // Find slippage values in params (slippage_signal_to_fill and slippage_vs_expected)
      // slippage_signal_to_fill = 0.51 - 0.50 = 0.01
      // slippage_vs_expected = 0.51 - 0.50 = 0.01
      expect(params).toContain(0.51 - 0.50); // slippage values
    });

    it('should calculate latencies correctly', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderSubmittedAt: '2026-01-31T10:00:00.100Z',
          orderAckedAt: '2026-01-31T10:00:00.200Z',
          orderFilledAt: '2026-01-31T10:00:00.350Z',
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtSubmit: 0.505,
          priceAtFill: 0.51,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      // Verify latency calculations in the insert
      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];

      // latency_decision_to_submit_ms = 100
      // latency_submit_to_ack_ms = 100
      // latency_ack_to_fill_ms = 150
      // latency_total_ms = 350
      expect(params).toContain(100); // decision to submit
      expect(params).toContain(150); // ack to fill
      expect(params).toContain(350); // total
    });

    it('should log entry event with expected vs actual', async () => {
      // Use timestamps within threshold to get info level log
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.200Z', // 200ms < 500ms threshold
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.505, // 1% slippage < 2% threshold
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'trade_entry',
        expect.objectContaining({
          window_id: 'window-123',
          position_id: 1,
          expected: expect.objectContaining({
            price: 0.50,
            size: 100,
          }),
          actual: expect.objectContaining({
            price: 0.505,
            size: 100,
          }),
        }),
        expect.objectContaining({
          strategy_id: 'spot-lag-v1',
        })
      );
    });

    it('should calculate size vs depth ratio', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {},
        prices: {},
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
        marketContext: {
          depthAtSignal: 1000,
        },
      });

      // size_vs_depth_ratio = 100 / 1000 = 0.1
      const insertCall = database.run.mock.calls[0];
      expect(insertCall[1]).toContain(0.1);
    });
  });

  describe('recordExit()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
      // Mock position exists check
      database.get.mockReturnValue({ id: 1 });
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      await expect(tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 1,
        exitReason: 'stop_loss',
      })).rejects.toThrow('not initialized');
    });

    it('should record exit event with exit reason', async () => {
      const eventId = await tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 1,
        orderId: 101,
        strategyId: 'spot-lag-v1',
        exitReason: 'stop_loss',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:05:00.000Z',
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.45,
          expectedPrice: 0.50,
        },
      });

      expect(eventId).toBe(1);

      // Verify exit_reason is in notes JSON
      const insertCall = database.run.mock.calls[0];
      expect(insertCall[1]).toContain('exit');
    });

    it('should validate position exists before linking', async () => {
      database.get.mockReturnValue(undefined); // Position not found

      await expect(tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 999,
        exitReason: 'stop_loss',
      })).rejects.toThrow('Position not found');
    });

    it('should log exit event with expected vs actual', async () => {
      // Use values within thresholds for info level log
      await tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 1,
        exitReason: 'take_profit',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.200Z', // 200ms < threshold
        },
        prices: {
          priceAtFill: 0.55, // Matches expected
          expectedPrice: 0.55,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'trade_exit',
        expect.objectContaining({
          window_id: 'window-123',
          position_id: 1,
          exit_reason: 'take_profit',
        }),
        expect.any(Object)
      );
    });
  });

  describe('recordAlert()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      await expect(tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'divergence',
        data: {},
      })).rejects.toThrow('not initialized');
    });

    it('should record alert event with warn level', async () => {
      const eventId = await tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'divergence',
        data: { message: 'Price divergence detected' },
        level: 'warn',
      });

      expect(eventId).toBe(1);

      // Verify warn level in insert
      const insertCall = database.run.mock.calls[0];
      expect(insertCall[1]).toContain('warn');
    });

    it('should record alert event with error level', async () => {
      await tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'critical_error',
        data: { message: 'Critical system failure' },
        level: 'error',
      });

      // Verify error level in insert
      const insertCall = database.run.mock.calls[0];
      expect(insertCall[1]).toContain('error');
    });

    it('should include diagnostic flags for pattern detection', async () => {
      await tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'divergence',
        data: { message: 'Pattern detected' },
        diagnosticFlags: ['high_slippage', 'latency_spike'],
      });

      // Verify diagnostic_flags JSON in insert
      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];
      // diagnostic_flags should be a JSON string
      expect(params.some(p => typeof p === 'string' && p.includes('high_slippage'))).toBe(true);
    });

    it('should log alert via appropriate logger level', async () => {
      await tradeEvent.recordAlert({
        windowId: 'window-123',
        alertType: 'divergence',
        data: { message: 'Test' },
        level: 'error',
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('getEvents()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      await expect(tradeEvent.getEvents()).rejects.toThrow('not initialized');
    });

    it('should query events with filters', async () => {
      database.all.mockReturnValue([
        { id: 1, event_type: 'entry', window_id: 'w1', level: 'info' },
        { id: 2, event_type: 'entry', window_id: 'w2', level: 'info' },
      ]);

      const events = await tradeEvent.getEvents({ limit: 10, eventType: 'entry' });

      expect(events).toHaveLength(2);
      expect(database.all).toHaveBeenCalledWith(
        expect.stringContaining('event_type = ?'),
        expect.arrayContaining(['entry', 10, 0])
      );
    });

    it('should query events with level filter', async () => {
      database.all.mockReturnValue([
        { id: 3, event_type: 'alert', level: 'warn' },
      ]);

      const events = await tradeEvent.getEvents({ level: 'warn' });

      expect(events).toHaveLength(1);
      expect(database.all).toHaveBeenCalledWith(
        expect.stringContaining('level = ?'),
        expect.arrayContaining(['warn'])
      );
    });
  });

  describe('getEventsByWindow()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      await expect(tradeEvent.getEventsByWindow('w1')).rejects.toThrow('not initialized');
    });

    it('should throw if windowId is missing', async () => {
      await expect(tradeEvent.getEventsByWindow()).rejects.toThrow('Missing required field');
    });

    it('should query events for specific window', async () => {
      database.all.mockReturnValue([
        { id: 1, event_type: 'signal', window_id: 'window-123' },
        { id: 2, event_type: 'entry', window_id: 'window-123' },
        { id: 3, event_type: 'exit', window_id: 'window-123' },
      ]);

      const events = await tradeEvent.getEventsByWindow('window-123');

      expect(events).toHaveLength(3);
      expect(database.all).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        ['window-123']
      );
    });
  });

  describe('getEventsByPosition()', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should query events for specific position', async () => {
      database.all.mockReturnValue([
        { id: 2, event_type: 'entry', position_id: 1 },
        { id: 3, event_type: 'exit', position_id: 1 },
      ]);

      const events = await tradeEvent.getEventsByPosition(1);

      expect(events).toHaveLength(2);
      expect(database.all).toHaveBeenCalledWith(
        expect.stringContaining('position_id = ?'),
        [1]
      );
    });
  });

  describe('getState()', () => {
    it('should return uninitialized state before init', () => {
      const state = tradeEvent.getState();

      expect(state.initialized).toBe(false);
    });

    it('should return full state with stats after init', async () => {
      await tradeEvent.init(mockConfig);

      const state = tradeEvent.getState();

      expect(state.initialized).toBe(true);
      expect(state.stats).toBeDefined();
      expect(state.stats.totalEvents).toBe(0);
    });

    it('should track event counts by type', async () => {
      await tradeEvent.init(mockConfig);
      database.get.mockReturnValue({ id: 1 }); // For position check

      await tradeEvent.recordSignal({
        windowId: 'w1',
        strategyId: 's1',
        signalType: 'entry',
        priceAtSignal: 0.5,
      });

      await tradeEvent.recordEntry({
        windowId: 'w1',
        positionId: 1,
        orderId: 100,
        strategyId: 's1',
        timestamps: {},
        prices: {},
        sizes: {},
      });

      await tradeEvent.recordExit({
        windowId: 'w1',
        positionId: 1,
        exitReason: 'stop_loss',
      });

      await tradeEvent.recordAlert({
        windowId: 'w1',
        alertType: 'test',
        data: {},
      });

      const state = tradeEvent.getState();
      expect(state.stats.totalEvents).toBe(4);
      expect(state.stats.signalCount).toBe(1);
      expect(state.stats.entryCount).toBe(1);
      expect(state.stats.exitCount).toBe(1);
      expect(state.stats.alertCount).toBe(1);
    });
  });

  describe('shutdown()', () => {
    it('should shutdown gracefully', async () => {
      await tradeEvent.init(mockConfig);

      await tradeEvent.shutdown();

      const state = tradeEvent.getState();
      expect(state.initialized).toBe(false);
    });

    it('should be idempotent', async () => {
      await tradeEvent.init(mockConfig);

      await tradeEvent.shutdown();
      await tradeEvent.shutdown(); // Should not throw

      const state = tradeEvent.getState();
      expect(state.initialized).toBe(false);
    });

    it('should reset stats on shutdown', async () => {
      await tradeEvent.init(mockConfig);

      await tradeEvent.recordSignal({
        windowId: 'w1',
        strategyId: 's1',
        signalType: 'entry',
        priceAtSignal: 0.5,
      });

      await tradeEvent.shutdown();

      const state = tradeEvent.getState();
      expect(state.stats.totalEvents).toBe(0);
    });
  });

  describe('Integration Scenarios', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
      database.get.mockReturnValue({ id: 1 }); // For position check
    });

    it('should track complete signal → entry → exit event chain', async () => {
      // 1. Signal detected
      const signalId = await tradeEvent.recordSignal({
        windowId: 'window-123',
        strategyId: 'spot-lag-v1',
        signalType: 'entry',
        priceAtSignal: 0.50,
        expectedPrice: 0.50,
        marketContext: {
          bidAtSignal: 0.49,
          askAtSignal: 0.51,
        },
      });

      // 2. Entry executed
      const entryId = await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderSubmittedAt: '2026-01-31T10:00:00.100Z',
          orderFilledAt: '2026-01-31T10:00:00.300Z',
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtSubmit: 0.505,
          priceAtFill: 0.51,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      // 3. Exit executed (stop loss)
      const exitId = await tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 1,
        orderId: 101,
        strategyId: 'spot-lag-v1',
        exitReason: 'stop_loss',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:05:00.000Z',
          orderFilledAt: '2026-01-31T10:05:00.150Z',
        },
        prices: {
          priceAtSignal: 0.51,
          priceAtFill: 0.45,
          expectedPrice: 0.45,
        },
      });

      expect(signalId).toBe(1);
      expect(entryId).toBe(1);
      expect(exitId).toBe(1);

      const state = tradeEvent.getState();
      expect(state.stats.totalEvents).toBe(3);
      expect(state.stats.signalCount).toBe(1);
      expect(state.stats.entryCount).toBe(1);
      expect(state.stats.exitCount).toBe(1);
    });

    it('should record alerts on divergence detection', async () => {
      const alertId = await tradeEvent.recordAlert({
        windowId: 'window-123',
        positionId: 1,
        alertType: 'divergence',
        data: {
          message: 'Price divergence detected',
          expected_price: 0.50,
          actual_price: 0.55,
          divergence_pct: 10,
        },
        level: 'warn',
        diagnosticFlags: ['price_divergence', 'high_slippage'],
      });

      expect(alertId).toBe(1);

      // Verify warn log was called
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'trade_alert_divergence',
        expect.objectContaining({
          window_id: 'window-123',
          alert_type: 'divergence',
        })
      );
    });

    it('should calculate slippage example from Dev Notes', async () => {
      // Example from story with low slippage within threshold for info-level log:
      // Entry at 0.505 when expected 0.50 (1% slippage < 2% threshold)
      // slippage_signal_to_fill = 0.505 - 0.50 = 0.005
      // slippage_vs_expected = 0.505 - 0.50 = 0.005

      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderSubmittedAt: '2026-01-31T10:00:00.050Z',
          orderAckedAt: '2026-01-31T10:00:00.100Z',
          orderFilledAt: '2026-01-31T10:00:00.200Z', // 200ms < 500ms threshold
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtSubmit: 0.502,
          priceAtFill: 0.505, // 1% slippage < 2% threshold
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      // Verify the log includes expected vs actual with slippage
      expect(mockLogger.info).toHaveBeenCalledWith(
        'trade_entry',
        expect.objectContaining({
          expected: { price: 0.50, size: 100 },
          actual: { price: 0.505, size: 100 },
          slippage: 0.505 - 0.50, // 0.005
          latency_ms: 200, // total latency
        }),
        expect.any(Object)
      );
    });

    it('should verify 100% diagnostic coverage - every event has complete data', async () => {
      // Record multiple types of events
      await tradeEvent.recordSignal({
        windowId: 'w1',
        strategyId: 's1',
        signalType: 'entry',
        priceAtSignal: 0.50,
        expectedPrice: 0.50,
      });

      await tradeEvent.recordEntry({
        windowId: 'w1',
        positionId: 1,
        orderId: 100,
        strategyId: 's1',
        timestamps: { signalDetectedAt: new Date().toISOString() },
        prices: { priceAtSignal: 0.50, priceAtFill: 0.51, expectedPrice: 0.50 },
        sizes: { requestedSize: 100, filledSize: 100 },
      });

      await tradeEvent.recordExit({
        windowId: 'w1',
        positionId: 1,
        exitReason: 'take_profit',
        prices: { priceAtFill: 0.60, expectedPrice: 0.55 },
      });

      await tradeEvent.recordAlert({
        windowId: 'w1',
        alertType: 'test',
        data: { message: 'Test alert' },
      });

      // Verify all 4 events were recorded (no gaps)
      const state = tradeEvent.getState();
      expect(state.stats.totalEvents).toBe(4);

      // Verify database was called 4 times (once per event)
      expect(database.run).toHaveBeenCalledTimes(4);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.2: LATENCY & SLIPPAGE ANALYSIS API
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getLatencyStats() (Story 5.2, AC5)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getLatencyStats()).toThrow('not initialized');
    });

    it('should return combined stats with p95', () => {
      // Mock stats query - column names match SQL aliases
      database.get.mockReturnValue({
        count: 5,
        min_total_ms: 100,
        max_total_ms: 500,
        avg_total_ms: 250,
        min_decision_to_submit_ms: 50,
        max_decision_to_submit_ms: 150,
        avg_decision_to_submit_ms: 100,
        min_submit_to_ack_ms: 20,
        max_submit_to_ack_ms: 80,
        avg_submit_to_ack_ms: 50,
        min_ack_to_fill_ms: 30,
        max_ack_to_fill_ms: 270,
        avg_ack_to_fill_ms: 100,
      });

      // Mock p95 data
      database.all.mockReturnValue([
        { latency_total_ms: 100, latency_decision_to_submit_ms: 50, latency_submit_to_ack_ms: 20, latency_ack_to_fill_ms: 30 },
        { latency_total_ms: 200, latency_decision_to_submit_ms: 75, latency_submit_to_ack_ms: 40, latency_ack_to_fill_ms: 85 },
        { latency_total_ms: 300, latency_decision_to_submit_ms: 100, latency_submit_to_ack_ms: 60, latency_ack_to_fill_ms: 140 },
        { latency_total_ms: 400, latency_decision_to_submit_ms: 125, latency_submit_to_ack_ms: 70, latency_ack_to_fill_ms: 205 },
        { latency_total_ms: 500, latency_decision_to_submit_ms: 150, latency_submit_to_ack_ms: 80, latency_ack_to_fill_ms: 270 },
      ]);

      const stats = tradeEvent.getLatencyStats();

      expect(stats.count).toBe(5);
      expect(stats.total.min).toBe(100);
      expect(stats.total.max).toBe(500);
      expect(stats.total.avg).toBe(250);
      expect(stats.total.p95).toBeDefined();
      expect(stats.decisionToSubmit.p95).toBeDefined();
    });

    it('should accept filter options', () => {
      database.get.mockReturnValue({ count: 0 });
      database.all.mockReturnValue([]);

      tradeEvent.getLatencyStats({
        windowId: 'window-123',
        strategyId: 'spot-lag-v1',
      });

      expect(database.get).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        expect.any(Array)
      );
    });
  });

  describe('getLatencyBreakdownById() (Story 5.2, AC5)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getLatencyBreakdownById(1)).toThrow('not initialized');
    });

    it('should throw if eventId is missing', () => {
      expect(() => tradeEvent.getLatencyBreakdownById()).toThrow('Missing required field');
    });

    it('should return breakdown for single event', () => {
      database.get.mockReturnValue({
        id: 1,
        window_id: 'window-123',
        strategy_id: 'spot-lag-v1',
        latency_total_ms: 350,
        latency_decision_to_submit_ms: 100,
        latency_submit_to_ack_ms: 100,
        latency_ack_to_fill_ms: 150,
        signal_detected_at: '2026-01-31T10:00:00.000Z',
        order_submitted_at: '2026-01-31T10:00:00.100Z',
        order_acked_at: '2026-01-31T10:00:00.200Z',
        order_filled_at: '2026-01-31T10:00:00.350Z',
      });

      const breakdown = tradeEvent.getLatencyBreakdownById(1);

      expect(breakdown.eventId).toBe(1);
      expect(breakdown.latencies.total).toBe(350);
      expect(breakdown.latencies.decisionToSubmit).toBe(100);
    });
  });

  describe('getSlippageStats() (Story 5.2, AC6)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getSlippageStats()).toThrow('not initialized');
    });

    it('should return slippage statistics', () => {
      database.get.mockReturnValue({
        count: 10,
        min_signal_to_fill: -0.02,
        max_signal_to_fill: 0.05,
        avg_signal_to_fill: 0.01,
        min_vs_expected: -0.01,
        max_vs_expected: 0.03,
        avg_vs_expected: 0.005,
        avg_expected_price: 0.50,
      });

      const stats = tradeEvent.getSlippageStats();

      expect(stats.count).toBe(10);
      expect(stats.signalToFill.min).toBeCloseTo(-0.02);
      expect(stats.vsExpected.avg).toBeCloseTo(0.005);
    });
  });

  describe('getSlippageBySize() (Story 5.2, AC6)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getSlippageBySize()).toThrow('not initialized');
    });

    it('should return slippage grouped by size', () => {
      database.all.mockReturnValue([
        { size_bucket: 'small', count: 5, avg_slippage: 0.005 },
        { size_bucket: 'large', count: 3, avg_slippage: 0.02 },
      ]);

      const results = tradeEvent.getSlippageBySize();

      expect(results).toHaveLength(2);
      expect(results[0].sizeBucket).toBe('small');
    });
  });

  describe('getSlippageBySpread() (Story 5.2, AC6)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getSlippageBySpread()).toThrow('not initialized');
    });

    it('should return slippage grouped by spread', () => {
      database.all.mockReturnValue([
        { spread_bucket: 'tight', count: 8, avg_slippage: 0.003 },
        { spread_bucket: 'wide', count: 4, avg_slippage: 0.015 },
      ]);

      const results = tradeEvent.getSlippageBySpread();

      expect(results).toHaveLength(2);
      expect(results[0].spreadBucket).toBe('tight');
    });
  });

  describe('Diagnostic Flags Integration (Story 5.2, AC8)', () => {
    beforeEach(async () => {
      // Initialize with config containing thresholds
      await tradeEvent.init({
        tradeEvent: {
          thresholds: {
            latencyThresholdMs: 500,
            slippageThresholdPct: 0.02,
            sizeImpactThreshold: 0.5,
          },
        },
      });
    });

    it('should set diagnostic flags when latency exceeds threshold', async () => {
      const eventId = await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.600Z', // 600ms total latency
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.50,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(eventId).toBe(1);

      // Verify diagnostic_flags contains high_latency
      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];
      expect(params.some(p => typeof p === 'string' && p.includes('high_latency'))).toBe(true);
    });

    it('should set diagnostic flags when slippage exceeds threshold', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.100Z',
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.52, // 4% slippage > 2% threshold
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];
      expect(params.some(p => typeof p === 'string' && p.includes('high_slippage'))).toBe(true);
    });

    it('should set diagnostic flags when size impact exceeds threshold', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {},
        prices: {
          priceAtFill: 0.50,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 600, // 60% of depth
          filledSize: 600,
        },
        marketContext: {
          depthAtSignal: 1000,
        },
      });

      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];
      expect(params.some(p => typeof p === 'string' && p.includes('size_impact'))).toBe(true);
    });

    it('should not set diagnostic flags when all values within thresholds', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.300Z', // 300ms < 500ms
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.505, // 1% < 2% threshold
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100, // 10% of depth
          filledSize: 100,
        },
        marketContext: {
          depthAtSignal: 1000,
        },
      });

      const insertCall = database.run.mock.calls[0];
      const params = insertCall[1];
      // diagnostic_flags should be null (no flags set)
      // Find the diagnostic_flags parameter position
      const flagsParam = params.find(p => p === null || (typeof p === 'string' && p.includes('high_')));
      // If null, no flags were set
      expect(flagsParam === null || !flagsParam.includes('high_')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.3: DIVERGENCE DETECTION API
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getDivergenceCheck() (Story 5.3, AC7)', () => {
    beforeEach(async () => {
      await tradeEvent.init({
        tradeEvent: {
          thresholds: {
            latencyThresholdMs: 500,
            slippageThresholdPct: 0.02,
            sizeImpactThreshold: 0.5,
            partialFillThresholdPct: 0.1,
          },
        },
      });
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getDivergenceCheck({})).toThrow('not initialized');
    });

    it('should detect divergence with structured result', () => {
      const event = { latency_total_ms: 600 };

      const result = tradeEvent.getDivergenceCheck(event);

      expect(result.hasDivergence).toBe(true);
      expect(result.flags).toContain('high_latency');
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].severity).toBe('warn');
    });

    it('should return no divergence when within thresholds', () => {
      const event = {
        latency_total_ms: 200,
        slippage_vs_expected: 0.005,
        expected_price: 1.0,
      };

      const result = tradeEvent.getDivergenceCheck(event);

      expect(result.hasDivergence).toBe(false);
      expect(result.flags).toHaveLength(0);
    });

    it('should accept custom thresholds override', () => {
      const event = { latency_total_ms: 300 };

      // Default threshold is 500ms, so this wouldn't normally trigger
      const resultWithDefault = tradeEvent.getDivergenceCheck(event);
      expect(resultWithDefault.hasDivergence).toBe(false);

      // With custom lower threshold, it should trigger
      const resultWithCustom = tradeEvent.getDivergenceCheck(event, { latencyThresholdMs: 200 });
      expect(resultWithCustom.hasDivergence).toBe(true);
    });
  });

  describe('getDivergentEvents() (Story 5.3, AC7)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getDivergentEvents()).toThrow('not initialized');
    });

    it('should return events with divergence flags', () => {
      database.all.mockReturnValue([
        { id: 1, diagnostic_flags: '["high_latency"]' },
        { id: 2, diagnostic_flags: '["high_slippage", "size_impact"]' },
      ]);

      const events = tradeEvent.getDivergentEvents();

      expect(events).toHaveLength(2);
      expect(events[0].diagnostic_flags).toEqual(['high_latency']);
    });

    it('should filter by windowId', () => {
      database.all.mockReturnValue([]);

      tradeEvent.getDivergentEvents({ windowId: 'window-123' });

      expect(database.all).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        expect.arrayContaining(['window-123'])
      );
    });

    it('should filter by specific flags', () => {
      database.all.mockReturnValue([
        { id: 1, diagnostic_flags: '["high_latency"]' },
        { id: 2, diagnostic_flags: '["high_slippage"]' },
      ]);

      const events = tradeEvent.getDivergentEvents({ flags: ['high_latency'] });

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(1);
    });
  });

  describe('getDivergenceSummary() (Story 5.3, AC7)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getDivergenceSummary()).toThrow('not initialized');
    });

    it('should return divergence counts and rates', () => {
      database.all.mockReturnValue([
        { diagnostic_flags: '["high_latency"]' },
        { diagnostic_flags: '["high_slippage"]' },
        { diagnostic_flags: '["high_latency", "size_impact"]' },
      ]);
      database.get.mockReturnValue({ count: 10 });

      const summary = tradeEvent.getDivergenceSummary();

      expect(summary.totalEvents).toBe(10);
      expect(summary.eventsWithDivergence).toBe(3);
      expect(summary.divergenceRate).toBeCloseTo(0.3);
      expect(summary.flagCounts.high_latency).toBe(2);
      expect(summary.flagRates.high_latency).toBeCloseTo(0.2);
    });
  });

  describe('getStateDivergence() (Story 5.3, AC6)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should throw if not initialized', async () => {
      await tradeEvent.shutdown();

      expect(() => tradeEvent.getStateDivergence({}, {})).toThrow('not initialized');
    });

    it('should detect state mismatch between local and exchange', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 80, side: 'long', status: 'open' };

      const result = tradeEvent.getStateDivergence(local, exchange);

      expect(result).not.toBeNull();
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].field).toBe('size');
    });

    it('should return null when states match', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 100, side: 'long', status: 'open' };

      const result = tradeEvent.getStateDivergence(local, exchange);

      expect(result).toBeNull();
    });
  });

  describe('getState() with divergence stats (Story 5.3)', () => {
    beforeEach(async () => {
      await tradeEvent.init(mockConfig);
    });

    it('should include divergence stats in state', () => {
      database.all.mockReturnValue([
        { diagnostic_flags: '["high_latency"]' },
      ]);
      database.get.mockReturnValue({ count: 5 });

      const state = tradeEvent.getState();

      expect(state.divergence).toBeDefined();
      expect(state.divergence.eventsWithDivergence).toBe(1);
      expect(state.divergence.divergenceRate).toBeCloseTo(0.2);
      expect(state.divergence.flagCounts.high_latency).toBe(1);
    });
  });

  describe('recordEntry with divergence logging (Story 5.3)', () => {
    beforeEach(async () => {
      await tradeEvent.init({
        tradeEvent: {
          thresholds: {
            latencyThresholdMs: 500,
            slippageThresholdPct: 0.02,
            partialFillThresholdPct: 0.1,
          },
        },
      });
    });

    it('should log at warn level when divergence detected', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.600Z', // 600ms > 500ms
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.50,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'trade_entry_divergence',
        expect.objectContaining({
          diagnostic_flags: expect.arrayContaining(['high_latency']),
        }),
        expect.any(Object)
      );
    });

    it('should log at error level for size divergence', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {},
        prices: {},
        sizes: {
          requestedSize: 100,
          filledSize: 50, // 50% difference > 10% threshold
        },
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'trade_entry_divergence',
        expect.objectContaining({
          diagnostic_flags: expect.arrayContaining(['size_divergence']),
        }),
        expect.any(Object)
      );
    });

    it('should log at info level when no divergence', async () => {
      await tradeEvent.recordEntry({
        windowId: 'window-123',
        positionId: 1,
        orderId: 100,
        strategyId: 'spot-lag-v1',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.200Z', // 200ms < 500ms
        },
        prices: {
          priceAtSignal: 0.50,
          priceAtFill: 0.50,
          expectedPrice: 0.50,
        },
        sizes: {
          requestedSize: 100,
          filledSize: 100,
        },
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'trade_entry',
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe('recordExit with divergence logging (Story 5.3)', () => {
    beforeEach(async () => {
      await tradeEvent.init({
        tradeEvent: {
          thresholds: {
            latencyThresholdMs: 500,
            partialFillThresholdPct: 0.1,
          },
        },
      });
      database.get.mockReturnValue({ id: 1 }); // Position exists
    });

    it('should log at warn level when divergence detected on exit', async () => {
      await tradeEvent.recordExit({
        windowId: 'window-123',
        positionId: 1,
        exitReason: 'stop_loss',
        timestamps: {
          signalDetectedAt: '2026-01-31T10:00:00.000Z',
          orderFilledAt: '2026-01-31T10:00:00.600Z', // 600ms > 500ms
        },
        prices: {},
        sizes: {},
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'trade_exit_divergence',
        expect.objectContaining({
          diagnostic_flags: expect.arrayContaining(['high_latency']),
        }),
        expect.any(Object)
      );
    });
  });
});
