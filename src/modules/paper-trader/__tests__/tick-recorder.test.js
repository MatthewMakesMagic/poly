/**
 * Tests for tick-recorder module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as tickRecorder from '../tick-recorder.js';

// Mock persistence
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ changes: 0 }),
  },
}));

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import persistence from '../../../persistence/index.js';

function makeMockClobWs() {
  const callbacks = new Map();

  return {
    subscribe: vi.fn((tokenId, cb) => {
      if (!callbacks.has(tokenId)) callbacks.set(tokenId, new Set());
      callbacks.get(tokenId).add(cb);
      return () => {
        callbacks.get(tokenId)?.delete(cb);
      };
    }),
    getBookSnapshot: vi.fn((tokenId) => ({
      bestBid: 0.55,
      bestAsk: 0.57,
      mid: 0.56,
      spread: 0.02,
      bidDepth1pct: 500,
      askDepth1pct: 450,
      bids: [[0.55, 100], [0.54, 200], [0.53, 300], [0.52, 400], [0.51, 500], [0.50, 600]],
      asks: [[0.57, 100], [0.58, 200], [0.59, 300], [0.60, 400], [0.61, 500], [0.62, 600]],
    })),
    // Helper to fire a callback (simulating a book update)
    _fire(tokenId, eventType = 'book') {
      const cbs = callbacks.get(tokenId);
      if (cbs) {
        for (const cb of cbs) {
          cb({ tokenId, eventType, book: {} });
        }
      }
    },
  };
}

describe('tick-recorder', () => {
  let clobWs;

  beforeEach(() => {
    vi.clearAllMocks();
    tickRecorder._reset();
    clobWs = makeMockClobWs();
  });

  afterEach(() => {
    tickRecorder._reset();
  });

  describe('startRecording', () => {
    it('subscribes to token book updates', () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      expect(clobWs.subscribe).toHaveBeenCalledWith('token-1', expect.any(Function));
    });

    it('captures ticks on callback', () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      clobWs._fire('token-1', 'book');
      clobWs._fire('token-1', 'price_change');

      const stats = tickRecorder.getStats();
      expect(stats.ticksBuffered).toBe(2);
    });

    it('does not duplicate subscription for same token', () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      expect(clobWs.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('buffer accumulation', () => {
    it('accumulates ticks without immediately flushing to DB', () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      clobWs._fire('token-1');
      clobWs._fire('token-1');
      clobWs._fire('token-1');

      expect(persistence.run).not.toHaveBeenCalled();
      expect(tickRecorder.getStats().ticksBuffered).toBe(3);
    });
  });

  describe('flushAll', () => {
    it('writes buffered ticks to DB', async () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      clobWs._fire('token-1');
      clobWs._fire('token-1');

      await tickRecorder.flushAll();

      expect(persistence.run).toHaveBeenCalledTimes(1);
      // Check that the SQL includes multi-row VALUES
      const sql = persistence.run.mock.calls[0][0];
      expect(sql).toContain('INSERT INTO l2_book_ticks');
      expect(sql).toContain('VALUES');

      // 2 ticks × 12 columns = 24 params
      const params = persistence.run.mock.calls[0][1];
      expect(params).toHaveLength(24);

      expect(tickRecorder.getStats().ticksFlushed).toBe(2);
    });

    it('does nothing if buffer is empty', async () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      await tickRecorder.flushAll();

      expect(persistence.run).not.toHaveBeenCalled();
    });
  });

  describe('stopRecording', () => {
    it('unsubscribes and flushes remaining buffer', async () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      clobWs._fire('token-1');
      clobWs._fire('token-1');

      await tickRecorder.stopRecording('token-1');

      // Should have flushed
      expect(persistence.run).toHaveBeenCalledTimes(1);
      expect(tickRecorder.getStats().ticksFlushed).toBe(2);

      // Further fires should not accumulate
      clobWs._fire('token-1');
      expect(tickRecorder.getStats().ticksBuffered).toBe(2); // still 2
    });
  });

  describe('top-levels extraction', () => {
    it('picks top 5 bid/ask levels from snapshot', async () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      clobWs._fire('token-1');

      await tickRecorder.flushAll();

      const params = persistence.run.mock.calls[0][1];
      // top_levels is the last param (index 11 for first tick)
      const topLevels = JSON.parse(params[11]);
      expect(topLevels.bids).toHaveLength(5);
      expect(topLevels.asks).toHaveLength(5);
      expect(topLevels.bids[0]).toEqual([0.55, 100]);
      expect(topLevels.asks[0]).toEqual([0.57, 100]);
    });
  });

  describe('buffer overflow', () => {
    it('drops oldest ticks when exceeding cap', () => {
      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);

      // Fire more than BUFFER_CAP (5000) ticks
      for (let i = 0; i < 5001; i++) {
        clobWs._fire('token-1');
      }

      const stats = tickRecorder.getStats();
      expect(stats.ticksDropped).toBeGreaterThan(0);
      // Buffer should be capped
      expect(stats.ticksBuffered).toBe(5001);
    });
  });

  describe('multiple tokens', () => {
    it('records ticks for multiple tokens simultaneously', async () => {
      tickRecorder.startRecording('token-up', 'btc', 'btc-15m-100', clobWs);
      tickRecorder.startRecording('token-down', 'btc', 'btc-15m-100', clobWs);

      clobWs._fire('token-up');
      clobWs._fire('token-down');
      clobWs._fire('token-up');

      const stats = tickRecorder.getStats();
      expect(stats.ticksBuffered).toBe(3);
      expect(stats.activeRecordings).toBe(2);

      await tickRecorder.flushAll();

      // Two separate flushes (one per token)
      expect(persistence.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStats', () => {
    it('tracks active recordings count', () => {
      expect(tickRecorder.getStats().activeRecordings).toBe(0);

      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);
      expect(tickRecorder.getStats().activeRecordings).toBe(1);

      tickRecorder.startRecording('token-2', 'eth', 'eth-15m-100', clobWs);
      expect(tickRecorder.getStats().activeRecordings).toBe(2);
    });
  });

  describe('flush error handling', () => {
    it('increments flushErrors on DB failure', async () => {
      persistence.run.mockRejectedValueOnce(new Error('connection lost'));

      tickRecorder.startRecording('token-1', 'btc', 'btc-15m-100', clobWs);
      clobWs._fire('token-1');

      await tickRecorder.flushAll();

      expect(tickRecorder.getStats().flushErrors).toBe(1);
      expect(tickRecorder.getStats().ticksFlushed).toBe(0);
    });
  });
});
