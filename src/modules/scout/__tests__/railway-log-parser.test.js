/**
 * Railway Log Parser Tests
 *
 * Story E.2: Tests for Railway log stream parsing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RailwayLogParser, createParser } from '../railway-log-parser.js';
import { TradeEventType } from '../../trade-event/types.js';

describe('RailwayLogParser', () => {
  let parser;
  let events;
  let errors;

  beforeEach(() => {
    events = [];
    errors = [];
    parser = new RailwayLogParser({
      onEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
      onClose: () => {},
    });
  });

  describe('parseLine', () => {
    it('should parse entry event from JSON log', () => {
      const line = JSON.stringify({
        time: '2026-02-01T12:00:00Z',
        msg: 'entry_executed',
        window_id: 'btc-15m-123',
        position_id: 'pos-456',
        price: 0.55,
        size: 10,
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.ENTRY);
      expect(result.data.windowId).toBe('btc-15m-123');
      expect(result.data.positionId).toBe('pos-456');
      expect(result.data.price).toBe(0.55);
    });

    it('should parse exit event from JSON log', () => {
      const line = JSON.stringify({
        time: '2026-02-01T12:05:00Z',
        msg: 'exit_executed',
        window_id: 'btc-15m-123',
        position_id: 'pos-456',
        pnl: 2.50,
        reason: 'take_profit',
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.EXIT);
      expect(result.data.pnl).toBe(2.50);
      expect(result.data.reason).toBe('take_profit');
    });

    it('should parse signal event from JSON log', () => {
      const line = JSON.stringify({
        time: '2026-02-01T12:00:00Z',
        event: 'signal_generated',
        window_id: 'eth-15m-789',
        confidence: 0.85,
        edge: 0.15,
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.SIGNAL);
      expect(result.data.confidence).toBe(0.85);
      expect(result.data.edge).toBe(0.15);
    });

    it('should parse composed_strategy_signals event', () => {
      const line = JSON.stringify({
        msg: 'composed_strategy_signals',
        signalCount: 3,
        strategy: 'probability-model',
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.SIGNAL);
      expect(result.data.signalCount).toBe(3);
      expect(result.data.strategyId).toBe('probability-model');
    });

    it('should parse alert event from error log', () => {
      const line = JSON.stringify({
        level: 'error',
        msg: 'error processing tick',
        error: 'Connection timeout',
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.ALERT);
      expect(result.data.error).toBe('Connection timeout');
    });

    it('should parse divergence event', () => {
      const line = JSON.stringify({
        msg: 'divergence_detected',
        symbol: 'btc',
        divergence_pct: 0.5,
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.DIVERGENCE);
      expect(result.data.symbol).toBe('btc');
    });

    it('should return null for non-matching JSON log', () => {
      const line = JSON.stringify({
        msg: 'module_initialized',
        module: 'orchestrator',
      });

      const result = parser.parseLine(line);

      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const line = 'not valid json';

      const result = parser.parseLine(line);

      // Falls back to plain text parsing, which also doesn't match
      expect(result).toBeNull();
    });

    it('should handle plain text log with entry pattern', () => {
      const line = '2026-02-01 12:00:00 INFO entry executed for btc';

      const result = parser.parseLine(line);

      // Should detect 'entry' pattern in plain text
      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.ENTRY);
    });
  });

  describe('processBuffer', () => {
    it('should process multiple lines and emit events', () => {
      parser.buffer = [
        JSON.stringify({ msg: 'entry_executed', window_id: 'w1' }),
        JSON.stringify({ msg: 'exit_executed', window_id: 'w2' }),
        '', // Empty line to trigger processing
      ].join('\n');

      parser.processBuffer();

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(TradeEventType.ENTRY);
      expect(events[1].type).toBe(TradeEventType.EXIT);
    });

    it('should keep incomplete line in buffer', () => {
      parser.buffer = JSON.stringify({ msg: 'entry_executed' }) + '\nincomplete';

      parser.processBuffer();

      expect(events).toHaveLength(1);
      expect(parser.buffer).toBe('incomplete');
    });

    it('should increment event count', () => {
      parser.buffer = JSON.stringify({ msg: 'signal_generated' }) + '\n';

      parser.processBuffer();

      expect(parser.getStats().eventCount).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return current stats', () => {
      const stats = parser.getStats();

      expect(stats).toHaveProperty('isRunning');
      expect(stats).toHaveProperty('eventCount');
      expect(stats.isRunning).toBe(false);
      expect(stats.eventCount).toBe(0);
    });
  });

  describe('createParser', () => {
    it('should create parser with callbacks', () => {
      const onEvent = () => {};
      const onError = () => {};
      const onClose = () => {};

      const parser = createParser(onEvent, onError, onClose);

      expect(parser).toBeInstanceOf(RailwayLogParser);
    });
  });

  // Story E.3: Trading mode detection tests
  describe('trading mode detection', () => {
    it('should extract trading_mode PAPER from paper_mode_signal event', () => {
      const line = JSON.stringify({
        level: 'info',
        event: 'paper_mode_signal',
        window_id: 'btc-15m-1769949000',
        direction: 'UP',
        confidence: 0.85,
        size: 2,
        would_have_traded: true,
        trading_mode: 'PAPER',
        message: 'Order blocked - PAPER mode active',
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.SIGNAL);
      expect(result.data.tradingMode).toBe('PAPER');
      expect(result.data.windowId).toBe('btc-15m-1769949000');
    });

    it('should extract trading_mode LIVE from order_placed event', () => {
      const line = JSON.stringify({
        level: 'info',
        event: 'order_placed',
        window_id: 'btc-15m-1769949000',
        direction: 'UP',
        size: 2,
        price: 0.421,
        trading_mode: 'LIVE',
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.ENTRY);
      expect(result.data.tradingMode).toBe('LIVE');
    });

    it('should detect PAPER mode from paper_mode_signal event type even without trading_mode field', () => {
      const line = JSON.stringify({
        level: 'info',
        event: 'paper_mode_signal',
        window_id: 'eth-15m-123',
        direction: 'DOWN',
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.data.tradingMode).toBe('PAPER');
    });

    it('should detect LIVE mode from order_placed event without explicit trading_mode field', () => {
      const line = JSON.stringify({
        level: 'info',
        event: 'order_placed',
        window_id: 'btc-15m-123',
        price: 0.5,
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.data.tradingMode).toBe('LIVE');
    });

    it('should detect LIVE mode from entry_executed event without explicit trading_mode field', () => {
      const line = JSON.stringify({
        time: '2026-02-01T12:00:00Z',
        msg: 'entry_executed',
        window_id: 'btc-15m-123',
        price: 0.55,
      });

      const result = parser.parseLine(line);

      expect(result).not.toBeNull();
      expect(result.type).toBe(TradeEventType.ENTRY);
      expect(result.data.tradingMode).toBe('LIVE');
    });

    it('should preserve explicit trading_mode field when present', () => {
      const line = JSON.stringify({
        event: 'entry_signals_generated',
        trading_mode: 'PAPER',
        signal_count: 2,
      });

      const result = parser.parseLine(line);

      // entry_signals_generated should match as a signal event
      expect(result).not.toBeNull();
      expect(result.data.tradingMode).toBe('PAPER');
    });
  });
});
