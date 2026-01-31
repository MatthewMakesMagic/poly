/**
 * Scout Module Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as scout from '../index.js';
import { ScoutErrorCodes, ScoutMode } from '../types.js';
import * as reviewQueue from '../review-queue.js';

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock trade-event subscribeAll
const mockUnsubscribe = vi.fn();
vi.mock('../../trade-event/index.js', () => ({
  subscribeAll: vi.fn(() => mockUnsubscribe),
}));

// Mock renderer (suppress console output)
vi.mock('../renderer.js', () => ({
  init: vi.fn(),
  renderStartup: vi.fn(),
  renderShutdown: vi.fn(),
  renderEvent: vi.fn(),
  addEvent: vi.fn(),
  reset: vi.fn(),
}));

describe('Scout Module', () => {
  beforeEach(async () => {
    // Reset state before each test
    await scout.shutdown().catch(() => {});
    reviewQueue.reset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await scout.shutdown().catch(() => {});
  });

  describe('init', () => {
    it('should initialize with default config', async () => {
      await scout.init();

      const state = scout.getState();
      expect(state.initialized).toBe(true);
      expect(state.mode).toBe(ScoutMode.LOCAL);
    });

    it('should initialize with custom mode', async () => {
      await scout.init({ mode: 'local' });

      const state = scout.getState();
      expect(state.mode).toBe('local');
    });

    it('should throw if already initialized', async () => {
      await scout.init();

      await expect(scout.init()).rejects.toThrow();
    });

    it('should throw for invalid mode', async () => {
      await expect(scout.init({ mode: 'invalid' })).rejects.toMatchObject({
        code: ScoutErrorCodes.INVALID_MODE,
      });
    });
  });

  describe('start', () => {
    it('should start monitoring', async () => {
      await scout.init();
      await scout.start();

      const state = scout.getState();
      expect(state.running).toBe(true);
    });

    it('should throw if not initialized', async () => {
      await expect(scout.start()).rejects.toMatchObject({
        code: ScoutErrorCodes.NOT_INITIALIZED,
      });
    });

    it('should throw if already running', async () => {
      await scout.init();
      await scout.start();

      await expect(scout.start()).rejects.toMatchObject({
        code: ScoutErrorCodes.ALREADY_RUNNING,
      });
    });

    it('should subscribe to trade events in local mode', async () => {
      const { subscribeAll } = await import('../../trade-event/index.js');

      await scout.init({ mode: 'local' });
      await scout.start();

      expect(subscribeAll).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop monitoring', async () => {
      await scout.init();
      await scout.start();
      await scout.stop();

      const state = scout.getState();
      expect(state.running).toBe(false);
    });

    it('should throw if not running', async () => {
      await scout.init();

      await expect(scout.stop()).rejects.toMatchObject({
        code: ScoutErrorCodes.NOT_RUNNING,
      });
    });

    it('should unsubscribe from trade events', async () => {
      await scout.init({ mode: 'local' });
      await scout.start();
      await scout.stop();

      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('should return current state', async () => {
      await scout.init();

      const state = scout.getState();

      expect(state).toEqual(expect.objectContaining({
        initialized: true,
        running: false,
        mode: 'local',
        hasConfig: true,
        stats: expect.objectContaining({
          eventsReceived: 0,
          signalCount: 0,
          entryCount: 0,
          exitCount: 0,
          alertCount: 0,
        }),
        reviewQueue: expect.objectContaining({
          total: 0,
          errors: 0,
          warnings: 0,
        }),
      }));
    });
  });

  describe('getReviewQueue', () => {
    it('should return review queue items', async () => {
      await scout.init();

      // Manually add an item to the queue
      reviewQueue.addItem({
        type: 'entry',
        level: 'warn',
        windowId: 'window-123',
        summary: 'Test item',
      });

      const items = scout.getReviewQueue();

      expect(items).toHaveLength(1);
      expect(items[0].windowId).toBe('window-123');
    });
  });

  describe('acknowledgeReviewItem', () => {
    it('should remove item from queue', async () => {
      await scout.init();

      const id = reviewQueue.addItem({
        type: 'entry',
        level: 'warn',
        summary: 'Test item',
      });

      expect(reviewQueue.getCount()).toBe(1);

      const result = scout.acknowledgeReviewItem(id);

      expect(result).toBe(true);
      expect(reviewQueue.getCount()).toBe(0);
    });

    it('should return false for non-existent item', async () => {
      await scout.init();

      const result = scout.acknowledgeReviewItem(999);

      expect(result).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('should reset all state', async () => {
      await scout.init();
      await scout.start();
      await scout.shutdown();

      const state = scout.getState();
      expect(state.initialized).toBe(false);
      expect(state.running).toBe(false);
    });

    it('should be safe to call multiple times', async () => {
      await scout.init();
      await scout.shutdown();
      await scout.shutdown(); // Should not throw
    });
  });
});
