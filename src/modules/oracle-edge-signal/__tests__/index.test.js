/**
 * Oracle Edge Signal Module Interface Tests
 *
 * Tests for the public module interface:
 * - init/shutdown lifecycle
 * - evaluateWindow/evaluateAllWindows
 * - subscribe event subscription
 * - getState
 * - Error handling
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as oracleEdgeSignal from '../index.js';
import { OracleEdgeSignalError, OracleEdgeSignalErrorCodes, SignalDirection } from '../types.js';

// Mock the logger module
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock staleness-detector module
vi.mock('../../staleness-detector/index.js', () => ({
  getStaleness: vi.fn(() => ({
    symbol: 'btc',
    is_stale: true,
    score: 0.75,
    conditions: {},
    inputs: {
      time_since_update_ms: 20000,
    },
  })),
}));

// Mock divergence-tracker module
vi.mock('../../divergence-tracker/index.js', () => ({
  getSpread: vi.fn(() => ({
    ui_price: 0.58,
    oracle_price: 0.52,
    pct: 0.003,
    raw: 0.06,
    direction: 'ui_higher',
    last_updated: new Date().toISOString(),
  })),
}));

// Create valid window data
const createWindowData = (overrides = {}) => ({
  window_id: 'btc-15m-1706745600',
  crypto: 'btc',
  time_remaining_ms: 25000,
  market_price: 0.72,
  token_id_up: '0xUP123',
  token_id_down: '0xDOWN456',
  ...overrides,
});

describe('Oracle Edge Signal Module', () => {
  beforeEach(async () => {
    // Reset module state
    await oracleEdgeSignal.shutdown();
  });

  afterEach(async () => {
    await oracleEdgeSignal.shutdown();
  });

  describe('init', () => {
    test('initializes with default config', async () => {
      await oracleEdgeSignal.init();

      const state = oracleEdgeSignal.getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.config.maxTimeThresholdMs).toBe(30000);
      expect(state.config.minStalenessMs).toBe(15000);
      expect(state.config.strikeThreshold).toBe(0.05);
      expect(state.config.chainlinkDeviationThresholdPct).toBe(0.005);
      expect(state.config.confidenceThreshold).toBe(0.65);
    });

    test('initializes with custom config', async () => {
      await oracleEdgeSignal.init({
        oracleEdgeSignal: {
          maxTimeThresholdMs: 45000,
          minStalenessMs: 20000,
          strikeThreshold: 0.10,
          chainlinkDeviationThresholdPct: 0.008,
          confidenceThreshold: 0.70,
        },
      });

      const state = oracleEdgeSignal.getState();

      expect(state.config.maxTimeThresholdMs).toBe(45000);
      expect(state.config.minStalenessMs).toBe(20000);
      expect(state.config.strikeThreshold).toBe(0.10);
      expect(state.config.chainlinkDeviationThresholdPct).toBe(0.008);
      expect(state.config.confidenceThreshold).toBe(0.70);
    });

    test('is idempotent', async () => {
      await oracleEdgeSignal.init();
      await oracleEdgeSignal.init(); // Second call should be no-op

      const state = oracleEdgeSignal.getState();
      expect(state.initialized).toBe(true);
    });

    test('throws on invalid maxTimeThresholdMs', async () => {
      await expect(
        oracleEdgeSignal.init({
          oracleEdgeSignal: { maxTimeThresholdMs: 0 },
        })
      ).rejects.toThrow(OracleEdgeSignalError);
    });

    test('throws on invalid minStalenessMs', async () => {
      await expect(
        oracleEdgeSignal.init({
          oracleEdgeSignal: { minStalenessMs: -1 },
        })
      ).rejects.toThrow(OracleEdgeSignalError);
    });

    test('throws on invalid strikeThreshold', async () => {
      await expect(
        oracleEdgeSignal.init({
          oracleEdgeSignal: { strikeThreshold: 0.6 },
        })
      ).rejects.toThrow(OracleEdgeSignalError);
    });

    test('throws on invalid chainlinkDeviationThresholdPct', async () => {
      await expect(
        oracleEdgeSignal.init({
          oracleEdgeSignal: { chainlinkDeviationThresholdPct: 0 },
        })
      ).rejects.toThrow(OracleEdgeSignalError);
    });

    test('throws on invalid confidenceThreshold', async () => {
      await expect(
        oracleEdgeSignal.init({
          oracleEdgeSignal: { confidenceThreshold: 1.5 },
        })
      ).rejects.toThrow(OracleEdgeSignalError);
    });
  });

  describe('evaluateWindow', () => {
    test('throws when not initialized', () => {
      expect(() => oracleEdgeSignal.evaluateWindow(createWindowData())).toThrow(OracleEdgeSignalError);
      expect(() => oracleEdgeSignal.evaluateWindow(createWindowData())).toThrow('not initialized');
    });

    test('returns signal for valid window', async () => {
      await oracleEdgeSignal.init();

      const signal = oracleEdgeSignal.evaluateWindow(createWindowData());

      expect(signal).not.toBeNull();
      expect(signal).toMatchObject({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
        direction: SignalDirection.FADE_UP,
        side: 'buy',
      });
    });

    test('returns null when conditions not met', async () => {
      await oracleEdgeSignal.init();

      const signal = oracleEdgeSignal.evaluateWindow(
        createWindowData({ time_remaining_ms: 45000 }) // Too early
      );

      expect(signal).toBeNull();
    });

    test('signal includes all required fields', async () => {
      await oracleEdgeSignal.init();

      const signal = oracleEdgeSignal.evaluateWindow(createWindowData());

      expect(signal).toHaveProperty('window_id');
      expect(signal).toHaveProperty('symbol');
      expect(signal).toHaveProperty('direction');
      expect(signal).toHaveProperty('confidence');
      expect(signal).toHaveProperty('token_id');
      expect(signal).toHaveProperty('side');
      expect(signal).toHaveProperty('inputs');
      expect(signal).toHaveProperty('generated_at');
    });
  });

  describe('evaluateAllWindows', () => {
    test('throws when not initialized', () => {
      expect(() => oracleEdgeSignal.evaluateAllWindows([])).toThrow(OracleEdgeSignalError);
    });

    test('returns array of signals', async () => {
      await oracleEdgeSignal.init();

      const windows = [
        createWindowData({ window_id: 'btc-15m-1' }),
        createWindowData({ window_id: 'eth-15m-2' }),
      ];

      const signals = oracleEdgeSignal.evaluateAllWindows(windows);

      expect(Array.isArray(signals)).toBe(true);
      expect(signals.length).toBe(2);
    });

    test('filters out windows without signals', async () => {
      await oracleEdgeSignal.init();

      const windows = [
        createWindowData({ window_id: 'btc-15m-1' }),
        createWindowData({ window_id: 'btc-15m-2', time_remaining_ms: 45000 }),
      ];

      const signals = oracleEdgeSignal.evaluateAllWindows(windows);

      expect(signals.length).toBe(1);
    });

    test('returns empty array for empty input', async () => {
      await oracleEdgeSignal.init();

      const signals = oracleEdgeSignal.evaluateAllWindows([]);

      expect(signals).toEqual([]);
    });
  });

  describe('subscribe', () => {
    test('throws when not initialized', () => {
      expect(() => oracleEdgeSignal.subscribe(() => {})).toThrow(OracleEdgeSignalError);
    });

    test('throws when callback is not a function', async () => {
      await oracleEdgeSignal.init();

      expect(() => oracleEdgeSignal.subscribe('not a function')).toThrow(OracleEdgeSignalError);
      expect(() => oracleEdgeSignal.subscribe(null)).toThrow(OracleEdgeSignalError);
    });

    test('returns unsubscribe function', async () => {
      await oracleEdgeSignal.init();

      const unsubscribe = oracleEdgeSignal.subscribe(() => {});

      expect(typeof unsubscribe).toBe('function');
    });

    test('subscriber receives signal on generation', async () => {
      await oracleEdgeSignal.init();

      const callback = vi.fn();
      oracleEdgeSignal.subscribe(callback);

      oracleEdgeSignal.evaluateWindow(createWindowData());

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
      }));
    });

    test('unsubscribe stops notifications', async () => {
      await oracleEdgeSignal.init();

      const callback = vi.fn();
      const unsubscribe = oracleEdgeSignal.subscribe(callback);

      unsubscribe();
      oracleEdgeSignal.evaluateWindow(createWindowData());

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    test('returns uninitialized state before init', () => {
      const state = oracleEdgeSignal.getState();

      expect(state.initialized).toBe(false);
      expect(state.stats.signals_generated).toBe(0);
      expect(state.stats.evaluations_total).toBe(0);
      expect(state.config).toBeNull();
    });

    test('returns initialized state after init', async () => {
      await oracleEdgeSignal.init();

      const state = oracleEdgeSignal.getState();

      expect(state.initialized).toBe(true);
      expect(state.stats).toBeDefined();
      expect(state.config).toBeDefined();
    });

    test('includes all expected state properties', async () => {
      await oracleEdgeSignal.init();

      const state = oracleEdgeSignal.getState();

      expect(state).toHaveProperty('initialized');
      expect(state).toHaveProperty('stats');
      expect(state).toHaveProperty('config');

      expect(state.stats).toHaveProperty('signals_generated');
      expect(state.stats).toHaveProperty('evaluations_total');
      expect(state.stats).toHaveProperty('signals_by_direction');
      expect(state.stats).toHaveProperty('signals_by_symbol');
      expect(state.stats).toHaveProperty('avg_confidence');
    });

    test('stats update after signal generation', async () => {
      await oracleEdgeSignal.init();

      oracleEdgeSignal.evaluateWindow(createWindowData());

      const state = oracleEdgeSignal.getState();

      expect(state.stats.signals_generated).toBe(1);
      expect(state.stats.evaluations_total).toBe(1);
      expect(state.stats.signals_by_direction.fade_up).toBe(1);
      expect(state.stats.signals_by_symbol.btc).toBe(1);
    });
  });

  describe('shutdown', () => {
    test('clears initialized state', async () => {
      await oracleEdgeSignal.init();
      expect(oracleEdgeSignal.getState().initialized).toBe(true);

      await oracleEdgeSignal.shutdown();

      expect(oracleEdgeSignal.getState().initialized).toBe(false);
    });

    test('is idempotent', async () => {
      await oracleEdgeSignal.init();
      await oracleEdgeSignal.shutdown();
      await oracleEdgeSignal.shutdown(); // Should not throw

      expect(oracleEdgeSignal.getState().initialized).toBe(false);
    });

    test('allows re-initialization after shutdown', async () => {
      await oracleEdgeSignal.init();
      await oracleEdgeSignal.shutdown();

      await oracleEdgeSignal.init({
        oracleEdgeSignal: { maxTimeThresholdMs: 45000 },
      });

      const state = oracleEdgeSignal.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.maxTimeThresholdMs).toBe(45000);
    });

    test('clears subscriptions on shutdown', async () => {
      await oracleEdgeSignal.init();

      const callback = vi.fn();
      oracleEdgeSignal.subscribe(callback);

      await oracleEdgeSignal.shutdown();
      await oracleEdgeSignal.init();

      oracleEdgeSignal.evaluateWindow(createWindowData());

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('error codes', () => {
    test('exports expected error codes', () => {
      expect(OracleEdgeSignalErrorCodes.NOT_INITIALIZED).toBe('ORACLE_EDGE_SIGNAL_NOT_INITIALIZED');
      expect(OracleEdgeSignalErrorCodes.INVALID_WINDOW).toBe('ORACLE_EDGE_SIGNAL_INVALID_WINDOW');
      expect(OracleEdgeSignalErrorCodes.INVALID_CONFIG).toBe('ORACLE_EDGE_SIGNAL_INVALID_CONFIG');
      expect(OracleEdgeSignalErrorCodes.DEPENDENCY_UNAVAILABLE).toBe('ORACLE_EDGE_SIGNAL_DEPENDENCY_UNAVAILABLE');
      expect(OracleEdgeSignalErrorCodes.SUBSCRIPTION_FAILED).toBe('ORACLE_EDGE_SIGNAL_SUBSCRIPTION_FAILED');
    });

    test('OracleEdgeSignalError has correct properties', () => {
      const error = new OracleEdgeSignalError(
        OracleEdgeSignalErrorCodes.INVALID_CONFIG,
        'Test error message',
        { config: 'test' }
      );

      expect(error.code).toBe('ORACLE_EDGE_SIGNAL_INVALID_CONFIG');
      expect(error.message).toBe('Test error message');
      expect(error.context).toEqual({ config: 'test' });
      expect(error.name).toBe('OracleEdgeSignalError');
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('SignalDirection export', () => {
    test('exports SignalDirection enum', () => {
      expect(SignalDirection.FADE_UP).toBe('fade_up');
      expect(SignalDirection.FADE_DOWN).toBe('fade_down');
    });
  });
});
