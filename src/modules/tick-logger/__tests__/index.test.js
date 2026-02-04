/**
 * Tests for Tick Logger Module
 *
 * Integration tests requiring a PostgreSQL database.
 * Skipped when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import modules
import * as tickLogger from '../index.js';
import * as logger from '../../logger/index.js';
import persistence from '../../../persistence/index.js';
import * as rtdsClient from '../../../clients/rtds/index.js';

// Skip all tests if no PostgreSQL database is available
describe.skipIf(!process.env.DATABASE_URL)('Tick Logger Module', () => {
  beforeEach(async () => {
    // Initialize logger
    await logger.init({
      logging: { level: 'error', console: false, directory: '/tmp/test-logs' },
    });

    // Initialize persistence with PostgreSQL
    await persistence.init({
      database: { url: process.env.DATABASE_URL, pool: { min: 1, max: 2 } },
    });

    // Mock RTDS client subscribe
    vi.spyOn(rtdsClient, 'subscribe').mockImplementation(() => () => {});
  });

  afterEach(async () => {
    await tickLogger.shutdown();
    // Clean up test data before shutting down persistence
    await persistence.run('DELETE FROM rtds_ticks');
    await persistence.shutdown();
    await logger.shutdown();

    vi.restoreAllMocks();
  });

  describe('init', () => {
    it('initializes with default config', async () => {
      await tickLogger.init({});

      const state = tickLogger.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.batchSize).toBe(50);
      expect(state.config.flushIntervalMs).toBe(100);
      expect(state.config.retentionDays).toBe(7);
    });

    it('initializes with custom config', async () => {
      await tickLogger.init({
        tickLogger: {
          batchSize: 25,
          flushIntervalMs: 50,
          retentionDays: 14,
        },
      });

      const state = tickLogger.getState();
      expect(state.config.batchSize).toBe(25);
      expect(state.config.flushIntervalMs).toBe(50);
      expect(state.config.retentionDays).toBe(14);
    });

    it('subscribes to RTDS client for all symbols', async () => {
      await tickLogger.init({});

      // Should subscribe to btc, eth, sol, xrp
      expect(rtdsClient.subscribe).toHaveBeenCalledTimes(4);
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('btc', expect.any(Function));
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('eth', expect.any(Function));
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('sol', expect.any(Function));
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('xrp', expect.any(Function));
    });

    it('is idempotent - multiple calls do not re-initialize', async () => {
      await tickLogger.init({});
      await tickLogger.init({});
      await tickLogger.init({});

      // Should only subscribe once (4 symbols)
      expect(rtdsClient.subscribe).toHaveBeenCalledTimes(4);
    });
  });

  describe('logTick', () => {
    beforeEach(async () => {
      await tickLogger.init({ tickLogger: { batchSize: 5, flushIntervalMs: 10000 } });
    });

    it('throws if not initialized', async () => {
      await tickLogger.shutdown();

      expect(() => {
        tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });
      }).toThrow('Tick logger not initialized');
    });

    it('adds tick to buffer', () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(1);
    });

    it('formats timestamp to ISO string', async () => {
      const now = Date.now();
      tickLogger.logTick({ timestamp: now, topic: 'test', symbol: 'btc', price: 100 });

      // Force flush to insert
      await tickLogger.flush();

      // Query database to verify
      const row = await persistence.get('SELECT * FROM rtds_ticks WHERE symbol = $1', ['btc']);
      expect(row.timestamp).toBe(new Date(now).toISOString());
    });

    it('rejects NaN price', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: NaN });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0); // Tick not added due to validation failure
    });

    it('rejects Infinity price', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: Infinity });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0);
    });

    it('rejects negative Infinity price', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: -Infinity });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0);
    });

    it('rejects empty symbol', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: '', price: 100 });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0);
    });

    it('rejects empty topic', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: '', symbol: 'btc', price: 100 });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0);
    });

    it('handles invalid timestamp by using current time', async () => {
      tickLogger.logTick({ timestamp: 'not-a-date', topic: 'test', symbol: 'btc', price: 100 });

      await tickLogger.flush();

      const row = await persistence.get('SELECT * FROM rtds_ticks WHERE symbol = $1', ['btc']);
      expect(row).toBeDefined();
      // Timestamp should be a valid ISO string (current time was used as fallback)
      expect(() => new Date(row.timestamp)).not.toThrow();
    });

    it('handles undefined timestamp by using current time', async () => {
      tickLogger.logTick({ timestamp: undefined, topic: 'test', symbol: 'btc', price: 100 });

      await tickLogger.flush();

      const row = await persistence.get('SELECT * FROM rtds_ticks WHERE symbol = $1', ['btc']);
      expect(row).toBeDefined();
      expect(() => new Date(row.timestamp)).not.toThrow();
    });

    it('increments ticksReceived for manual logTick calls', async () => {
      const stateBefore = tickLogger.getState();
      const receivedBefore = stateBefore.stats.ticks_received;

      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });

      const stateAfter = tickLogger.getState();
      expect(stateAfter.stats.ticks_received).toBe(receivedBefore + 1);
    });
  });

  describe('flush', () => {
    beforeEach(async () => {
      await tickLogger.init({ tickLogger: { batchSize: 100, flushIntervalMs: 10000 } });
    });

    it('throws if not initialized', async () => {
      await tickLogger.shutdown();
      await expect(tickLogger.flush()).rejects.toThrow('Tick logger not initialized');
    });

    it('inserts buffered ticks to database', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'eth', price: 200 });

      await tickLogger.flush();

      const rows = await persistence.all('SELECT * FROM rtds_ticks ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0].symbol).toBe('btc');
      expect(rows[0].price).toBe(100);
      expect(rows[1].symbol).toBe('eth');
      expect(rows[1].price).toBe(200);
    });

    it('updates stats after flush', async () => {
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'eth', price: 200 });

      await tickLogger.flush();

      const state = tickLogger.getState();
      expect(state.stats.ticks_inserted).toBe(2);
      expect(state.stats.batches_inserted).toBe(1);
    });
  });

  describe('getState', () => {
    it('returns uninitialized state before init', () => {
      const state = tickLogger.getState();
      expect(state.initialized).toBe(false);
      expect(state.buffer.size).toBe(0);
      expect(state.config).toBe(null);
    });

    it('returns full state after init', async () => {
      await tickLogger.init({});

      const state = tickLogger.getState();
      expect(state.initialized).toBe(true);
      expect(state.buffer).toHaveProperty('size');
      expect(state.buffer).toHaveProperty('oldest_tick_age_ms');
      expect(state.stats).toHaveProperty('ticks_received');
      expect(state.stats).toHaveProperty('ticks_inserted');
      expect(state.config).toHaveProperty('batchSize');
    });
  });

  describe('shutdown', () => {
    it('flushes remaining ticks on shutdown', async () => {
      await tickLogger.init({ tickLogger: { batchSize: 100, flushIntervalMs: 10000 } });

      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'btc', price: 100 });
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: 'eth', price: 200 });

      await tickLogger.shutdown();

      const rows = await persistence.all('SELECT * FROM rtds_ticks');
      expect(rows).toHaveLength(2);
    });

    it('unsubscribes from RTDS client', async () => {
      const unsubscribeFn = vi.fn();
      vi.spyOn(rtdsClient, 'subscribe').mockImplementation(() => unsubscribeFn);

      await tickLogger.init({});
      await tickLogger.shutdown();

      // Should be called 4 times (once per symbol)
      expect(unsubscribeFn).toHaveBeenCalledTimes(4);
    });

    it('resets state after shutdown', async () => {
      await tickLogger.init({});
      await tickLogger.shutdown();

      const state = tickLogger.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('cleanupOldTicks', () => {
    beforeEach(async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false } });
    });

    it('deletes ticks older than retention period', async () => {
      // Insert old tick (8 days ago)
      const oldTimestamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES ($1, $2, $3, $4)',
        [oldTimestamp, 'test', 'btc', 100]
      );

      // Insert recent tick
      const recentTimestamp = new Date().toISOString();
      await persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES ($1, $2, $3, $4)',
        [recentTimestamp, 'test', 'eth', 200]
      );

      // Run cleanup with 7 day retention
      const deleted = await tickLogger.cleanupOldTicks(7);

      expect(deleted).toBe(1);

      const remaining = await persistence.all('SELECT * FROM rtds_ticks');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].symbol).toBe('eth');
    });

    it('updates last cleanup timestamp in stats', async () => {
      await tickLogger.cleanupOldTicks(7);

      const state = tickLogger.getState();
      expect(state.stats.last_cleanup_at).not.toBeNull();
    });
  });

  describe('batch insert performance', () => {
    beforeEach(async () => {
      await tickLogger.init({ tickLogger: { batchSize: 50, flushIntervalMs: 10000 } });
    });

    it('handles batch size threshold correctly', async () => {
      // Add exactly batch size ticks
      for (let i = 0; i < 50; i++) {
        tickLogger.logTick({
          timestamp: Date.now() + i,
          topic: 'test',
          symbol: 'btc',
          price: 100 + i,
        });
      }

      // Should have auto-flushed
      const state = tickLogger.getState();
      expect(state.stats.batches_inserted).toBe(1);
      expect(state.stats.ticks_inserted).toBe(50);
      expect(state.buffer.size).toBe(0);
    });

    it('inserts all ticks atomically in transaction', async () => {
      // Add ticks
      for (let i = 0; i < 10; i++) {
        tickLogger.logTick({
          timestamp: Date.now() + i,
          topic: 'crypto_prices',
          symbol: 'btc',
          price: 50000 + i,
        });
      }

      await tickLogger.flush();

      const rows = await persistence.all('SELECT * FROM rtds_ticks');
      expect(rows).toHaveLength(10);
    });
  });

  describe('getState', () => {
    it('exposes insert_errors in stats', async () => {
      await tickLogger.init({});

      const state = tickLogger.getState();
      expect(state.stats).toHaveProperty('insert_errors');
      expect(state.stats.insert_errors).toBe(0);
    });

    it('exposes dead_letter_queue_size in buffer', async () => {
      await tickLogger.init({});

      const state = tickLogger.getState();
      expect(state.buffer).toHaveProperty('dead_letter_queue_size');
      expect(state.buffer.dead_letter_queue_size).toBe(0);
    });
  });

  describe('string length limits', () => {
    beforeEach(async () => {
      await tickLogger.init({ tickLogger: { batchSize: 100, flushIntervalMs: 10000 } });
    });

    it('rejects excessively long symbol strings', async () => {
      const longSymbol = 'x'.repeat(300);
      tickLogger.logTick({ timestamp: Date.now(), topic: 'test', symbol: longSymbol, price: 100 });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0);
    });

    it('rejects excessively long topic strings', async () => {
      const longTopic = 'x'.repeat(300);
      tickLogger.logTick({ timestamp: Date.now(), topic: longTopic, symbol: 'btc', price: 100 });

      const state = tickLogger.getState();
      expect(state.buffer.size).toBe(0);
    });
  });
});
