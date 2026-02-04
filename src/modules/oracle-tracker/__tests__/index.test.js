/**
 * Oracle Tracker Module Tests (index.js)
 *
 * Tests for the public interface: init, getStats, getRecentUpdates, getState, shutdown
 * Uses real database for integration testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import modules
import * as oracleTracker from '../index.js';
import * as logger from '../../logger/index.js';
import persistence from '../../../persistence/index.js';
import * as rtdsClient from '../../../clients/rtds/index.js';
import { TOPICS, SUPPORTED_SYMBOLS } from '../../../clients/rtds/types.js';

// Skip all tests if no DATABASE_URL is available (PostgreSQL required for integration tests)
describe.skipIf(!process.env.DATABASE_URL)('Oracle Tracker Module', () => {
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
    await oracleTracker.shutdown();
    await persistence.run('DELETE FROM oracle_updates');
    await persistence.shutdown();
    await logger.shutdown();

    vi.restoreAllMocks();
  });

  describe('init', () => {
    it('initializes with default config', async () => {
      await oracleTracker.init({});

      const state = oracleTracker.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.bufferSize).toBe(10);
      expect(state.config.flushIntervalMs).toBe(1000);
      expect(state.config.minDeviationForUpdate).toBe(0.0001);
    });

    it('initializes with custom config', async () => {
      await oracleTracker.init({
        oracleTracker: {
          bufferSize: 20,
          flushIntervalMs: 500,
          minDeviationForUpdate: 0.001,
        },
      });

      const state = oracleTracker.getState();
      expect(state.config.bufferSize).toBe(20);
      expect(state.config.flushIntervalMs).toBe(500);
      expect(state.config.minDeviationForUpdate).toBe(0.001);
    });

    it('subscribes to RTDS client for all symbols', async () => {
      await oracleTracker.init({});

      // Should subscribe to btc, eth, sol, xrp
      expect(rtdsClient.subscribe).toHaveBeenCalledTimes(4);
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('btc', expect.any(Function));
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('eth', expect.any(Function));
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('sol', expect.any(Function));
      expect(rtdsClient.subscribe).toHaveBeenCalledWith('xrp', expect.any(Function));
    });

    it('is idempotent - multiple calls do not re-initialize', async () => {
      await oracleTracker.init({});
      await oracleTracker.init({});
      await oracleTracker.init({});

      // Should only subscribe once (4 symbols)
      expect(rtdsClient.subscribe).toHaveBeenCalledTimes(4);
    });
  });

  describe('getState', () => {
    it('returns uninitialized state before init', () => {
      const state = oracleTracker.getState();
      expect(state.initialized).toBe(false);
      expect(state.tracking).toEqual({});
      expect(state.config).toBeNull();
    });

    it('returns full state after init', async () => {
      await oracleTracker.init({});

      const state = oracleTracker.getState();
      expect(state.initialized).toBe(true);
      expect(state.tracking).toHaveProperty('btc');
      expect(state.tracking).toHaveProperty('eth');
      expect(state.tracking).toHaveProperty('sol');
      expect(state.tracking).toHaveProperty('xrp');
      expect(state.config).toBeDefined();
      expect(state.buffer).toHaveProperty('pending_records');
      expect(state.module_stats).toHaveProperty('updates_detected');
    });
  });

  describe('shutdown', () => {
    it('resets state after shutdown', async () => {
      await oracleTracker.init({});
      await oracleTracker.shutdown();

      const state = oracleTracker.getState();
      expect(state.initialized).toBe(false);
    });

    it('unsubscribes from RTDS client', async () => {
      const unsubscribeFn = vi.fn();
      vi.spyOn(rtdsClient, 'subscribe').mockImplementation(() => unsubscribeFn);

      await oracleTracker.init({});
      await oracleTracker.shutdown();

      // Should be called 4 times (once per symbol)
      expect(unsubscribeFn).toHaveBeenCalledTimes(4);
    });

    it('is safe to call multiple times', async () => {
      await oracleTracker.init({});
      await oracleTracker.shutdown();
      await oracleTracker.shutdown();

      const state = oracleTracker.getState();
      expect(state.initialized).toBe(false);
    });

    it('is safe to call without init', async () => {
      await expect(oracleTracker.shutdown()).resolves.not.toThrow();
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await oracleTracker.init({ oracleTracker: { flushIntervalMs: 0 } });
    });

    it('throws if not initialized', async () => {
      await oracleTracker.shutdown();

      await expect(oracleTracker.getStats('btc')).rejects.toThrow('Oracle tracker not initialized');
    });

    it('throws for invalid symbol', async () => {
      await expect(oracleTracker.getStats('invalid')).rejects.toThrow('Invalid symbol');
    });

    it('returns empty stats when no data', async () => {
      const stats = await oracleTracker.getStats('btc');

      expect(stats.symbol).toBe('btc');
      expect(stats.update_count).toBe(0);
      expect(stats.avg_update_frequency).toBeNull();
      expect(stats.deviation_threshold).toBeNull();
    });

    it('returns stats after inserting records', async () => {
      // Insert test records directly
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50100, 0.002, 15000]
      );

      const stats = await oracleTracker.getStats('btc');

      expect(stats.update_count).toBe(2);
      expect(stats.avg_update_frequency).not.toBeNull();
      expect(stats.avg_update_frequency.avg_ms).toBe(12500); // (10000 + 15000) / 2
      expect(stats.deviation_threshold).not.toBeNull();
      expect(stats.deviation_threshold.sample_size).toBe(2);
    });
  });

  describe('getAverageUpdateFrequency', () => {
    beforeEach(async () => {
      await oracleTracker.init({ oracleTracker: { flushIntervalMs: 0 } });
    });

    it('throws if not initialized', async () => {
      await oracleTracker.shutdown();

      await expect(oracleTracker.getAverageUpdateFrequency('btc')).rejects.toThrow('not initialized');
    });

    it('throws for invalid symbol', async () => {
      await expect(oracleTracker.getAverageUpdateFrequency('invalid')).rejects.toThrow('Invalid symbol');
    });

    it('returns null when no data', async () => {
      expect(await oracleTracker.getAverageUpdateFrequency('btc')).toBeNull();
    });

    it('calculates average update frequency', async () => {
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50100, 0.002, 20000]
      );

      const freq = await oracleTracker.getAverageUpdateFrequency('btc');

      expect(freq.avg_ms).toBe(15000);
      expect(freq.avg_seconds).toBe(15);
      expect(freq.updates_per_minute).toBe(4);
    });
  });

  describe('getDeviationThreshold', () => {
    beforeEach(async () => {
      await oracleTracker.init({ oracleTracker: { flushIntervalMs: 0 } });
    });

    it('throws if not initialized', async () => {
      await oracleTracker.shutdown();

      await expect(oracleTracker.getDeviationThreshold('btc')).rejects.toThrow('not initialized');
    });

    it('throws for invalid symbol', async () => {
      await expect(oracleTracker.getDeviationThreshold('invalid')).rejects.toThrow('Invalid symbol');
    });

    it('returns null when no data', async () => {
      expect(await oracleTracker.getDeviationThreshold('btc')).toBeNull();
    });

    it('calculates deviation threshold statistics', async () => {
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50050, 50100, -0.001, 15000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:20.000Z', 'btc', 50200, 50050, 0.003, 12000]
      );

      const threshold = await oracleTracker.getDeviationThreshold('btc');

      expect(threshold.sample_size).toBe(3);
      expect(threshold.min_pct).toBe(0.001);
      expect(threshold.max_pct).toBe(0.003);
      expect(threshold.mean_pct).toBeCloseTo(0.002, 5);
    });
  });

  describe('getRecentUpdates', () => {
    beforeEach(async () => {
      await oracleTracker.init({ oracleTracker: { flushIntervalMs: 0 } });
    });

    it('throws if not initialized', async () => {
      await oracleTracker.shutdown();

      await expect(oracleTracker.getRecentUpdates('btc')).rejects.toThrow('not initialized');
    });

    it('throws for invalid symbol', async () => {
      await expect(oracleTracker.getRecentUpdates('invalid')).rejects.toThrow('Invalid symbol');
    });

    it('returns empty array when no data', async () => {
      expect(await oracleTracker.getRecentUpdates('btc')).toEqual([]);
    });

    it('returns recent updates ordered by timestamp descending', async () => {
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50100, 0.002, 15000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:20.000Z', 'btc', 50300, 50200, 0.002, 12000]
      );

      const updates = await oracleTracker.getRecentUpdates('btc');

      expect(updates).toHaveLength(3);
      expect(updates[0].price).toBe(50300); // Most recent first
      expect(updates[2].price).toBe(50100);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await persistence.run(
          `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [`2026-02-01T00:00:${i.toString().padStart(2, '0')}.000Z`, 'btc', 50000 + i * 100, 50000 + (i - 1) * 100, 0.002, 10000]
        );
      }

      const updates = await oracleTracker.getRecentUpdates('btc', 5);

      expect(updates).toHaveLength(5);
    });

    it('only returns updates for specified symbol', async () => {
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      await persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['2026-02-01T00:00:00.000Z', 'eth', 3010, 3000, 0.003, 10000]
      );

      const btcUpdates = await oracleTracker.getRecentUpdates('btc');
      const ethUpdates = await oracleTracker.getRecentUpdates('eth');

      expect(btcUpdates).toHaveLength(1);
      expect(btcUpdates[0].symbol).toBe('btc');
      expect(ethUpdates).toHaveLength(1);
      expect(ethUpdates[0].symbol).toBe('eth');
    });
  });
});
