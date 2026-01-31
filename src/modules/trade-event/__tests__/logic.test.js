/**
 * Trade Event Logic Tests
 *
 * Tests for the core business logic: latency calculations, slippage calculations,
 * and database operations.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

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
  queryLatencyStats,
  calculateP95Latency,
  getLatencyBreakdown,
  querySlippageStats,
  querySlippageBySize,
  querySlippageBySpread,
  detectDiagnosticFlags,
  checkDivergence,
  detectStateDivergence,
  queryDivergentEvents,
  queryDivergenceSummary,
  // Story 5.4: Divergence Alerting
  getDivergenceSeverity,
  formatDivergenceAlert,
  shouldEscalate,
  alertOnDivergence,
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

    it('should handle invalid timestamp strings gracefully', () => {
      const timestamps = {
        signalDetectedAt: 'not-a-date',
        orderSubmittedAt: '2026-01-31T10:00:00.100Z',
        orderAckedAt: 'invalid',
        orderFilledAt: '2026-01-31T10:00:00.350Z',
      };

      const latencies = calculateLatencies(timestamps);

      // Invalid timestamps should be treated as null
      expect(latencies.latency_decision_to_submit_ms).toBeNull();
      expect(latencies.latency_submit_to_ack_ms).toBeNull();
      expect(latencies.latency_ack_to_fill_ms).toBeNull();
      expect(latencies.latency_total_ms).toBeNull();
    });

    it('should handle mixed valid and invalid timestamps', () => {
      const timestamps = {
        signalDetectedAt: '2026-01-31T10:00:00.000Z',
        orderSubmittedAt: '2026-01-31T10:00:00.100Z',
        orderAckedAt: 'garbage',
        orderFilledAt: '2026-01-31T10:00:00.350Z',
      };

      const latencies = calculateLatencies(timestamps);

      // Valid pairs should work
      expect(latencies.latency_decision_to_submit_ms).toBe(100);
      // Invalid ack means these are null
      expect(latencies.latency_submit_to_ack_ms).toBeNull();
      expect(latencies.latency_ack_to_fill_ms).toBeNull();
      // Total should work (signal to fill)
      expect(latencies.latency_total_ms).toBe(350);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.2: LATENCY & SLIPPAGE ANALYSIS FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('queryLatencyStats() (Story 5.2, AC5)', () => {
    it('should return min/max/avg latency stats', () => {
      mockDb.get.mockReturnValue({
        count: 10,
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

      const stats = queryLatencyStats();

      expect(stats.count).toBe(10);
      expect(stats.total.min).toBe(100);
      expect(stats.total.max).toBe(500);
      expect(stats.total.avg).toBe(250);
      expect(stats.decisionToSubmit.min).toBe(50);
      expect(stats.submitToAck.avg).toBe(50);
      expect(stats.ackToFill.max).toBe(270);
    });

    it('should filter by windowId', () => {
      mockDb.get.mockReturnValue({ count: 0 });

      queryLatencyStats({ windowId: 'window-123' });

      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        expect.arrayContaining(['window-123'])
      );
    });

    it('should filter by strategyId', () => {
      mockDb.get.mockReturnValue({ count: 0 });

      queryLatencyStats({ strategyId: 'spot-lag-v1' });

      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('strategy_id = ?'),
        expect.arrayContaining(['spot-lag-v1'])
      );
    });

    it('should filter by timeRange', () => {
      mockDb.get.mockReturnValue({ count: 0 });

      queryLatencyStats({
        timeRange: {
          startDate: '2026-01-01T00:00:00Z',
          endDate: '2026-01-31T23:59:59Z',
        },
      });

      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('signal_detected_at >= ?'),
        expect.arrayContaining(['2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z'])
      );
    });

    it('should return zeros when no data', () => {
      mockDb.get.mockReturnValue(null);

      const stats = queryLatencyStats();

      expect(stats.count).toBe(0);
      expect(stats.total.min).toBeNull();
      expect(stats.total.avg).toBeNull();
    });
  });

  describe('calculateP95Latency() (Story 5.2, AC5)', () => {
    it('should calculate p95 from latency values', () => {
      // Mock latency data - 20 events
      const latencies = Array.from({ length: 20 }, (_, i) => ({
        latency_total_ms: (i + 1) * 50, // 50, 100, 150, ..., 1000
        latency_decision_to_submit_ms: (i + 1) * 10,
        latency_submit_to_ack_ms: (i + 1) * 15,
        latency_ack_to_fill_ms: (i + 1) * 25,
      }));
      mockDb.all.mockReturnValue(latencies);

      const p95 = calculateP95Latency();

      // P95 of [50, 100, 150, ..., 1000] = 950 (19th element in sorted array)
      expect(p95.total).toBe(950);
      expect(p95.decisionToSubmit).toBe(190);
      expect(p95.submitToAck).toBe(285);
      expect(p95.ackToFill).toBe(475);
    });

    it('should return nulls when no data', () => {
      mockDb.all.mockReturnValue([]);

      const p95 = calculateP95Latency();

      expect(p95.total).toBeNull();
      expect(p95.decisionToSubmit).toBeNull();
      expect(p95.submitToAck).toBeNull();
      expect(p95.ackToFill).toBeNull();
    });

    it('should handle events with null latencies', () => {
      mockDb.all.mockReturnValue([
        { latency_total_ms: 100, latency_decision_to_submit_ms: null },
        { latency_total_ms: 200, latency_decision_to_submit_ms: 50 },
        { latency_total_ms: null, latency_decision_to_submit_ms: 75 },
      ]);

      const p95 = calculateP95Latency();

      // Only 2 non-null total values: 100, 200 -> p95 = 200
      expect(p95.total).toBe(200);
      // Only 2 non-null decisionToSubmit values: 50, 75 -> p95 = 75
      expect(p95.decisionToSubmit).toBe(75);
    });
  });

  describe('getLatencyBreakdown() (Story 5.2, AC5)', () => {
    it('should return detailed breakdown for single event', () => {
      mockDb.get.mockReturnValue({
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

      const breakdown = getLatencyBreakdown(1);

      expect(breakdown.eventId).toBe(1);
      expect(breakdown.latencies.total).toBe(350);
      expect(breakdown.latencies.decisionToSubmit).toBe(100);
      expect(breakdown.latencies.submitToAck).toBe(100);
      expect(breakdown.latencies.ackToFill).toBe(150);
      expect(breakdown.timestamps.signalDetectedAt).toBe('2026-01-31T10:00:00.000Z');
    });

    it('should return null for non-existent event', () => {
      mockDb.get.mockReturnValue(undefined);

      const breakdown = getLatencyBreakdown(999);

      expect(breakdown).toBeNull();
    });
  });

  describe('querySlippageStats() (Story 5.2, AC6)', () => {
    it('should return min/max/avg slippage stats', () => {
      mockDb.get.mockReturnValue({
        count: 10,
        min_signal_to_fill: -0.02,
        max_signal_to_fill: 0.05,
        avg_signal_to_fill: 0.01,
        min_vs_expected: -0.01,
        max_vs_expected: 0.03,
        avg_vs_expected: 0.005,
        avg_expected_price: 0.50,
      });

      const stats = querySlippageStats();

      expect(stats.count).toBe(10);
      expect(stats.signalToFill.min).toBeCloseTo(-0.02);
      expect(stats.signalToFill.max).toBeCloseTo(0.05);
      expect(stats.signalToFill.avg).toBeCloseTo(0.01);
      expect(stats.vsExpected.min).toBeCloseTo(-0.01);
      expect(stats.vsExpected.avg).toBeCloseTo(0.005);
    });

    it('should filter by windowId', () => {
      mockDb.get.mockReturnValue({ count: 0 });

      querySlippageStats({ windowId: 'window-123' });

      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        expect.arrayContaining(['window-123'])
      );
    });

    it('should return zeros when no data', () => {
      mockDb.get.mockReturnValue(null);

      const stats = querySlippageStats();

      expect(stats.count).toBe(0);
      expect(stats.signalToFill.min).toBeNull();
    });
  });

  describe('querySlippageBySize() (Story 5.2, AC6)', () => {
    it('should group slippage by size buckets', () => {
      mockDb.all.mockReturnValue([
        { size_bucket: 'small', count: 5, avg_slippage: 0.005, avg_size: 25, min_slippage: 0.001, max_slippage: 0.01 },
        { size_bucket: 'medium', count: 10, avg_slippage: 0.01, avg_size: 100, min_slippage: 0.005, max_slippage: 0.015 },
        { size_bucket: 'large', count: 3, avg_slippage: 0.02, avg_size: 300, min_slippage: 0.01, max_slippage: 0.03 },
      ]);

      const results = querySlippageBySize();

      expect(results).toHaveLength(3);
      expect(results[0].sizeBucket).toBe('small');
      expect(results[0].count).toBe(5);
      expect(results[0].slippage.avg).toBeCloseTo(0.005);
      expect(results[2].sizeBucket).toBe('large');
    });

    it('should use custom size bucket thresholds', () => {
      mockDb.all.mockReturnValue([]);

      querySlippageBySize({
        sizeBuckets: { small: 50, medium: 200 },
      });

      // The SQL uses parameterized queries with ?, not literal values
      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('WHEN requested_size < ?'),
        expect.arrayContaining([50, 200])
      );
    });
  });

  describe('querySlippageBySpread() (Story 5.2, AC6)', () => {
    it('should group slippage by spread buckets', () => {
      mockDb.all.mockReturnValue([
        { spread_bucket: 'tight', count: 8, avg_slippage: 0.003, avg_spread: 0.005, min_slippage: 0.001, max_slippage: 0.005 },
        { spread_bucket: 'normal', count: 6, avg_slippage: 0.008, avg_spread: 0.02, min_slippage: 0.005, max_slippage: 0.012 },
        { spread_bucket: 'wide', count: 4, avg_slippage: 0.015, avg_spread: 0.05, min_slippage: 0.01, max_slippage: 0.02 },
      ]);

      const results = querySlippageBySpread();

      expect(results).toHaveLength(3);
      expect(results[0].spreadBucket).toBe('tight');
      expect(results[2].spreadBucket).toBe('wide');
      expect(results[2].slippage.avg).toBeCloseTo(0.015);
    });
  });

  describe('detectDiagnosticFlags() (Story 5.2, AC8)', () => {
    it('should detect high_latency flag when threshold exceeded', () => {
      const event = { latency_total_ms: 600 };
      const flags = detectDiagnosticFlags(event, { latencyThresholdMs: 500 });

      expect(flags).toContain('high_latency');
    });

    it('should not flag latency below threshold', () => {
      const event = { latency_total_ms: 300 };
      const flags = detectDiagnosticFlags(event, { latencyThresholdMs: 500 });

      expect(flags).not.toContain('high_latency');
    });

    it('should detect high_slippage flag when threshold exceeded', () => {
      const event = {
        slippage_vs_expected: 0.015, // $0.015 slippage
        expected_price: 0.50, // 3% slippage
      };
      const flags = detectDiagnosticFlags(event, { slippageThresholdPct: 0.02 });

      expect(flags).toContain('high_slippage');
    });

    it('should not flag slippage below threshold', () => {
      const event = {
        slippage_vs_expected: 0.005, // $0.005 slippage
        expected_price: 0.50, // 1% slippage
      };
      const flags = detectDiagnosticFlags(event, { slippageThresholdPct: 0.02 });

      expect(flags).not.toContain('high_slippage');
    });

    it('should detect size_impact flag when threshold exceeded', () => {
      const event = { size_vs_depth_ratio: 0.6 };
      const flags = detectDiagnosticFlags(event, { sizeImpactThreshold: 0.5 });

      expect(flags).toContain('size_impact');
    });

    it('should not flag size impact below threshold', () => {
      const event = { size_vs_depth_ratio: 0.3 };
      const flags = detectDiagnosticFlags(event, { sizeImpactThreshold: 0.5 });

      expect(flags).not.toContain('size_impact');
    });

    it('should detect multiple flags simultaneously', () => {
      const event = {
        latency_total_ms: 700,
        slippage_vs_expected: 0.02,
        expected_price: 0.50,
        size_vs_depth_ratio: 0.8,
      };
      const flags = detectDiagnosticFlags(event, {
        latencyThresholdMs: 500,
        slippageThresholdPct: 0.02,
        sizeImpactThreshold: 0.5,
      });

      expect(flags).toContain('high_latency');
      expect(flags).toContain('high_slippage');
      expect(flags).toContain('size_impact');
      expect(flags).toHaveLength(3);
    });

    it('should return empty array when no thresholds exceeded', () => {
      const event = {
        latency_total_ms: 200,
        slippage_vs_expected: 0.005,
        expected_price: 0.50,
        size_vs_depth_ratio: 0.2,
      };
      const flags = detectDiagnosticFlags(event);

      expect(flags).toHaveLength(0);
    });

    it('should handle null values gracefully', () => {
      const event = {
        latency_total_ms: null,
        slippage_vs_expected: null,
        size_vs_depth_ratio: null,
      };
      const flags = detectDiagnosticFlags(event);

      expect(flags).toHaveLength(0);
    });

    it('should use default thresholds when not specified', () => {
      const event = {
        latency_total_ms: 600, // > 500ms default
        slippage_vs_expected: 0.015,
        expected_price: 0.50, // 3% > 2% default
        size_vs_depth_ratio: 0.6, // > 0.5 default
      };
      const flags = detectDiagnosticFlags(event);

      expect(flags).toContain('high_latency');
      expect(flags).toContain('high_slippage');
      expect(flags).toContain('size_impact');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STORY 5.3: EXTENDED DIVERGENCE DETECTION
    // ═══════════════════════════════════════════════════════════════════════

    it('should detect entry_slippage flag for entry events (Story 5.3)', () => {
      const event = {
        event_type: 'entry',
        slippage_signal_to_fill: 0.02, // $0.02 slippage
        price_at_signal: 0.50, // 4% slippage
      };
      const flags = detectDiagnosticFlags(event, { slippageThresholdPct: 0.02 });

      expect(flags).toContain('entry_slippage');
    });

    it('should not detect entry_slippage for non-entry events (Story 5.3)', () => {
      const event = {
        event_type: 'exit',
        slippage_signal_to_fill: 0.02,
        price_at_signal: 0.50,
      };
      const flags = detectDiagnosticFlags(event, { slippageThresholdPct: 0.02 });

      expect(flags).not.toContain('entry_slippage');
    });

    it('should detect size_divergence for partial fills (Story 5.3)', () => {
      const event = {
        requested_size: 100,
        filled_size: 80, // 20% difference > 10% threshold
      };
      const flags = detectDiagnosticFlags(event, { partialFillThresholdPct: 0.1 });

      expect(flags).toContain('size_divergence');
    });

    it('should not flag size_divergence when within tolerance (Story 5.3)', () => {
      const event = {
        requested_size: 100,
        filled_size: 95, // 5% difference < 10% threshold
      };
      const flags = detectDiagnosticFlags(event, { partialFillThresholdPct: 0.1 });

      expect(flags).not.toContain('size_divergence');
    });

    it('should detect individual latency component anomalies (Story 5.3)', () => {
      const event = {
        latency_decision_to_submit_ms: 150, // > 100ms threshold
        latency_submit_to_ack_ms: 250, // > 200ms threshold
        latency_ack_to_fill_ms: 400, // > 300ms threshold
      };
      const flags = detectDiagnosticFlags(event, {
        latencyComponentThresholds: {
          decisionToSubmitMs: 100,
          submitToAckMs: 200,
          ackToFillMs: 300,
        },
      });

      expect(flags).toContain('slow_decision_to_submit');
      expect(flags).toContain('slow_submit_to_ack');
      expect(flags).toContain('slow_ack_to_fill');
    });

    it('should not flag latency components within thresholds (Story 5.3)', () => {
      const event = {
        latency_decision_to_submit_ms: 50,
        latency_submit_to_ack_ms: 100,
        latency_ack_to_fill_ms: 200,
      };
      const flags = detectDiagnosticFlags(event, {
        latencyComponentThresholds: {
          decisionToSubmitMs: 100,
          submitToAckMs: 200,
          ackToFillMs: 300,
        },
      });

      expect(flags).not.toContain('slow_decision_to_submit');
      expect(flags).not.toContain('slow_submit_to_ack');
      expect(flags).not.toContain('slow_ack_to_fill');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.3: checkDivergence FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('checkDivergence() (Story 5.3, AC7)', () => {
    it('should detect high latency divergence with severity and details', () => {
      const event = { latency_total_ms: 600 };
      const thresholds = { latencyThresholdMs: 500 };

      const result = checkDivergence(event, thresholds);

      expect(result.hasDivergence).toBe(true);
      expect(result.flags).toContain('high_latency');
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].type).toBe('high_latency');
      expect(result.divergences[0].severity).toBe('warn');
      expect(result.divergences[0].details.latency_ms).toBe(600);
      expect(result.divergences[0].details.threshold_ms).toBe(500);
    });

    it('should detect size divergence with error severity', () => {
      const event = {
        requested_size: 100,
        filled_size: 50, // 50% difference
      };
      const thresholds = { partialFillThresholdPct: 0.1 };

      const result = checkDivergence(event, thresholds);

      expect(result.hasDivergence).toBe(true);
      expect(result.flags).toContain('size_divergence');
      const sizeDivergence = result.divergences.find(d => d.type === 'size_divergence');
      expect(sizeDivergence.severity).toBe('error');
      expect(sizeDivergence.details.requested).toBe(100);
      expect(sizeDivergence.details.filled).toBe(50);
    });

    it('should detect multiple divergences simultaneously', () => {
      const event = {
        latency_total_ms: 600,
        slippage_vs_expected: 0.05,
        expected_price: 1.0,
        requested_size: 100,
        filled_size: 50,
      };

      const result = checkDivergence(event);

      expect(result.hasDivergence).toBe(true);
      expect(result.flags).toContain('high_latency');
      expect(result.flags).toContain('high_slippage');
      expect(result.flags).toContain('size_divergence');
      expect(result.divergences.length).toBeGreaterThanOrEqual(3);
    });

    it('should return no divergence when within thresholds', () => {
      const event = {
        latency_total_ms: 200,
        slippage_vs_expected: 0.005,
        expected_price: 1.0,
        requested_size: 100,
        filled_size: 100,
      };

      const result = checkDivergence(event);

      expect(result.hasDivergence).toBe(false);
      expect(result.flags).toHaveLength(0);
      expect(result.divergences).toHaveLength(0);
    });

    it('should include eventId and windowId when available', () => {
      const event = {
        id: 123,
        window_id: 'window-456',
        latency_total_ms: 600,
      };

      const result = checkDivergence(event, { latencyThresholdMs: 500 });

      expect(result.eventId).toBe(123);
      expect(result.windowId).toBe('window-456');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.3: detectStateDivergence FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('detectStateDivergence() (Story 5.3, AC6)', () => {
    it('should detect size mismatch between local and exchange', () => {
      const local = { id: 1, window_id: 'w1', size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, window_id: 'w1', size: 80, side: 'long', status: 'open' };

      const result = detectStateDivergence(local, exchange);

      expect(result).not.toBeNull();
      expect(result.divergences).toHaveLength(1);
      expect(result.divergences[0].field).toBe('size');
      expect(result.divergences[0].local).toBe(100);
      expect(result.divergences[0].exchange).toBe(80);
    });

    it('should detect side mismatch', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 100, side: 'short', status: 'open' };

      const result = detectStateDivergence(local, exchange);

      expect(result).not.toBeNull();
      expect(result.divergences.some(d => d.field === 'side')).toBe(true);
    });

    it('should detect status mismatch', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 100, side: 'long', status: 'closed' };

      const result = detectStateDivergence(local, exchange);

      expect(result).not.toBeNull();
      expect(result.divergences.some(d => d.field === 'status')).toBe(true);
    });

    it('should detect multiple divergences', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 50, side: 'short', status: 'closed' };

      const result = detectStateDivergence(local, exchange);

      expect(result).not.toBeNull();
      expect(result.divergences).toHaveLength(3);
    });

    it('should return null when states match', () => {
      const local = { id: 1, size: 100, side: 'long', status: 'open' };
      const exchange = { id: 1, size: 100, side: 'long', status: 'open' };

      const result = detectStateDivergence(local, exchange);

      expect(result).toBeNull();
    });

    it('should return null for null inputs', () => {
      expect(detectStateDivergence(null, {})).toBeNull();
      expect(detectStateDivergence({}, null)).toBeNull();
      expect(detectStateDivergence(null, null)).toBeNull();
    });

    it('should include position and window IDs in result', () => {
      const local = { id: 123, window_id: 'win-456', size: 100, side: 'long', status: 'open' };
      const exchange = { id: 123, window_id: 'win-456', size: 80, side: 'long', status: 'open' };

      const result = detectStateDivergence(local, exchange);

      expect(result.positionId).toBe(123);
      expect(result.windowId).toBe('win-456');
      expect(result.localState).toEqual(local);
      expect(result.exchangeState).toEqual(exchange);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.3: queryDivergentEvents FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('queryDivergentEvents() (Story 5.3, AC7)', () => {
    it('should return only events with divergence flags', () => {
      mockDb.all.mockReturnValue([
        { id: 1, diagnostic_flags: '["high_latency"]' },
        { id: 2, diagnostic_flags: '["high_slippage", "size_impact"]' },
      ]);

      const events = queryDivergentEvents();

      expect(events).toHaveLength(2);
      expect(events.every(e => e.diagnostic_flags?.length > 0)).toBe(true);
    });

    it('should parse diagnostic_flags JSON', () => {
      mockDb.all.mockReturnValue([
        { id: 1, diagnostic_flags: '["high_latency", "high_slippage"]' },
      ]);

      const events = queryDivergentEvents();

      expect(events[0].diagnostic_flags).toEqual(['high_latency', 'high_slippage']);
    });

    it('should filter by specific flags', () => {
      mockDb.all.mockReturnValue([
        { id: 1, diagnostic_flags: '["high_latency"]' },
        { id: 2, diagnostic_flags: '["high_slippage", "size_impact"]' },
      ]);

      const events = queryDivergentEvents({ flags: ['high_latency'] });

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(1);
    });

    it('should filter by windowId', () => {
      mockDb.all.mockReturnValue([]);

      queryDivergentEvents({ windowId: 'window-123' });

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        expect.arrayContaining(['window-123'])
      );
    });

    it('should filter by strategyId', () => {
      mockDb.all.mockReturnValue([]);

      queryDivergentEvents({ strategyId: 'spot-lag-v1' });

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('strategy_id = ?'),
        expect.arrayContaining(['spot-lag-v1'])
      );
    });

    it('should filter by timeRange', () => {
      mockDb.all.mockReturnValue([]);

      queryDivergentEvents({
        timeRange: {
          startDate: '2026-01-01T00:00:00Z',
          endDate: '2026-01-31T23:59:59Z',
        },
      });

      expect(mockDb.all).toHaveBeenCalledWith(
        expect.stringContaining('signal_detected_at >= ?'),
        expect.arrayContaining(['2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z'])
      );
    });

    it('should handle malformed JSON gracefully', () => {
      mockDb.all.mockReturnValue([
        { id: 1, diagnostic_flags: 'invalid-json' },
      ]);

      const events = queryDivergentEvents();

      expect(events).toHaveLength(1);
      expect(events[0].diagnostic_flags).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.3: queryDivergenceSummary FUNCTION
  // ═══════════════════════════════════════════════════════════════════════════

  describe('queryDivergenceSummary() (Story 5.3, AC7)', () => {
    it('should calculate correct divergence rates', () => {
      // Mock divergent events
      mockDb.all.mockReturnValue([
        { diagnostic_flags: '["high_latency"]' },
        { diagnostic_flags: '["high_slippage"]' },
        { diagnostic_flags: '["high_latency", "size_impact"]' },
      ]);
      // Mock total count
      mockDb.get.mockReturnValue({ count: 10 });

      const summary = queryDivergenceSummary();

      expect(summary.totalEvents).toBe(10);
      expect(summary.eventsWithDivergence).toBe(3);
      expect(summary.divergenceRate).toBeCloseTo(0.3);
      expect(summary.flagCounts.high_latency).toBe(2);
      expect(summary.flagCounts.high_slippage).toBe(1);
      expect(summary.flagCounts.size_impact).toBe(1);
    });

    it('should calculate flag rates correctly', () => {
      mockDb.all.mockReturnValue([
        { diagnostic_flags: '["high_latency"]' },
        { diagnostic_flags: '["high_latency"]' },
      ]);
      mockDb.get.mockReturnValue({ count: 10 });

      const summary = queryDivergenceSummary();

      expect(summary.flagRates.high_latency).toBeCloseTo(0.2);
    });

    it('should return zeros when no events', () => {
      mockDb.all.mockReturnValue([]);
      mockDb.get.mockReturnValue({ count: 0 });

      const summary = queryDivergenceSummary();

      expect(summary.totalEvents).toBe(0);
      expect(summary.eventsWithDivergence).toBe(0);
      expect(summary.divergenceRate).toBe(0);
      expect(summary.flagCounts).toEqual({});
    });

    it('should filter by windowId', () => {
      mockDb.all.mockReturnValue([]);
      mockDb.get.mockReturnValue({ count: 0 });

      queryDivergenceSummary({ windowId: 'window-123' });

      expect(mockDb.get).toHaveBeenCalledWith(
        expect.stringContaining('window_id = ?'),
        expect.arrayContaining(['window-123'])
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // STORY 5.4: DIVERGENCE ALERTING FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getDivergenceSeverity() (Story 5.4, AC1)', () => {
    it('should return error for state_divergence', () => {
      expect(getDivergenceSeverity('state_divergence')).toBe('error');
    });

    it('should return error for size_divergence', () => {
      expect(getDivergenceSeverity('size_divergence')).toBe('error');
    });

    it('should return warn for high_latency', () => {
      expect(getDivergenceSeverity('high_latency')).toBe('warn');
    });

    it('should return warn for high_slippage', () => {
      expect(getDivergenceSeverity('high_slippage')).toBe('warn');
    });

    it('should return warn for entry_slippage', () => {
      expect(getDivergenceSeverity('entry_slippage')).toBe('warn');
    });

    it('should return warn for size_impact', () => {
      expect(getDivergenceSeverity('size_impact')).toBe('warn');
    });

    it('should return warn for unknown flags', () => {
      expect(getDivergenceSeverity('unknown_flag')).toBe('warn');
    });
  });

  describe('formatDivergenceAlert() (Story 5.4, AC2, AC3)', () => {
    it('should format high_latency alert with actionable message', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency'],
        divergences: [{
          type: 'high_latency',
          severity: 'warn',
          details: { latency_ms: 600, threshold_ms: 500 },
        }],
      };
      const event = {
        window_id: 'window-1',
        position_id: 1,
        strategy_id: 'spot-lag-v1',
        latency_total_ms: 600,
      };

      const alert = formatDivergenceAlert(divergenceResult, event);

      expect(alert.message).toContain('High latency: 600ms');
      expect(alert.message).toContain('threshold: 500ms');
      expect(alert.structured.flags).toContain('high_latency');
      expect(alert.structured.context.window_id).toBe('window-1');
      expect(alert.structured.context.position_id).toBe(1);
      expect(alert.suggestions).toContain('Check network latency and API response times');
    });

    it('should format slippage alert with percentage', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['entry_slippage'],
        divergences: [{
          type: 'entry_slippage',
          severity: 'warn',
          details: { expected: 0.42, actual: 0.45 },
        }],
      };
      const event = {
        expected_price: 0.42,
        price_at_fill: 0.45,
      };

      const alert = formatDivergenceAlert(divergenceResult, event);

      expect(alert.message).toContain('Entry slippage');
      expect(alert.message).toContain('expected 0.4200');
      expect(alert.message).toContain('got 0.4500');
      expect(alert.suggestions).toContain('Review orderbook depth and timing of entry signals');
    });

    it('should format size_divergence alert', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['size_divergence'],
        divergences: [{
          type: 'size_divergence',
          severity: 'error',
          details: { requested: 100, filled: 50 },
        }],
      };

      const alert = formatDivergenceAlert(divergenceResult, {});

      expect(alert.message).toContain('Size divergence');
      expect(alert.message).toContain('requested 100');
      expect(alert.message).toContain('filled 50');
      expect(alert.suggestions).toContain('Check for partial fills and orderbook depth');
    });

    it('should include CRITICAL suggestion for state_divergence', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['state_divergence'],
        divergences: [{
          type: 'state_divergence',
          severity: 'error',
          details: {},
        }],
      };

      const alert = formatDivergenceAlert(divergenceResult, {});

      expect(alert.suggestions).toContain('CRITICAL: Run position reconciliation immediately');
    });

    it('should include all required context fields (AC2)', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency'],
        divergences: [{
          type: 'high_latency',
          severity: 'warn',
          details: { latency_ms: 600, threshold_ms: 500 },
        }],
      };
      const event = {
        window_id: 'window-123',
        position_id: 42,
        strategy_id: 'test-strategy',
        event_type: 'entry',
        signal_detected_at: '2026-01-31T10:00:00Z',
        order_filled_at: '2026-01-31T10:00:00.600Z',
      };

      const alert = formatDivergenceAlert(divergenceResult, event);

      // AC2: context (window_id, position_id, strategy_id)
      expect(alert.structured.context.window_id).toBe('window-123');
      expect(alert.structured.context.position_id).toBe(42);
      expect(alert.structured.context.strategy_id).toBe('test-strategy');
      expect(alert.structured.context.event_type).toBe('entry');
      // Timestamps
      expect(alert.structured.timestamps.signal_detected_at).toBe('2026-01-31T10:00:00Z');
      expect(alert.structured.timestamps.order_filled_at).toBe('2026-01-31T10:00:00.600Z');
    });

    it('should format multiple divergences in single alert', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency', 'high_slippage'],
        divergences: [
          { type: 'high_latency', severity: 'warn', details: { latency_ms: 600, threshold_ms: 500 } },
          { type: 'high_slippage', severity: 'warn', details: { expected: 0.50, actual: 0.52 } },
        ],
      };

      const alert = formatDivergenceAlert(divergenceResult, { expected_price: 0.50, price_at_fill: 0.52 });

      expect(alert.message).toContain('High latency');
      expect(alert.message).toContain('High slippage');
      expect(alert.message).toContain('|'); // Separator between divergences
      expect(alert.structured.divergences).toHaveLength(2);
    });

    it('should handle null/undefined inputs gracefully', () => {
      expect(() => formatDivergenceAlert(null, null)).not.toThrow();
      expect(() => formatDivergenceAlert(undefined, undefined)).not.toThrow();
      expect(() => formatDivergenceAlert({}, {})).not.toThrow();

      const alert = formatDivergenceAlert(null, null);
      expect(alert.message).toBe('No divergence details');
      expect(alert.structured.flags).toEqual([]);
      expect(alert.suggestions).toEqual([]);
    });
  });

  describe('shouldEscalate() (Story 5.4, AC1)', () => {
    it('should return true for state_divergence', () => {
      const result = {
        divergences: [{ type: 'state_divergence', severity: 'error' }],
      };

      expect(shouldEscalate(result)).toBe(true);
    });

    it('should return true for size_divergence', () => {
      const result = {
        divergences: [{ type: 'size_divergence', severity: 'error' }],
      };

      expect(shouldEscalate(result)).toBe(true);
    });

    it('should return false for only warnings', () => {
      const result = {
        divergences: [
          { type: 'high_latency', severity: 'warn' },
          { type: 'high_slippage', severity: 'warn' },
        ],
      };

      expect(shouldEscalate(result)).toBe(false);
    });

    it('should return true if ANY divergence is error severity', () => {
      const result = {
        divergences: [
          { type: 'high_latency', severity: 'warn' },
          { type: 'size_divergence', severity: 'error' },
        ],
      };

      expect(shouldEscalate(result)).toBe(true);
    });

    it('should return false for null input', () => {
      expect(shouldEscalate(null)).toBe(false);
    });

    it('should return false for empty object', () => {
      expect(shouldEscalate({})).toBe(false);
    });

    it('should return false for undefined divergences', () => {
      expect(shouldEscalate({ divergences: undefined })).toBe(false);
    });

    it('should return false for empty divergences array', () => {
      expect(shouldEscalate({ divergences: [] })).toBe(false);
    });
  });

  describe('alertOnDivergence() (Story 5.4, AC5, AC6)', () => {
    it('should return alerted:false when no divergence', () => {
      const result = alertOnDivergence({}, { hasDivergence: false });

      expect(result.alerted).toBe(false);
      expect(result.reason).toBe('no_divergence');
    });

    it('should return alerted:false when divergenceResult is null', () => {
      const result = alertOnDivergence({}, null);

      expect(result.alerted).toBe(false);
      expect(result.reason).toBe('no_divergence');
    });

    it('should never throw even with invalid input (AC5 - fail-loud principle)', () => {
      expect(() => alertOnDivergence(null, null)).not.toThrow();
      expect(() => alertOnDivergence(undefined, undefined)).not.toThrow();
      expect(() => alertOnDivergence({}, {})).not.toThrow();
    });

    it('should return alert details when divergence exists', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency'],
        divergences: [{ type: 'high_latency', severity: 'warn', details: { latency_ms: 600 } }],
      };

      const result = alertOnDivergence({ window_id: 'w1' }, divergenceResult);

      expect(result.alerted).toBe(true);
      expect(result.level).toBe('warn');
      expect(result.flags).toContain('high_latency');
      expect(result.message).toContain('High latency');
    });

    it('should escalate to error level for severe divergence (AC1)', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['state_divergence'],
        divergences: [{ type: 'state_divergence', severity: 'error', details: {} }],
      };

      const result = alertOnDivergence({}, divergenceResult);

      expect(result.alerted).toBe(true);
      expect(result.level).toBe('error');
    });

    it('should use warn level for non-severe divergence (AC1)', () => {
      const divergenceResult = {
        hasDivergence: true,
        flags: ['high_latency'],
        divergences: [{ type: 'high_latency', severity: 'warn', details: { latency_ms: 600 } }],
      };

      const result = alertOnDivergence({}, divergenceResult);

      expect(result.level).toBe('warn');
    });

    it('should handle internal errors gracefully and report them (AC5)', () => {
      // Create a divergenceResult that will cause an error in formatting
      const badResult = {
        hasDivergence: true,
        get flags() { throw new Error('Simulated internal error'); },
      };

      // Mock console.error to verify error is logged
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = alertOnDivergence({}, badResult);

      expect(result.alerted).toBe(false);
      expect(result.reason).toBe('alert_system_error');
      expect(result.error).toBeDefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        'ALERT_SYSTEM_ERROR: Failed to generate divergence alert',
        expect.any(Object)
      );

      consoleSpy.mockRestore();
    });
  });
});
