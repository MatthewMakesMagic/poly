/**
 * Trade Event Logic Tests
 *
 * Tests for the core business logic: latency calculations, slippage calculations,
 * and database operations.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database before importing logic
const mockDb = {
  run: vi.fn().mockReturnValue({ lastInsertRowid: 1, changes: 1 }),
  get: vi.fn(),
  all: vi.fn().mockReturnValue([]),
};

vi.mock('../../../persistence/database.js', () => ({
  run: (...args) => mockDb.run(...args),
  get: (...args) => mockDb.get(...args),
  all: (...args) => mockDb.all(...args),
}));

// Import after mocks
import {
  calculateLatencies,
  calculateSlippage,
  insertTradeEvent,
  getEventById,
  queryEvents,
  queryEventsByWindow,
  queryEventsByPosition,
  validateRequiredFields,
  positionExists,
} from '../logic.js';
import { TradeEventErrorCodes } from '../types.js';
import { resetState } from '../state.js';

describe('Trade Event Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    mockDb.run.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    mockDb.get.mockReturnValue(undefined);
    mockDb.all.mockReturnValue([]);
  });

  describe('calculateLatencies()', () => {
    it('should calculate all latencies correctly', () => {
      const timestamps = {
        signalDetectedAt: '2026-01-31T10:00:00.000Z',
        orderSubmittedAt: '2026-01-31T10:00:00.100Z',
        orderAckedAt: '2026-01-31T10:00:00.200Z',
        orderFilledAt: '2026-01-31T10:00:00.350Z',
      };

      const latencies = calculateLatencies(timestamps);

      expect(latencies.latency_decision_to_submit_ms).toBe(100);
      expect(latencies.latency_submit_to_ack_ms).toBe(100);
      expect(latencies.latency_ack_to_fill_ms).toBe(150);
      expect(latencies.latency_total_ms).toBe(350);
    });

    it('should handle missing orderAckedAt', () => {
      const timestamps = {
        signalDetectedAt: '2026-01-31T10:00:00.000Z',
        orderSubmittedAt: '2026-01-31T10:00:00.100Z',
        orderFilledAt: '2026-01-31T10:00:00.350Z',
      };

      const latencies = calculateLatencies(timestamps);

      expect(latencies.latency_decision_to_submit_ms).toBe(100);
      expect(latencies.latency_submit_to_ack_ms).toBeNull();
      expect(latencies.latency_ack_to_fill_ms).toBeNull();
      expect(latencies.latency_total_ms).toBe(350);
    });

    it('should handle missing orderFilledAt', () => {
      const timestamps = {
        signalDetectedAt: '2026-01-31T10:00:00.000Z',
        orderSubmittedAt: '2026-01-31T10:00:00.100Z',
        orderAckedAt: '2026-01-31T10:00:00.200Z',
      };

      const latencies = calculateLatencies(timestamps);

      expect(latencies.latency_decision_to_submit_ms).toBe(100);
      expect(latencies.latency_submit_to_ack_ms).toBe(100);
      expect(latencies.latency_ack_to_fill_ms).toBeNull();
      expect(latencies.latency_total_ms).toBeNull();
    });

    it('should handle empty timestamps', () => {
      const latencies = calculateLatencies({});

      expect(latencies.latency_decision_to_submit_ms).toBeNull();
      expect(latencies.latency_submit_to_ack_ms).toBeNull();
      expect(latencies.latency_ack_to_fill_ms).toBeNull();
      expect(latencies.latency_total_ms).toBeNull();
    });

    it('should handle large latencies (slow fills)', () => {
      const timestamps = {
        signalDetectedAt: '2026-01-31T10:00:00.000Z',
        orderSubmittedAt: '2026-01-31T10:00:00.500Z',
        orderAckedAt: '2026-01-31T10:00:02.000Z',
        orderFilledAt: '2026-01-31T10:00:05.000Z',
      };

      const latencies = calculateLatencies(timestamps);

      expect(latencies.latency_decision_to_submit_ms).toBe(500);
      expect(latencies.latency_submit_to_ack_ms).toBe(1500);
      expect(latencies.latency_ack_to_fill_ms).toBe(3000);
      expect(latencies.latency_total_ms).toBe(5000);
    });
  });

  describe('calculateSlippage()', () => {
    it('should calculate slippage correctly for positive slippage', () => {
      const prices = {
        priceAtSignal: 0.50,
        priceAtFill: 0.51,
        expectedPrice: 0.50,
      };

      const slippage = calculateSlippage(prices);

      expect(slippage.slippage_signal_to_fill).toBeCloseTo(0.01);
      expect(slippage.slippage_vs_expected).toBeCloseTo(0.01);
    });

    it('should calculate slippage correctly for negative slippage (improvement)', () => {
      const prices = {
        priceAtSignal: 0.50,
        priceAtFill: 0.49,
        expectedPrice: 0.50,
      };

      const slippage = calculateSlippage(prices);

      expect(slippage.slippage_signal_to_fill).toBeCloseTo(-0.01);
      expect(slippage.slippage_vs_expected).toBeCloseTo(-0.01);
    });

    it('should handle zero slippage', () => {
      const prices = {
        priceAtSignal: 0.50,
        priceAtFill: 0.50,
        expectedPrice: 0.50,
      };

      const slippage = calculateSlippage(prices);

      expect(slippage.slippage_signal_to_fill).toBe(0);
      expect(slippage.slippage_vs_expected).toBe(0);
    });

    it('should handle missing prices', () => {
      const prices = {
        priceAtSignal: 0.50,
        // Missing priceAtFill and expectedPrice
      };

      const slippage = calculateSlippage(prices);

      expect(slippage.slippage_signal_to_fill).toBeNull();
      expect(slippage.slippage_vs_expected).toBeNull();
    });

    it('should handle different expected vs signal prices', () => {
      const prices = {
        priceAtSignal: 0.50,
        priceAtFill: 0.52,
        expectedPrice: 0.51, // Expected different from signal
      };

      const slippage = calculateSlippage(prices);

      expect(slippage.slippage_signal_to_fill).toBeCloseTo(0.02); // 0.52 - 0.50
      expect(slippage.slippage_vs_expected).toBeCloseTo(0.01); // 0.52 - 0.51
    });
  });

  describe('insertTradeEvent()', () => {
    it('should insert record and return event ID', () => {
      mockDb.run.mockReturnValue({ lastInsertRowid: 42, changes: 1 });

      const eventId = insertTradeEvent({
        event_type: 'entry',
        window_id: 'window-123',
        module: 'trade-event',
        level: 'info',
        event: 'trade_entry',
      });

      expect(eventId).toBe(42);
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO trade_events'),
        expect.any(Array)
      );
    });

    it('should handle all optional fields as null', () => {
      insertTradeEvent({
        event_type: 'signal',
        window_id: 'window-123',
        module: 'trade-event',
        level: 'info',
        event: 'trade_signal',
      });

      const params = mockDb.run.mock.calls[0][1];
      // Most optional fields should be null
      expect(params.filter(p => p === null).length).toBeGreaterThan(10);
    });

    it('should serialize notes as JSON', () => {
      insertTradeEvent({
        event_type: 'exit',
        window_id: 'window-123',
        module: 'trade-event',
        level: 'info',
        event: 'trade_exit',
        notes: { exit_reason: 'stop_loss', pnl: -50 },
      });

      const params = mockDb.run.mock.calls[0][1];
      // Find the notes parameter (should be JSON string)
      expect(params.some(p => typeof p === 'string' && p.includes('stop_loss'))).toBe(true);
    });

    it('should serialize diagnostic_flags as JSON', () => {
      insertTradeEvent({
        event_type: 'alert',
        window_id: 'window-123',
        module: 'trade-event',
        level: 'warn',
        event: 'trade_alert',
        diagnostic_flags: ['high_slippage', 'latency_spike'],
      });

      const params = mockDb.run.mock.calls[0][1];
      expect(params.some(p => typeof p === 'string' && p.includes('high_slippage'))).toBe(true);
    });
  });

  describe('getEventById()', () => {
    it('should return event with parsed JSON fields', () => {
      mockDb.get.mockReturnValue({
        id: 1,
        event_type: 'exit',
        notes: '{"exit_reason":"stop_loss"}',
        diagnostic_flags: '["high_slippage"]',
      });

      const event = getEventById(1);

      expect(event.notes).toEqual({ exit_reason: 'stop_loss' });
      expect(event.diagnostic_flags).toEqual(['high_slippage']);
    });

    it('should return undefined for non-existent event', () => {
      mockDb.get.mockReturnValue(undefined);

      const event = getEventById(999);

      expect(event).toBeUndefined();
    });

    it('should handle null JSON fields', () => {
      mockDb.get.mockReturnValue({
        id: 1,
        event_type: 'signal',
        notes: null,
        diagnostic_flags: null,
      });

      const event = getEventById(1);

      expect(event.notes).toBeNull();
      expect(event.diagnostic_flags).toBeNull();
    });
  });

  describe('queryEvents()', () => {
    it('should query with default options', () => {
      mockDb.all.mockReturnValue([
        { id: 1, event_type: 'entry' },
        { id: 2, event_type: 'exit' },
      ]);

      const events = queryEvents();

      expect(events).toHaveLength(2);
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT ? OFFSET ?'),
        [100, 0]
      );
    });

    it('should filter by eventType', () => {
      queryEvents({ eventType: 'entry' });

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('event_type = ?'),
        expect.arrayContaining(['entry'])
      );
    });

    it('should filter by level', () => {
      queryEvents({ level: 'warn' });

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('level = ?'),
        expect.arrayContaining(['warn'])
      );
    });

    it('should apply custom limit and offset', () => {
      queryEvents({ limit: 50, offset: 100 });

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([50, 100])
      );
    });

    it('should parse JSON fields in results', () => {
      mockDb.all.mockReturnValue([
        { id: 1, notes: '{"key":"value"}', diagnostic_flags: '["flag1"]' },
      ]);

      const events = queryEvents();

      expect(events[0].notes).toEqual({ key: 'value' });
      expect(events[0].diagnostic_flags).toEqual(['flag1']);
    });
  });

  describe('queryEventsByWindow()', () => {
    it('should query events for specific window', () => {
      mockDb.all.mockReturnValue([
        { id: 1, window_id: 'w1' },
        { id: 2, window_id: 'w1' },
      ]);

      const events = queryEventsByWindow('w1');

      expect(events).toHaveLength(2);
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        ['w1']
      );
    });

    it('should order by id ascending', () => {
      queryEventsByWindow('w1');

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY id ASC'),
        expect.any(Array)
      );
    });
  });

  describe('queryEventsByPosition()', () => {
    it('should query events for specific position', () => {
      mockDb.all.mockReturnValue([
        { id: 1, position_id: 1 },
        { id: 2, position_id: 1 },
      ]);

      const events = queryEventsByPosition(1);

      expect(events).toHaveLength(2);
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('position_id = ?'),
        [1]
      );
    });
  });

  describe('validateRequiredFields()', () => {
    it('should not throw when all required fields present', () => {
      expect(() => {
        validateRequiredFields(
          { windowId: 'w1', strategyId: 's1' },
          ['windowId', 'strategyId']
        );
      }).not.toThrow();
    });

    it('should throw when required field is missing', () => {
      expect(() => {
        validateRequiredFields({ windowId: 'w1' }, ['windowId', 'strategyId']);
      }).toThrow('Missing required field: strategyId');
    });

    it('should throw when required field is null', () => {
      expect(() => {
        validateRequiredFields({ windowId: null }, ['windowId']);
      }).toThrow('Missing required field: windowId');
    });

    it('should throw when required field is undefined', () => {
      expect(() => {
        validateRequiredFields({ windowId: undefined }, ['windowId']);
      }).toThrow('Missing required field');
    });
  });

  describe('positionExists()', () => {
    it('should return true when position exists', () => {
      mockDb.get.mockReturnValue({ id: 1 });

      const exists = positionExists(1);

      expect(exists).toBe(true);
      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM positions'),
        [1]
      );
    });

    it('should return false when position does not exist', () => {
      mockDb.get.mockReturnValue(undefined);

      const exists = positionExists(999);

      expect(exists).toBe(false);
    });
  });
});
