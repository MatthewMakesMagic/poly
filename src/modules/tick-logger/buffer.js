/**
 * Tick Buffer
 *
 * Batches incoming ticks for efficient database insertion.
 * Triggers flush on batch size threshold or time interval.
 */

import { DEFAULT_CONFIG } from './types.js';

/**
 * TickBuffer - Accumulates ticks and triggers flush on thresholds
 */
export class TickBuffer {
  /**
   * @param {Object} options - Buffer configuration
   * @param {number} [options.batchSize=50] - Flush after N ticks
   * @param {number} [options.flushIntervalMs=100] - Flush every N ms
   * @param {number} [options.maxBufferSize=1000] - Max buffer before overflow
   * @param {Function} [options.onFlush] - Callback when buffer flushes
   * @param {Function} [options.onOverflow] - Callback when buffer overflows
   */
  constructor(options = {}) {
    this.batchSize = options.batchSize ?? DEFAULT_CONFIG.batchSize;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_CONFIG.flushIntervalMs;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_CONFIG.maxBufferSize;
    this.onFlush = options.onFlush || null;
    this.onOverflow = options.onOverflow || null;

    this.buffer = [];
    this.flushTimer = null;
    this.firstTickTime = null;

    // Stats
    this.stats = {
      ticksReceived: 0,
      ticksFlushed: 0,
      ticksDropped: 0,
      flushCount: 0,
    };
  }

  /**
   * Add a tick to the buffer
   * @param {Object} tick - Tick data { timestamp, topic, symbol, price, raw_payload? }
   */
  add(tick) {
    this.stats.ticksReceived++;

    // Emergency: drop oldest if buffer would overflow
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
      this.stats.ticksDropped++;
      if (this.onOverflow) {
        this.onOverflow({ dropped: 1, bufferSize: this.buffer.length + 1 });
      }
    }

    this.buffer.push(tick);

    // Start timer on first tick
    if (this.buffer.length === 1) {
      this.firstTickTime = Date.now();
      this.startFlushTimer();
    }

    // Flush if batch size reached
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Start the flush timer
   */
  startFlushTimer() {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushIntervalMs);
    // Allow process to exit even if timer is pending
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Stop the flush timer
   */
  stopFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Flush buffered ticks
   * @returns {Object[]} Array of flushed ticks
   */
  flush() {
    this.stopFlushTimer();

    const ticks = this.buffer.splice(0, this.buffer.length);
    this.firstTickTime = null;

    if (ticks.length > 0) {
      this.stats.ticksFlushed += ticks.length;
      this.stats.flushCount++;

      if (this.onFlush) {
        this.onFlush(ticks);
      }
    }

    return ticks;
  }

  /**
   * Get current buffer state
   * @returns {Object} Buffer state
   */
  getState() {
    return {
      size: this.buffer.length,
      oldestTickAgeMs: this.firstTickTime ? Date.now() - this.firstTickTime : 0,
    };
  }

  /**
   * Get buffer statistics
   * @returns {Object} Buffer stats
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset buffer and stats
   */
  reset() {
    this.stopFlushTimer();
    this.buffer = [];
    this.firstTickTime = null;
    this.stats = {
      ticksReceived: 0,
      ticksFlushed: 0,
      ticksDropped: 0,
      flushCount: 0,
    };
  }
}
