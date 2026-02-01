/**
 * Oracle Tracker Statistics Tests (stats.test.js)
 *
 * Tests for statistics calculation: volatility buckets, median/mean calculations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { unlinkSync, existsSync } from 'fs';

// Import modules
import * as oracleTracker from '../index.js';
import * as logger from '../../logger/index.js';
import persistence from '../../../persistence/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = join(__dirname, 'test-oracle-stats.db');

// Mock RTDS client
import { vi } from 'vitest';
import * as rtdsClient from '../../../clients/rtds/index.js';

describe('Oracle Tracker Statistics', () => {
  beforeEach(async () => {
    vi.spyOn(rtdsClient, 'subscribe').mockImplementation(() => () => {});

    await logger.init({
      logging: { level: 'error', console: false, directory: '/tmp/test-logs' },
    });

    await persistence.init({
      database: { path: TEST_DB_PATH },
    });

    await oracleTracker.init({ oracleTracker: { flushIntervalMs: 0 } });
  });

  afterEach(async () => {
    await oracleTracker.shutdown();
    await persistence.shutdown();
    await logger.shutdown();

    if (existsSync(TEST_DB_PATH)) {
      try {
        unlinkSync(TEST_DB_PATH);
      } catch {
        // Ignore
      }
    }

    vi.restoreAllMocks();
  });

  describe('volatility buckets', () => {
    it('categorizes updates into volatility buckets', () => {
      // Small bucket: 0-0.1%
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50050, 50000, 0.0005, 10000]
      );

      // Medium bucket: 0.1-0.5%
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50050, 0.003, 12000]
      );

      // Large bucket: 0.5-1%
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:20.000Z', 'btc', 50600, 50200, 0.008, 15000]
      );

      // Extreme bucket: >1%
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:30.000Z', 'btc', 51500, 50600, 0.018, 8000]
      );

      const stats = oracleTracker.getStats('btc');

      expect(stats.update_frequency_by_volatility.small.count).toBe(1);
      expect(stats.update_frequency_by_volatility.medium.count).toBe(1);
      expect(stats.update_frequency_by_volatility.large.count).toBe(1);
      expect(stats.update_frequency_by_volatility.extreme.count).toBe(1);
    });

    it('calculates average interval per volatility bucket', () => {
      // Two medium volatility updates with different intervals
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50200, 50000, 0.004, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50400, 50200, 0.004, 20000]
      );

      const stats = oracleTracker.getStats('btc');

      expect(stats.update_frequency_by_volatility.medium.count).toBe(2);
      expect(stats.update_frequency_by_volatility.medium.avg_interval_ms).toBe(15000);
    });

    it('handles empty buckets correctly', () => {
      // Only insert data for one bucket
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50050, 50000, 0.0005, 10000]
      );

      const stats = oracleTracker.getStats('btc');

      expect(stats.update_frequency_by_volatility.small.count).toBe(1);
      expect(stats.update_frequency_by_volatility.medium.count).toBe(0);
      expect(stats.update_frequency_by_volatility.large.count).toBe(0);
      expect(stats.update_frequency_by_volatility.extreme.count).toBe(0);
      expect(stats.update_frequency_by_volatility.medium.avg_interval_ms).toBe(0);
    });
  });

  describe('deviation threshold calculations', () => {
    it('calculates median correctly for odd number of samples', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.001, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50100, 0.003, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:20.000Z', 'btc', 50300, 50200, 0.005, 10000]
      );

      const threshold = oracleTracker.getDeviationThreshold('btc');

      // Sorted: 0.001, 0.003, 0.005 - median is 0.003
      expect(threshold.median_pct).toBe(0.003);
    });

    it('calculates mean correctly', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.001, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50100, 0.002, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:20.000Z', 'btc', 50300, 50200, 0.003, 10000]
      );

      const threshold = oracleTracker.getDeviationThreshold('btc');

      // Mean: (0.001 + 0.002 + 0.003) / 3 = 0.002
      expect(threshold.mean_pct).toBeCloseTo(0.002, 6);
    });

    it('uses absolute values for negative deviations', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50000, 50100, -0.002, 10000]
      );

      const threshold = oracleTracker.getDeviationThreshold('btc');

      // Both should be counted as 0.002 in absolute terms
      expect(threshold.min_pct).toBe(0.002);
      expect(threshold.max_pct).toBe(0.002);
      expect(threshold.mean_pct).toBe(0.002);
    });

    it('returns min and max correctly', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.001, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50500, 50100, 0.008, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:20.000Z', 'btc', 51000, 50500, 0.01, 10000]
      );

      const threshold = oracleTracker.getDeviationThreshold('btc');

      expect(threshold.min_pct).toBe(0.001);
      expect(threshold.max_pct).toBe(0.01);
    });
  });

  describe('average update frequency', () => {
    it('calculates updates per minute correctly', () => {
      // Average interval of 15 seconds = 4 updates per minute
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 15000]
      );

      const freq = oracleTracker.getAverageUpdateFrequency('btc');

      expect(freq.updates_per_minute).toBe(4);
    });

    it('handles single update correctly', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 12345]
      );

      const freq = oracleTracker.getAverageUpdateFrequency('btc');

      expect(freq.avg_ms).toBe(12345);
      expect(freq.avg_seconds).toBe(12.345);
    });
  });

  describe('multi-symbol statistics', () => {
    it('maintains separate stats per symbol', () => {
      // BTC updates
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:10.000Z', 'btc', 50200, 50100, 0.002, 20000]
      );

      // ETH updates
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'eth', 3010, 3000, 0.003, 5000]
      );

      const btcStats = oracleTracker.getStats('btc');
      const ethStats = oracleTracker.getStats('eth');

      expect(btcStats.update_count).toBe(2);
      expect(ethStats.update_count).toBe(1);

      expect(btcStats.avg_update_frequency.avg_ms).toBe(15000);
      expect(ethStats.avg_update_frequency.avg_ms).toBe(5000);
    });
  });

  describe('edge cases', () => {
    it('handles single record gracefully', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 10000]
      );

      const stats = oracleTracker.getStats('btc');
      const threshold = oracleTracker.getDeviationThreshold('btc');

      expect(stats.update_count).toBe(1);
      expect(threshold.sample_size).toBe(1);
      expect(threshold.min_pct).toBe(threshold.max_pct);
      expect(threshold.median_pct).toBe(threshold.mean_pct);
    });

    it('handles zero time_since_previous_ms', () => {
      persistence.run(
        `INSERT INTO oracle_updates (timestamp, symbol, price, previous_price, deviation_from_previous_pct, time_since_previous_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['2026-02-01T00:00:00.000Z', 'btc', 50100, 50000, 0.002, 0]
      );

      const freq = oracleTracker.getAverageUpdateFrequency('btc');

      expect(freq.avg_ms).toBe(0);
      // updates_per_minute is null when avg_ms is 0 to avoid Infinity
      expect(freq.updates_per_minute).toBeNull();
    });
  });
});
