/**
 * Tests for Tick Logger Cleanup Functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { unlinkSync, existsSync } from 'fs';

import * as tickLogger from '../index.js';
import * as logger from '../../logger/index.js';
import persistence from '../../../persistence/index.js';
import * as rtdsClient from '../../../clients/rtds/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = join(__dirname, 'test-cleanup.db');

describe('Tick Logger Cleanup', () => {
  beforeEach(async () => {
    vi.useFakeTimers();

    await logger.init({
      logging: { level: 'error', console: false, directory: '/tmp/test-logs' },
    });

    await persistence.init({
      database: { path: TEST_DB_PATH },
    });

    vi.spyOn(rtdsClient, 'subscribe').mockImplementation(() => () => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    await tickLogger.shutdown();
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

  describe('retention policy', () => {
    it('respects configurable retention period', async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false, retentionDays: 3 } });

      // Insert tick 4 days ago (should be deleted with 3-day retention)
      const oldTimestamp = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [oldTimestamp, 'test', 'btc', 100]
      );

      // Insert tick 2 days ago (should be kept with 3-day retention)
      const recentTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [recentTimestamp, 'test', 'eth', 200]
      );

      const deleted = await tickLogger.cleanupOldTicks(3);
      expect(deleted).toBe(1);

      const remaining = persistence.all('SELECT * FROM rtds_ticks');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].symbol).toBe('eth');
    });

    it('uses config retentionDays when not specified in call', async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false, retentionDays: 5 } });

      // Insert tick 6 days ago
      const oldTimestamp = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [oldTimestamp, 'test', 'btc', 100]
      );

      // Call without specifying days
      const deleted = await tickLogger.cleanupOldTicks();
      expect(deleted).toBe(1);
    });

    it('deletes nothing when no old ticks exist', async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false } });

      // Insert recent tick
      const recentTimestamp = new Date().toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [recentTimestamp, 'test', 'btc', 100]
      );

      const deleted = await tickLogger.cleanupOldTicks(7);
      expect(deleted).toBe(0);
    });
  });

  describe('cleanup on init', () => {
    it('runs cleanup on init when cleanupOnInit is true', async () => {
      // Pre-insert old tick before init
      // Need to manually insert since persistence is already initialized
      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [oldTimestamp, 'test', 'btc', 100]
      );

      await tickLogger.init({ tickLogger: { cleanupOnInit: true, retentionDays: 7 } });

      // Old tick should have been cleaned up
      const remaining = persistence.all('SELECT * FROM rtds_ticks');
      expect(remaining).toHaveLength(0);
    });

    it('skips cleanup on init when cleanupOnInit is false', async () => {
      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [oldTimestamp, 'test', 'btc', 100]
      );

      await tickLogger.init({ tickLogger: { cleanupOnInit: false } });

      // Old tick should still exist
      const remaining = persistence.all('SELECT * FROM rtds_ticks');
      expect(remaining).toHaveLength(1);
    });
  });

  describe('periodic cleanup', () => {
    it('schedules cleanup interval when cleanupIntervalHours > 0', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      await tickLogger.init({
        tickLogger: {
          cleanupOnInit: false,
          cleanupIntervalHours: 2,
        },
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        2 * 60 * 60 * 1000 // 2 hours in ms
      );
    });

    it('does not schedule cleanup when cleanupIntervalHours is 0', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      await tickLogger.init({
        tickLogger: {
          cleanupOnInit: false,
          cleanupIntervalHours: 0,
        },
      });

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });

    it('clears interval on shutdown', async () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      await tickLogger.init({
        tickLogger: {
          cleanupOnInit: false,
          cleanupIntervalHours: 1,
        },
      });

      await tickLogger.shutdown();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('cleanup edge cases', () => {
    it('handles empty table gracefully', async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false } });

      const deleted = await tickLogger.cleanupOldTicks(7);
      expect(deleted).toBe(0);
    });

    it('handles exact boundary timestamp correctly', async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false } });

      const now = Date.now();
      vi.setSystemTime(now);

      // Insert tick exactly 7 days ago
      const exactBoundary = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [exactBoundary, 'test', 'btc', 100]
      );

      // Insert tick 1ms before boundary (should be deleted)
      const justOlder = new Date(now - 7 * 24 * 60 * 60 * 1000 - 1).toISOString();
      persistence.run(
        'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
        [justOlder, 'test', 'eth', 200]
      );

      const deleted = await tickLogger.cleanupOldTicks(7);
      expect(deleted).toBe(1); // Only the one older than boundary
    });

    it('deletes multiple old ticks efficiently', async () => {
      await tickLogger.init({ tickLogger: { cleanupOnInit: false } });

      // Insert 100 old ticks
      const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 100; i++) {
        persistence.run(
          'INSERT INTO rtds_ticks (timestamp, topic, symbol, price) VALUES (?, ?, ?, ?)',
          [oldTimestamp, 'test', 'btc', i]
        );
      }

      const deleted = await tickLogger.cleanupOldTicks(7);
      expect(deleted).toBe(100);
    });
  });
});
