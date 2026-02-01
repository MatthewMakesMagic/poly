/**
 * Tests for TickBuffer
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TickBuffer } from '../buffer.js';

describe('TickBuffer', () => {
  let buffer;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('uses default config when no options provided', () => {
      buffer = new TickBuffer();
      expect(buffer.batchSize).toBe(50);
      expect(buffer.flushIntervalMs).toBe(100);
      expect(buffer.maxBufferSize).toBe(1000);
    });

    it('uses custom config when provided', () => {
      buffer = new TickBuffer({
        batchSize: 10,
        flushIntervalMs: 50,
        maxBufferSize: 100,
      });
      expect(buffer.batchSize).toBe(10);
      expect(buffer.flushIntervalMs).toBe(50);
      expect(buffer.maxBufferSize).toBe(100);
    });
  });

  describe('add', () => {
    it('accumulates ticks in buffer', () => {
      buffer = new TickBuffer({ batchSize: 10 });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      expect(buffer.buffer.length).toBe(1);

      buffer.add(tick);
      expect(buffer.buffer.length).toBe(2);
    });

    it('tracks statistics', () => {
      buffer = new TickBuffer({ batchSize: 10 });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      buffer.add(tick);
      buffer.add(tick);

      expect(buffer.getStats().ticksReceived).toBe(3);
    });
  });

  describe('flush on batch size', () => {
    it('triggers onFlush callback when batch size reached', () => {
      const onFlush = vi.fn();
      buffer = new TickBuffer({ batchSize: 3, onFlush });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      buffer.add(tick);
      expect(onFlush).not.toHaveBeenCalled();

      buffer.add(tick); // Third tick triggers flush
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ price: 100 }),
      ]));
    });

    it('clears buffer after flush', () => {
      buffer = new TickBuffer({ batchSize: 2 });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      buffer.add(tick);

      expect(buffer.buffer.length).toBe(0);
    });

    it('updates stats after flush', () => {
      buffer = new TickBuffer({ batchSize: 2 });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      buffer.add(tick);

      const stats = buffer.getStats();
      expect(stats.ticksFlushed).toBe(2);
      expect(stats.flushCount).toBe(1);
    });
  });

  describe('flush on interval', () => {
    it('triggers flush after interval expires', () => {
      const onFlush = vi.fn();
      buffer = new TickBuffer({ batchSize: 100, flushIntervalMs: 100, onFlush });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(onFlush).toHaveBeenCalledTimes(1);
    });

    it('does not flush if buffer is empty when timer fires', () => {
      const onFlush = vi.fn();
      buffer = new TickBuffer({ batchSize: 100, flushIntervalMs: 100, onFlush });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      buffer.flush(); // Manual flush
      expect(onFlush).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);
      expect(onFlush).toHaveBeenCalledTimes(1); // No additional flush
    });

    it('restarts timer after manual flush', () => {
      const onFlush = vi.fn();
      buffer = new TickBuffer({ batchSize: 100, flushIntervalMs: 100, onFlush });
      const tick = { timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 };

      buffer.add(tick);
      buffer.flush();
      expect(onFlush).toHaveBeenCalledTimes(1);

      // Add another tick - should start new timer
      buffer.add(tick);
      vi.advanceTimersByTime(100);
      expect(onFlush).toHaveBeenCalledTimes(2);
    });
  });

  describe('buffer overflow', () => {
    it('drops oldest tick when buffer overflows', () => {
      buffer = new TickBuffer({ maxBufferSize: 3, batchSize: 100 });

      buffer.add({ timestamp: 1, topic: 'test', symbol: 'btc', price: 100 });
      buffer.add({ timestamp: 2, topic: 'test', symbol: 'btc', price: 200 });
      buffer.add({ timestamp: 3, topic: 'test', symbol: 'btc', price: 300 });

      // Buffer is now at max (3), adding fourth should drop first
      buffer.add({ timestamp: 4, topic: 'test', symbol: 'btc', price: 400 });

      expect(buffer.buffer.length).toBe(3);
      expect(buffer.buffer[0].timestamp).toBe(2); // First was dropped
      expect(buffer.buffer[2].timestamp).toBe(4); // Fourth is last
    });

    it('tracks dropped ticks in stats', () => {
      buffer = new TickBuffer({ maxBufferSize: 2, batchSize: 100 });

      buffer.add({ timestamp: 1, topic: 'test', symbol: 'btc', price: 100 });
      buffer.add({ timestamp: 2, topic: 'test', symbol: 'btc', price: 200 });
      buffer.add({ timestamp: 3, topic: 'test', symbol: 'btc', price: 300 });

      expect(buffer.getStats().ticksDropped).toBe(1);
    });

    it('calls onOverflow callback when buffer overflows', () => {
      const onOverflow = vi.fn();
      buffer = new TickBuffer({ maxBufferSize: 2, batchSize: 100, onOverflow });

      buffer.add({ timestamp: 1, topic: 'test', symbol: 'btc', price: 100 });
      buffer.add({ timestamp: 2, topic: 'test', symbol: 'btc', price: 200 });
      expect(onOverflow).not.toHaveBeenCalled();

      buffer.add({ timestamp: 3, topic: 'test', symbol: 'btc', price: 300 });
      // bufferSize is 2 because: buffer was at max (2), dropped oldest (now 1), then added new (now 2)
      expect(onOverflow).toHaveBeenCalledWith({ dropped: 1, bufferSize: 2 });
    });
  });

  describe('manual flush', () => {
    it('returns flushed ticks', () => {
      buffer = new TickBuffer({ batchSize: 100 });
      buffer.add({ timestamp: 1, topic: 'test', symbol: 'btc', price: 100 });
      buffer.add({ timestamp: 2, topic: 'test', symbol: 'btc', price: 200 });

      const flushed = buffer.flush();
      expect(flushed).toHaveLength(2);
      expect(flushed[0].timestamp).toBe(1);
      expect(flushed[1].timestamp).toBe(2);
    });

    it('clears buffer after manual flush', () => {
      buffer = new TickBuffer({ batchSize: 100 });
      buffer.add({ timestamp: 1, topic: 'test', symbol: 'btc', price: 100 });

      buffer.flush();
      expect(buffer.buffer.length).toBe(0);
    });
  });

  describe('getState', () => {
    it('returns buffer size', () => {
      buffer = new TickBuffer({ batchSize: 100 });
      buffer.add({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });
      buffer.add({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 200 });

      expect(buffer.getState().size).toBe(2);
    });

    it('returns oldest tick age', () => {
      buffer = new TickBuffer({ batchSize: 100 });
      const now = Date.now();
      vi.setSystemTime(now);

      buffer.add({ timestamp: now, topic: 'test', symbol: 'btc', price: 100 });

      vi.advanceTimersByTime(50);
      expect(buffer.getState().oldestTickAgeMs).toBe(50);
    });

    it('returns 0 age for empty buffer', () => {
      buffer = new TickBuffer({ batchSize: 100 });
      expect(buffer.getState().oldestTickAgeMs).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears buffer and stats', () => {
      buffer = new TickBuffer({ batchSize: 100 });
      buffer.add({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });
      buffer.add({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 200 });

      buffer.reset();

      expect(buffer.buffer.length).toBe(0);
      expect(buffer.getStats().ticksReceived).toBe(0);
    });

    it('clears flush timer', () => {
      const onFlush = vi.fn();
      buffer = new TickBuffer({ batchSize: 100, flushIntervalMs: 100, onFlush });
      buffer.add({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });

      buffer.reset();

      vi.advanceTimersByTime(200);
      expect(onFlush).not.toHaveBeenCalled();
    });
  });
});
