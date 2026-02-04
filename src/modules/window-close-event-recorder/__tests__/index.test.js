/**
 * Window Close Event Recorder Tests
 *
 * Tests for the window close event recorder module:
 * - Module lifecycle (init, getState, shutdown)
 * - Window scan and capture scheduling
 * - Interval price captures (60s, 30s, 10s, 5s, 1s before close)
 * - Close-time capture (all feed prices)
 * - Resolution detection with retry
 * - Surprise detection
 * - Database persistence (upsert pattern)
 * - Cleanup and timer management
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock persistence
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ lastInsertRowid: 1, changes: 1 }),
    get: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue([]),
  },
}));

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock RTDS client
vi.mock('../../../clients/rtds/index.js', () => ({
  getCurrentPrice: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));

// Mock RTDS types
vi.mock('../../../clients/rtds/types.js', () => ({
  TOPICS: {
    CRYPTO_PRICES: 'crypto_prices',
    CRYPTO_PRICES_CHAINLINK: 'crypto_prices_chainlink',
  },
  SUPPORTED_SYMBOLS: ['btc', 'eth', 'sol', 'xrp'],
}));

// Mock window-manager
vi.mock('../../window-manager/index.js', () => ({
  fetchMarket: vi.fn().mockResolvedValue(null),
  fetchOrderBook: vi.fn().mockResolvedValue(null),
  get15MinWindows: vi.fn(() => []),
}));

import * as recorder from '../index.js';
import { DEFAULT_CONFIG, WindowCloseEventRecorderError } from '../types.js';
import persistence from '../../../persistence/index.js';
import * as rtdsClient from '../../../clients/rtds/index.js';
import * as windowManager from '../../window-manager/index.js';

describe('Window Close Event Recorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await recorder.shutdown();
    vi.useRealTimers();
  });

  describe('Module Lifecycle', () => {
    test('init sets initialized state', async () => {
      await recorder.init({});
      const state = recorder.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.stats.windows_captured).toBe(0);
      expect(state.stats.captures_in_progress).toBe(0);
    });

    test('init is idempotent', async () => {
      await recorder.init({});
      await recorder.init({});

      const state = recorder.getState();
      expect(state.initialized).toBe(true);
    });

    test('getState returns uninitialized state before init', () => {
      const state = recorder.getState();

      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
      expect(state.activeCaptures).toEqual([]);
    });

    test('shutdown clears all state', async () => {
      await recorder.init({});
      await recorder.shutdown();

      const state = recorder.getState();
      expect(state.initialized).toBe(false);
      expect(state.config).toBeNull();
    });

    test('init uses default config when none provided', async () => {
      await recorder.init({});
      const state = recorder.getState();

      expect(state.config.captureStartBeforeCloseMs).toBe(DEFAULT_CONFIG.captureStartBeforeCloseMs);
      expect(state.config.resolutionMaxWaitMs).toBe(DEFAULT_CONFIG.resolutionMaxWaitMs);
      expect(state.config.surpriseThresholdConfidence).toBe(DEFAULT_CONFIG.surpriseThresholdConfidence);
    });

    test('init applies custom config', async () => {
      await recorder.init({
        windowCloseEventRecorder: {
          captureStartBeforeCloseMs: 120000,
          surpriseThresholdConfidence: 0.90,
        },
      });
      const state = recorder.getState();

      expect(state.config.captureStartBeforeCloseMs).toBe(120000);
      expect(state.config.surpriseThresholdConfidence).toBe(0.90);
      // Defaults for unset values
      expect(state.config.resolutionMaxWaitMs).toBe(DEFAULT_CONFIG.resolutionMaxWaitMs);
    });
  });

  describe('Internal Functions', () => {
    describe('determineResolution', () => {
      test('returns up when oracle price > strike', () => {
        const capture = {
          oraclePrices: { close: 95000 },
          strikePrice: 94500,
        };
        const market = { upPrice: 0.9, downPrice: 0.1 };

        const result = recorder._testing.determineResolution(capture, market);
        expect(result).toBe('up');
      });

      test('returns down when oracle price <= strike', () => {
        const capture = {
          oraclePrices: { close: 94500 },
          strikePrice: 94500,
        };
        const market = { upPrice: 0.1, downPrice: 0.9 };

        const result = recorder._testing.determineResolution(capture, market);
        expect(result).toBe('down');
      });

      test('returns down when oracle price < strike', () => {
        const capture = {
          oraclePrices: { close: 94000 },
          strikePrice: 94500,
        };
        const market = { upPrice: 0.1, downPrice: 0.9 };

        const result = recorder._testing.determineResolution(capture, market);
        expect(result).toBe('down');
      });

      test('falls back to market prices when oracle unavailable', () => {
        const capture = {
          oraclePrices: {},
          strikePrice: null,
        };
        const market = { upPrice: 0.95, downPrice: 0.05 };

        const result = recorder._testing.determineResolution(capture, market);
        expect(result).toBe('up');
      });

      test('falls back to down from market prices', () => {
        const capture = {
          oraclePrices: {},
          strikePrice: null,
        };
        const market = { upPrice: 0.05, downPrice: 0.95 };

        const result = recorder._testing.determineResolution(capture, market);
        expect(result).toBe('down');
      });

      test('returns null when no data available', () => {
        const capture = {
          oraclePrices: {},
          strikePrice: null,
        };
        const market = { upPrice: 0.5, downPrice: 0.5 };

        const result = recorder._testing.determineResolution(capture, market);
        expect(result).toBeNull();
      });
    });

    describe('calculateMarketConsensus', () => {
      test('detects surprise when market confident but wrong', async () => {
        await recorder.init({});
        const capture = {
          marketUpPrices: { 1000: 0.97 }, // 97% up consensus
          resolvedDirection: 'down', // resolved down = surprise
        };

        const result = recorder._testing.calculateMarketConsensus(capture);
        expect(result.direction).toBe('up');
        expect(result.confidence).toBe(0.97);
        expect(result.isSurprise).toBe(true);
      });

      test('no surprise when market consensus matches resolution', async () => {
        await recorder.init({});
        const capture = {
          marketUpPrices: { 1000: 0.97 },
          resolvedDirection: 'up',
        };

        const result = recorder._testing.calculateMarketConsensus(capture);
        expect(result.direction).toBe('up');
        expect(result.isSurprise).toBe(false);
      });

      test('no surprise when confidence below threshold', async () => {
        await recorder.init({});
        const capture = {
          marketUpPrices: { 1000: 0.80 }, // 80% - below 95% threshold
          resolvedDirection: 'down',
        };

        const result = recorder._testing.calculateMarketConsensus(capture);
        expect(result.direction).toBe('up');
        expect(result.confidence).toBe(0.80);
        expect(result.isSurprise).toBe(false);
      });

      test('uses 5s price as fallback when 1s unavailable', async () => {
        await recorder.init({});
        const capture = {
          marketUpPrices: { 5000: 0.3 },
          resolvedDirection: 'down',
        };

        const result = recorder._testing.calculateMarketConsensus(capture);
        expect(result.direction).toBe('down');
        expect(result.confidence).toBe(0.7);
      });

      test('returns null when no market data available', async () => {
        await recorder.init({});
        const capture = {
          marketUpPrices: {},
          resolvedDirection: 'up',
        };

        const result = recorder._testing.calculateMarketConsensus(capture);
        expect(result.direction).toBeNull();
        expect(result.confidence).toBe(0);
        expect(result.isSurprise).toBe(false);
      });
    });
  });

  describe('Interval Price Capture', () => {
    test('captures oracle price at interval', async () => {
      await recorder.init({});

      rtdsClient.getCurrentPrice.mockReturnValue({
        price: 95000,
        timestamp: Date.now(),
        staleness_ms: 100,
      });

      windowManager.fetchMarket.mockResolvedValue({
        upPrice: 0.65,
        downPrice: 0.35,
        referencePrice: 94500,
      });

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: null,
        oraclePrices: {},
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        timers: [],
      };

      await recorder._testing.captureIntervalPrices(capture, 60000);

      expect(capture.oraclePrices[60000]).toBe(95000);
      expect(capture.marketUpPrices[60000]).toBe(0.65);
      expect(capture.marketDownPrices[60000]).toBe(0.35);
      expect(capture.strikePrice).toBe(94500);
    });

    test('handles missing oracle price gracefully', async () => {
      await recorder.init({});

      rtdsClient.getCurrentPrice.mockReturnValue(null);
      windowManager.fetchMarket.mockResolvedValue(null);

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 94500,
        oraclePrices: {},
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        timers: [],
      };

      await recorder._testing.captureIntervalPrices(capture, 30000);

      expect(capture.oraclePrices[30000]).toBeUndefined();
      expect(capture.marketUpPrices[30000]).toBeUndefined();
    });
  });

  describe('Close-Time Capture', () => {
    test('captures all feed prices at close', async () => {
      await recorder.init({});

      // Chainlink
      rtdsClient.getCurrentPrice.mockImplementation((symbol, topic) => {
        if (topic === 'crypto_prices_chainlink') {
          return { price: 95100, timestamp: Date.now(), staleness_ms: 50 };
        }
        if (topic === 'crypto_prices') {
          return { price: 95200, timestamp: Date.now(), staleness_ms: 30 };
        }
        return null;
      });

      windowManager.fetchMarket.mockResolvedValue({
        upPrice: 0.70,
        downPrice: 0.30,
        referencePrice: 94500,
        closed: false,
      });

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 94500,
        oraclePrices: {},
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        timers: [],
      };

      await recorder._testing.captureAtClose(capture);

      expect(capture.oraclePrices.close).toBe(95100);
      expect(capture.feedPricesAtClose.binance).toBe(95200);
      expect(capture.feedPricesAtClose.chainlink).toBe(95100);
      expect(capture.marketUpPrices.close).toBe(0.70);
      expect(capture.marketDownPrices.close).toBe(0.30);
    });
  });

  describe('Resolution Capture', () => {
    test('captures resolution when market is closed', async () => {
      await recorder.init({});

      windowManager.fetchMarket.mockResolvedValue({
        closed: true,
        upPrice: 1.0,
        downPrice: 0.0,
        referencePrice: 94500,
      });

      persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 94500,
        oraclePrices: { close: 95000 },
        feedPricesAtClose: { binance: 95200, chainlink: 95100 },
        marketUpPrices: { 1000: 0.97 },
        marketDownPrices: { 1000: 0.03 },
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: null,
        timers: [],
      };

      await recorder._testing.attemptResolutionCapture(capture, 0);

      expect(capture.resolvedDirection).toBe('up');
      expect(persistence.run).toHaveBeenCalledTimes(1);

      // Verify the SQL uses PostgreSQL $1 placeholders
      const sqlCall = persistence.run.mock.calls[0];
      expect(sqlCall[0]).toContain('INSERT INTO window_close_events');
      expect(sqlCall[0]).toContain('$1');
      expect(sqlCall[0]).toContain('ON CONFLICT (window_id)');
    });

    test('retries when market not yet resolved', async () => {
      await recorder.init({
        windowCloseEventRecorder: {
          resolutionRetryIntervalMs: 1000,
          resolutionMaxWaitMs: 5000,
        },
      });

      // First call: not closed, second call: closed
      windowManager.fetchMarket
        .mockResolvedValueOnce({ closed: false, upPrice: 0.5, downPrice: 0.5 })
        .mockResolvedValueOnce({ closed: true, upPrice: 1.0, downPrice: 0.0, referencePrice: 94500 });

      persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 94500,
        oraclePrices: { close: 95000 },
        feedPricesAtClose: { binance: 95200 },
        marketUpPrices: { 1000: 0.97 },
        marketDownPrices: { 1000: 0.03 },
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: null,
        timers: [],
      };

      // First attempt - not resolved, will schedule retry
      await recorder._testing.attemptResolutionCapture(capture, 0);

      expect(capture.resolvedDirection).toBeNull();
      expect(persistence.run).not.toHaveBeenCalled();

      // Advance timer for retry
      await vi.advanceTimersByTimeAsync(1000);

      expect(capture.resolvedDirection).toBe('up');
      expect(persistence.run).toHaveBeenCalledTimes(1);
    });

    test('times out and persists without resolution', async () => {
      await recorder.init({
        windowCloseEventRecorder: {
          resolutionRetryIntervalMs: 10000,
          resolutionMaxWaitMs: 10000,
        },
      });

      // Always not closed
      windowManager.fetchMarket.mockResolvedValue({
        closed: false,
        upPrice: 0.5,
        downPrice: 0.5,
      });

      persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 94500,
        oraclePrices: { close: 95000 },
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: null,
        timers: [],
      };

      // Exceed max wait
      await recorder._testing.attemptResolutionCapture(capture, 15000);

      // Should persist without resolution
      expect(persistence.run).toHaveBeenCalledTimes(1);
      expect(capture.resolvedDirection).toBeNull();

      const internalStats = recorder._testing.getStats();
      expect(internalStats.resolutionTimeouts).toBe(1);
    });
  });

  describe('Database Persistence', () => {
    test('persists with correct parameters', async () => {
      await recorder.init({});
      persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

      const capture = {
        windowId: 'eth-15m-1700000000',
        symbol: 'eth',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 3250.50,
        oraclePrices: {
          60000: 3260.1,
          30000: 3255.2,
          10000: 3251.0,
          5000: 3250.8,
          1000: 3250.6,
          close: 3250.5,
        },
        feedPricesAtClose: {
          binance: 3251.0,
          chainlink: 3250.5,
          pyth: null,
          polymarket_binance: 3250.9,
        },
        marketUpPrices: {
          60000: 0.72, 30000: 0.65, 10000: 0.55,
          5000: 0.52, 1000: 0.50,
        },
        marketDownPrices: {
          60000: 0.28, 30000: 0.35, 10000: 0.45,
          5000: 0.48, 1000: 0.50,
        },
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: 'down',
        timers: [],
      };

      // Add to active captures so cleanup works
      recorder._testing.getActiveCaptures().set(capture.windowId, capture);

      await recorder._testing.persistWindowCloseEvent(capture);

      expect(persistence.run).toHaveBeenCalledTimes(1);

      const [sql, params] = persistence.run.mock.calls[0];

      // Verify SQL
      expect(sql).toContain('INSERT INTO window_close_events');
      expect(sql).toContain('ON CONFLICT (window_id) DO UPDATE');

      // Verify key params
      expect(params[0]).toBe('eth-15m-1700000000');   // window_id
      expect(params[1]).toBe('eth');                    // symbol
      expect(params[4]).toBe(3260.1);                   // oracle_price_60s
      expect(params[5]).toBe(3255.2);                   // oracle_price_30s
      expect(params[9]).toBe(3250.5);                   // oracle_price_at_close
      expect(params[10]).toBe(3251.0);                  // binance_price_at_close
      expect(params[24]).toBe(3250.50);                 // strike_price
      expect(params[25]).toBe('down');                   // resolved_direction

      expect(capture.captureComplete).toBe(true);

      const internalStats = recorder._testing.getStats();
      expect(internalStats.windowsCaptured).toBe(1);
      expect(internalStats.resolutionsRecorded).toBe(1);
    });

    test('handles database errors', async () => {
      await recorder.init({});
      persistence.run.mockRejectedValue(new Error('connection timeout'));

      const capture = {
        windowId: 'btc-15m-1700000000',
        symbol: 'btc',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 94500,
        oraclePrices: {},
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: null,
        timers: [],
      };

      await expect(
        recorder._testing.persistWindowCloseEvent(capture)
      ).rejects.toThrow(WindowCloseEventRecorderError);

      const internalStats = recorder._testing.getStats();
      expect(internalStats.windowsFailed).toBe(1);
    });

    test('persists null for missing prices', async () => {
      await recorder.init({});
      persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

      const capture = {
        windowId: 'sol-15m-1700000000',
        symbol: 'sol',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: 185,
        oraclePrices: { close: 186 },
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: 'up',
        timers: [],
      };

      recorder._testing.getActiveCaptures().set(capture.windowId, capture);
      await recorder._testing.persistWindowCloseEvent(capture);

      const params = persistence.run.mock.calls[0][1];

      // Interval oracle prices should be null
      expect(params[4]).toBeNull(); // oracle_price_60s
      expect(params[5]).toBeNull(); // oracle_price_30s
      // Feed prices should be null
      expect(params[10]).toBeNull(); // binance
      expect(params[11]).toBeNull(); // pyth
      // Market prices should be null
      expect(params[14]).toBeNull(); // market_up_60s
    });
  });

  describe('Capture Cleanup', () => {
    test('cleanup clears timers and removes from active map', async () => {
      await recorder.init({});

      const timer1 = setTimeout(() => {}, 10000);
      const timer2 = setTimeout(() => {}, 20000);

      const capture = {
        windowId: 'btc-15m-1700000000',
        timers: [timer1, timer2],
      };

      recorder._testing.getActiveCaptures().set('btc-15m-1700000000', capture);
      expect(recorder._testing.getActiveCaptures().has('btc-15m-1700000000')).toBe(true);

      recorder._testing.cleanupCapture('btc-15m-1700000000');

      expect(recorder._testing.getActiveCaptures().has('btc-15m-1700000000')).toBe(false);
    });

    test('cleanup is safe for non-existent window', async () => {
      await recorder.init({});

      // Should not throw
      recorder._testing.cleanupCapture('nonexistent-window');
    });
  });

  describe('Start Capture', () => {
    test('creates capture state with correct fields', async () => {
      await recorder.init({});

      rtdsClient.getCurrentPrice.mockReturnValue(null);
      windowManager.fetchMarket.mockResolvedValue(null);

      const nowSec = Math.floor(Date.now() / 1000);
      const epoch = Math.floor(nowSec / 900) * 900;
      const closeTimeMs = (epoch + 900) * 1000;

      recorder._testing.startCapture(`btc-15m-${epoch}`, 'btc', epoch, closeTimeMs);

      const captures = recorder._testing.getActiveCaptures();
      expect(captures.has(`btc-15m-${epoch}`)).toBe(true);

      const capture = captures.get(`btc-15m-${epoch}`);
      expect(capture.symbol).toBe('btc');
      expect(capture.epoch).toBe(epoch);
      expect(capture.closeTimeMs).toBe(closeTimeMs);
      expect(capture.oraclePrices).toEqual({});
      expect(capture.captureStarted).toBe(true);
      expect(capture.captureComplete).toBe(false);
    });

    test('does not duplicate capture for same window', async () => {
      await recorder.init({});

      rtdsClient.getCurrentPrice.mockReturnValue(null);
      windowManager.fetchMarket.mockResolvedValue(null);

      const epoch = 1700000000;
      const closeTimeMs = (epoch + 900) * 1000;

      recorder._testing.startCapture('btc-15m-1700000000', 'btc', epoch, closeTimeMs);
      recorder._testing.startCapture('btc-15m-1700000000', 'btc', epoch, closeTimeMs);

      const captures = recorder._testing.getActiveCaptures();
      expect(captures.size).toBe(1);
    });
  });

  describe('Window Scanning', () => {
    test('scan picks up windows within capture window', async () => {
      // Calculate a properly aligned epoch: find the current 15-min window
      // and set time to 80 seconds before its close
      const alignedEpoch = Math.floor(1700000000 / 900) * 900; // Properly aligned
      const closeTimeSec = alignedEpoch + 900;
      const nowSec = closeTimeSec - 80; // 80s before close = within 90s capture window
      vi.setSystemTime(new Date(nowSec * 1000));

      rtdsClient.getCurrentPrice.mockReturnValue(null);
      windowManager.fetchMarket.mockResolvedValue(null);

      await recorder.init({});

      // The scan should have picked up windows for all cryptos
      const captures = recorder._testing.getActiveCaptures();
      // At least one capture should have started (for all 4 cryptos in the current window)
      expect(captures.size).toBeGreaterThan(0);

      // Verify they're for the correct epoch
      const firstKey = captures.keys().next().value;
      expect(firstKey).toContain(`-15m-${alignedEpoch}`);
    });
  });

  describe('Edge Cases', () => {
    test('handles strike price of 0 (fallback)', async () => {
      await recorder.init({});
      persistence.run.mockResolvedValue({ lastInsertRowid: 1, changes: 1 });

      const capture = {
        windowId: 'xrp-15m-1700000000',
        symbol: 'xrp',
        epoch: 1700000000,
        closeTimeMs: 1700000900000,
        strikePrice: null, // Unknown strike
        oraclePrices: {},
        feedPricesAtClose: {},
        marketUpPrices: {},
        marketDownPrices: {},
        captureStarted: true,
        captureComplete: false,
        resolvedDirection: null,
        timers: [],
      };

      recorder._testing.getActiveCaptures().set(capture.windowId, capture);
      await recorder._testing.persistWindowCloseEvent(capture);

      const params = persistence.run.mock.calls[0][1];
      expect(params[24]).toBe(0); // strike_price defaults to 0
    });

    test('binary settlement: oracle at exactly strike = down', () => {
      const capture = {
        oraclePrices: { close: 94500 },
        strikePrice: 94500,
      };
      const market = { upPrice: 0.5, downPrice: 0.5 };

      const result = recorder._testing.determineResolution(capture, market);
      expect(result).toBe('down'); // At exact strike, resolved DOWN
    });
  });
});
