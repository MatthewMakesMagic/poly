/**
 * Partition Manager Module Tests
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    exec: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn().mockReturnValue({ stop: vi.fn() }),
  },
}));

import * as partitionManager from '../index.js';
import persistence from '../../../persistence/index.js';
import cron from 'node-cron';

describe('partition-manager module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state
    try { await partitionManager.shutdown(); } catch { /* ignore */ }
  });

  afterEach(async () => {
    try { await partitionManager.shutdown(); } catch { /* ignore */ }
  });

  describe('init', () => {
    test('initializes with default config', async () => {
      await partitionManager.init({});
      const state = partitionManager.getState();

      expect(state.initialized).toBe(true);
      expect(state.config.createAheadDays).toBe(7);
      expect(state.config.retentionDays).toBe(7);
      expect(state.config.partitionedTables).toEqual(['price_ticks']);
    });

    test('accepts custom config', async () => {
      await partitionManager.init({
        partitionManager: {
          createAheadDays: 14,
          retentionDays: 30,
        },
      });
      const state = partitionManager.getState();

      expect(state.config.createAheadDays).toBe(14);
      expect(state.config.retentionDays).toBe(30);
    });

    test('is idempotent', async () => {
      await partitionManager.init({});
      await partitionManager.init({});
      const state = partitionManager.getState();

      expect(state.initialized).toBe(true);
    });

    test('creates partitions on startup by default', async () => {
      await partitionManager.init({});

      // Should have called exec to create partitions (today + 7 days = 8 calls)
      expect(persistence.exec).toHaveBeenCalled();
    });

    test('schedules cron job', async () => {
      await partitionManager.init({});

      expect(cron.schedule).toHaveBeenCalledWith(
        '5 0 * * *',
        expect.any(Function),
        { timezone: 'UTC' }
      );
    });

    test('skips startup run when configured', async () => {
      await partitionManager.init({
        partitionManager: { runOnStartup: false },
      });

      // exec should not be called for partition creation (only cron scheduled)
      expect(persistence.exec).not.toHaveBeenCalled();
    });
  });

  describe('managePartitions', () => {
    test('throws when not initialized', async () => {
      await expect(partitionManager.managePartitions())
        .rejects.toThrow('not initialized');
    });

    test('creates future partitions', async () => {
      await partitionManager.init({
        partitionManager: {
          runOnStartup: false,
          createAheadDays: 3,
        },
      });

      const results = await partitionManager.managePartitions();

      // Should create partitions for today + 3 days ahead = 4 partitions
      expect(results.created).toBe(4);
      expect(results.errors).toBe(0);
    });

    test('handles partition creation errors gracefully', async () => {
      persistence.exec.mockRejectedValueOnce(new Error('connection lost'));

      await partitionManager.init({
        partitionManager: {
          runOnStartup: false,
          createAheadDays: 0,
        },
      });

      const results = await partitionManager.managePartitions();

      expect(results.errors).toBeGreaterThan(0);
    });

    test('drops old partitions', async () => {
      persistence.get.mockResolvedValue({ '?column?': 1 }); // partition exists

      await partitionManager.init({
        partitionManager: {
          runOnStartup: false,
          retentionDays: 7,
          createAheadDays: 0,
        },
      });

      const results = await partitionManager.managePartitions();

      // Should attempt to drop 7 old partitions
      expect(results.dropped).toBeGreaterThan(0);
    });
  });

  describe('getState', () => {
    test('returns uninitialized state before init', () => {
      const state = partitionManager.getState();

      expect(state.initialized).toBe(false);
      expect(state.stats).toBeNull();
    });

    test('returns stats after running', async () => {
      await partitionManager.init({
        partitionManager: { createAheadDays: 1 },
      });
      const state = partitionManager.getState();

      expect(state.initialized).toBe(true);
      expect(state.stats.lastRunAt).not.toBeNull();
      expect(state.cronRunning).toBe(true);
    });
  });

  describe('shutdown', () => {
    test('stops cron and resets state', async () => {
      await partitionManager.init({});
      await partitionManager.shutdown();

      const state = partitionManager.getState();
      expect(state.initialized).toBe(false);
    });

    test('is idempotent', async () => {
      await partitionManager.shutdown();
      await partitionManager.shutdown();
    });
  });
});
