/**
 * Oracle Edge Signal Generator Class Tests
 *
 * Tests for the OracleEdgeSignalGenerator class:
 * - Condition evaluation (all 5 conditions)
 * - Direction determination (FADE_UP vs FADE_DOWN)
 * - Confidence calculation
 * - Signal generation
 * - Subscription pattern
 * - Statistics tracking
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { OracleEdgeSignalGenerator } from '../generator.js';
import { SignalDirection, DEFAULT_CONFIG, OracleEdgeSignalError } from '../types.js';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Mock staleness detector
const createMockStalenessDetector = (overrides = {}) => ({
  getStaleness: vi.fn(() => ({
    symbol: 'btc',
    is_stale: true,
    score: 0.75,
    conditions: {},
    inputs: {
      time_since_update_ms: 20000, // 20 seconds stale
    },
    ...overrides,
  })),
});

// Mock divergence tracker
const createMockDivergenceTracker = (overrides = {}) => ({
  getSpread: vi.fn(() => ({
    ui_price: 0.58, // UI shows above strike (0.5)
    oracle_price: 0.52,
    pct: 0.003, // 0.3% divergence
    raw: 0.06,
    direction: 'ui_higher',
    last_updated: new Date().toISOString(),
    ...overrides,
  })),
});

// Create valid window data
const createWindowData = (overrides = {}) => ({
  window_id: 'btc-15m-1706745600',
  crypto: 'btc',
  time_remaining_ms: 25000, // 25 seconds to expiry
  market_price: 0.72, // 72% conviction
  token_id_up: '0xUP123',
  token_id_down: '0xDOWN456',
  ...overrides,
});

describe('OracleEdgeSignalGenerator', () => {
  let generator;
  let mockLogger;
  let mockStalenessDetector;
  let mockDivergenceTracker;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockStalenessDetector = createMockStalenessDetector();
    mockDivergenceTracker = createMockDivergenceTracker();

    generator = new OracleEdgeSignalGenerator({
      config: DEFAULT_CONFIG,
      logger: mockLogger,
      stalenessDetector: mockStalenessDetector,
      divergenceTracker: mockDivergenceTracker,
    });
  });

  describe('Condition 1: Time to expiry', () => {
    test('generates signal when time within threshold', () => {
      const windowData = createWindowData({ time_remaining_ms: 25000 }); // Within 30s

      const signal = generator.evaluateWindow(windowData);

      expect(signal).not.toBeNull();
      expect(signal.window_id).toBe('btc-15m-1706745600');
    });

    test('returns null when time exceeds threshold', () => {
      const windowData = createWindowData({ time_remaining_ms: 35000 }); // Exceeds 30s

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'too_early',
      }));
    });

    test('returns null when exactly at threshold boundary', () => {
      const windowData = createWindowData({ time_remaining_ms: 30001 }); // Just over

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });
  });

  describe('Condition 2: Oracle staleness', () => {
    test('generates signal when oracle is stale enough', () => {
      mockStalenessDetector.getStaleness.mockReturnValue({
        is_stale: true,
        score: 0.8,
        inputs: { time_since_update_ms: 20000 }, // 20s > 15s threshold
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).not.toBeNull();
    });

    test('returns null when oracle not stale enough', () => {
      mockStalenessDetector.getStaleness.mockReturnValue({
        is_stale: false,
        score: 0.3,
        inputs: { time_since_update_ms: 10000 }, // 10s < 15s threshold
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'oracle_not_stale',
      }));
    });

    test('returns null when staleness data unavailable', () => {
      mockStalenessDetector.getStaleness.mockImplementation(() => {
        throw new Error('Not initialized');
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('staleness_data_unavailable', expect.any(Object));
    });
  });

  describe('Condition 3: Clear direction (strike threshold)', () => {
    test('generates signal when UI clearly above strike', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.58, // 8% above 0.5 strike > 5% threshold
        oracle_price: 0.52,
        pct: 0.003,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).not.toBeNull();
      expect(signal.direction).toBe(SignalDirection.FADE_UP);
    });

    test('generates signal when UI clearly below strike', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.42, // 8% below 0.5 strike > 5% threshold
        oracle_price: 0.45,
        pct: 0.002,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).not.toBeNull();
      expect(signal.direction).toBe(SignalDirection.FADE_DOWN);
    });

    test('returns null when direction unclear (near strike)', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.52, // Only 2% above strike < 5% threshold
        oracle_price: 0.51,
        pct: 0.001,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'unclear_direction',
      }));
    });
  });

  describe('Condition 4: Chainlink deviation threshold', () => {
    test('generates signal when divergence within threshold', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.58,
        oracle_price: 0.52,
        pct: 0.003, // 0.3% < 0.5% threshold
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).not.toBeNull();
    });

    test('returns null when divergence exceeds threshold', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.58,
        oracle_price: 0.52,
        pct: 0.006, // 0.6% > 0.5% threshold
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'divergence_too_large',
      }));
    });
  });

  describe('Condition 5: Market conviction', () => {
    test('generates signal when market shows high UP conviction', () => {
      const windowData = createWindowData({ market_price: 0.72 }); // 72% > 65% threshold

      const signal = generator.evaluateWindow(windowData);

      expect(signal).not.toBeNull();
    });

    test('generates signal when market shows high DOWN conviction', () => {
      const windowData = createWindowData({ market_price: 0.28 }); // 28% < 35% (1 - 0.65)

      // Also need to make divergence show DOWN direction
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.42,
        oracle_price: 0.45,
        pct: 0.002,
      });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).not.toBeNull();
    });

    test('returns null when conviction insufficient', () => {
      const windowData = createWindowData({ market_price: 0.55 }); // 55% between 35-65%

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'insufficient_conviction',
      }));
    });
  });

  describe('Signal generation (all conditions met)', () => {
    test('generates complete signal object', () => {
      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toMatchObject({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
        direction: SignalDirection.FADE_UP,
        side: 'buy',
      });
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.token_id).toBeDefined();
      expect(signal.inputs).toBeDefined();
      expect(signal.generated_at).toBeDefined();
    });

    test('includes all inputs in signal', () => {
      const signal = generator.evaluateWindow(createWindowData());

      expect(signal.inputs).toMatchObject({
        time_remaining_ms: 25000,
        market_price: 0.72,
        ui_price: expect.any(Number),
        oracle_price: expect.any(Number),
        oracle_staleness_ms: expect.any(Number),
        spread_pct: expect.any(Number),
        strike: 0.5,
        staleness_score: expect.any(Number),
      });
    });

    test('logs signal generation', () => {
      generator.evaluateWindow(createWindowData());

      expect(mockLogger.info).toHaveBeenCalledWith('signal_generated', expect.objectContaining({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
        direction: SignalDirection.FADE_UP,
      }));
    });
  });

  describe('Direction determination', () => {
    test('FADE_UP when UI shows price above strike', () => {
      const direction = generator.determineDirection(0.6, 0.55, 0.5);

      expect(direction).toBe(SignalDirection.FADE_UP);
    });

    test('FADE_DOWN when UI shows price below strike', () => {
      const direction = generator.determineDirection(0.4, 0.45, 0.5);

      expect(direction).toBe(SignalDirection.FADE_DOWN);
    });

    test('FADE_DOWN when UI exactly at strike', () => {
      const direction = generator.determineDirection(0.5, 0.5, 0.5);

      expect(direction).toBe(SignalDirection.FADE_DOWN); // Below or equal goes to DOWN
    });
  });

  describe('Token ID selection', () => {
    test('selects DOWN token when FADE_UP (betting against UI showing UP)', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.6, // UI shows UP
        oracle_price: 0.55,
        pct: 0.003,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal.direction).toBe(SignalDirection.FADE_UP);
      expect(signal.token_id).toBe('0xDOWN456'); // We buy DOWN token
    });

    test('selects UP token when FADE_DOWN (betting against UI showing DOWN)', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.4, // UI shows DOWN
        oracle_price: 0.42,
        pct: 0.002,
      });

      const windowData = createWindowData({ market_price: 0.25 });
      const signal = generator.evaluateWindow(windowData);

      expect(signal.direction).toBe(SignalDirection.FADE_DOWN);
      expect(signal.token_id).toBe('0xUP123'); // We buy UP token
    });
  });

  describe('Confidence calculation', () => {
    test('returns value between 0 and 1', () => {
      const confidence = generator.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });

    test('higher staleness increases confidence', () => {
      const lowStaleness = generator.calculateConfidence({
        stalenessMs: 15000,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      const highStaleness = generator.calculateConfidence({
        stalenessMs: 45000,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      expect(highStaleness).toBeGreaterThan(lowStaleness);
    });

    test('larger divergence increases confidence', () => {
      const lowDivergence = generator.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: 0.001,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      const highDivergence = generator.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: 0.004,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      expect(highDivergence).toBeGreaterThan(lowDivergence);
    });

    test('less time remaining increases confidence', () => {
      const moreTime = generator.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      const lessTime = generator.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: 0.003,
        timeRemainingMs: 5000,
        marketPrice: 0.72,
      });

      expect(lessTime).toBeGreaterThan(moreTime);
    });

    test('caps confidence at 1.0', () => {
      const confidence = generator.calculateConfidence({
        stalenessMs: 90000, // 90 seconds - very stale
        spreadPct: 0.01, // Large divergence
        timeRemainingMs: 1000, // Very little time
        marketPrice: 0.95,
      });

      expect(confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('evaluateAllWindows', () => {
    test('returns array of signals', () => {
      const windows = [
        createWindowData({ window_id: 'btc-15m-1' }),
        createWindowData({ window_id: 'eth-15m-2', crypto: 'eth' }),
      ];

      const signals = generator.evaluateAllWindows(windows);

      expect(Array.isArray(signals)).toBe(true);
      expect(signals.length).toBe(2);
    });

    test('filters out windows that do not generate signals', () => {
      const windows = [
        createWindowData({ window_id: 'btc-15m-1' }),
        createWindowData({ window_id: 'btc-15m-2', time_remaining_ms: 45000 }), // Too early
      ];

      const signals = generator.evaluateAllWindows(windows);

      expect(signals.length).toBe(1);
      expect(signals[0].window_id).toBe('btc-15m-1');
    });

    test('returns empty array for non-array input', () => {
      expect(generator.evaluateAllWindows(null)).toEqual([]);
      expect(generator.evaluateAllWindows(undefined)).toEqual([]);
      expect(generator.evaluateAllWindows('string')).toEqual([]);
    });
  });

  describe('Subscription pattern', () => {
    test('subscribe returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = generator.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    test('subscriber receives signal on generation', () => {
      const callback = vi.fn();
      generator.subscribe(callback);

      generator.evaluateWindow(createWindowData());

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        window_id: 'btc-15m-1706745600',
        symbol: 'btc',
        direction: SignalDirection.FADE_UP,
      }));
    });

    test('unsubscribe stops notifications', () => {
      const callback = vi.fn();
      const unsubscribe = generator.subscribe(callback);

      unsubscribe();
      generator.evaluateWindow(createWindowData());

      expect(callback).not.toHaveBeenCalled();
    });

    test('multiple subscribers all receive signal', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      generator.subscribe(callback1);
      generator.subscribe(callback2);

      generator.evaluateWindow(createWindowData());

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    test('subscriber error does not affect other subscribers', () => {
      const errorCallback = vi.fn(() => {
        throw new Error('Callback error');
      });
      const successCallback = vi.fn();

      generator.subscribe(errorCallback);
      generator.subscribe(successCallback);

      generator.evaluateWindow(createWindowData());

      expect(successCallback).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith('subscriber_callback_error', expect.any(Object));
    });

    test('throws when callback is not a function', () => {
      expect(() => generator.subscribe('not a function')).toThrow(OracleEdgeSignalError);
      expect(() => generator.subscribe(null)).toThrow(OracleEdgeSignalError);
    });

    test('clearSubscriptions removes all subscribers', () => {
      const callback = vi.fn();
      generator.subscribe(callback);

      generator.clearSubscriptions();
      generator.evaluateWindow(createWindowData());

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Statistics tracking', () => {
    test('tracks evaluations total', () => {
      generator.evaluateWindow(createWindowData());
      generator.evaluateWindow(createWindowData({ time_remaining_ms: 45000 })); // No signal

      const stats = generator.getStats();

      expect(stats.evaluations_total).toBe(2);
    });

    test('tracks signals generated', () => {
      generator.evaluateWindow(createWindowData());
      generator.evaluateWindow(createWindowData({ window_id: 'eth-15m-2' }));

      const stats = generator.getStats();

      expect(stats.signals_generated).toBe(2);
    });

    test('tracks signals by direction', () => {
      // Generate FADE_UP signal
      generator.evaluateWindow(createWindowData());

      // Generate FADE_DOWN signal
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.42,
        oracle_price: 0.45,
        pct: 0.002,
      });
      generator.evaluateWindow(createWindowData({
        window_id: 'btc-15m-2',
        market_price: 0.25,
      }));

      const stats = generator.getStats();

      expect(stats.signals_by_direction.fade_up).toBe(1);
      expect(stats.signals_by_direction.fade_down).toBe(1);
    });

    test('tracks signals by symbol', () => {
      generator.evaluateWindow(createWindowData({ window_id: 'btc-1', crypto: 'btc' }));
      generator.evaluateWindow(createWindowData({ window_id: 'btc-2', crypto: 'btc' }));
      generator.evaluateWindow(createWindowData({ window_id: 'eth-1', crypto: 'eth' }));

      const stats = generator.getStats();

      expect(stats.signals_by_symbol.btc).toBe(2);
      expect(stats.signals_by_symbol.eth).toBe(1);
    });

    test('calculates average confidence', () => {
      generator.evaluateWindow(createWindowData());
      generator.evaluateWindow(createWindowData({ window_id: 'btc-15m-2' }));

      const stats = generator.getStats();

      expect(stats.avg_confidence).toBeGreaterThan(0);
      expect(stats.avg_confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Edge cases', () => {
    test('handles null window data', () => {
      const signal = generator.evaluateWindow(null);

      expect(signal).toBeNull();
    });

    test('handles undefined window data', () => {
      const signal = generator.evaluateWindow(undefined);

      expect(signal).toBeNull();
    });

    test('handles missing window_id', () => {
      const windowData = createWindowData();
      delete windowData.window_id;

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles null staleness detector', () => {
      const generatorWithoutDeps = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector: null,
        divergenceTracker: mockDivergenceTracker,
      });

      const signal = generatorWithoutDeps.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
    });

    test('handles null divergence tracker', () => {
      const generatorWithoutDeps = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector: mockStalenessDetector,
        divergenceTracker: null,
      });

      const signal = generatorWithoutDeps.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
    });

    test('handles divergence tracker returning null', () => {
      mockDivergenceTracker.getSpread.mockReturnValue(null);

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
    });

    test('handles divergence tracker with null ui_price', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: null,
        oracle_price: 0.52,
        pct: 0.003,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
    });

    test('handles negative time_remaining_ms (expired window)', () => {
      const windowData = createWindowData({ time_remaining_ms: -5000 });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'window_expired',
      }));
    });

    test('handles zero time_remaining_ms (just expired)', () => {
      const windowData = createWindowData({ time_remaining_ms: 0 });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles NaN time_remaining_ms', () => {
      const windowData = createWindowData({ time_remaining_ms: NaN });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'invalid_time_remaining',
      }));
    });

    test('handles Infinity time_remaining_ms', () => {
      const windowData = createWindowData({ time_remaining_ms: Infinity });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles NaN market_price', () => {
      const windowData = createWindowData({ market_price: NaN });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'invalid_market_price',
      }));
    });

    test('handles negative market_price', () => {
      const windowData = createWindowData({ market_price: -0.5 });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles market_price > 1', () => {
      const windowData = createWindowData({ market_price: 1.5 });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles missing token_id_up', () => {
      const windowData = createWindowData();
      delete windowData.token_id_up;

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith('window_evaluated_no_signal', expect.objectContaining({
        reason: 'missing_token_ids',
      }));
    });

    test('handles missing token_id_down', () => {
      const windowData = createWindowData();
      delete windowData.token_id_down;

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles null token_id_up', () => {
      const windowData = createWindowData({ token_id_up: null });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles empty string token_id_down', () => {
      const windowData = createWindowData({ token_id_down: '' });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull();
    });

    test('handles divergence tracker with null oracle_price', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.58,
        oracle_price: null,
        pct: 0.003,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
    });

    test('handles divergence tracker with NaN oracle_price', () => {
      mockDivergenceTracker.getSpread.mockReturnValue({
        ui_price: 0.58,
        oracle_price: NaN,
        pct: 0.003,
      });

      const signal = generator.evaluateWindow(createWindowData());

      expect(signal).toBeNull();
    });

    test('handles string time_remaining_ms (type coercion)', () => {
      const windowData = createWindowData({ time_remaining_ms: '25000' });

      const signal = generator.evaluateWindow(windowData);

      expect(signal).toBeNull(); // Should reject non-number type
    });
  });

  describe('Confidence calculation edge cases', () => {
    test('handles NaN staleness in confidence calculation', () => {
      const confidence = generator.calculateConfidence({
        stalenessMs: NaN,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
      expect(Number.isFinite(confidence)).toBe(true);
    });

    test('handles negative staleness in confidence calculation', () => {
      const confidence = generator.calculateConfidence({
        stalenessMs: -1000,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    });

    test('handles NaN spreadPct in confidence calculation', () => {
      const confidence = generator.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: NaN,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      expect(Number.isFinite(confidence)).toBe(true);
    });

    test('handles zero maxTimeThresholdMs config safely', () => {
      const generatorZeroConfig = new OracleEdgeSignalGenerator({
        config: { ...DEFAULT_CONFIG, maxTimeThresholdMs: 0 },
        logger: mockLogger,
        stalenessDetector: mockStalenessDetector,
        divergenceTracker: mockDivergenceTracker,
      });

      const confidence = generatorZeroConfig.calculateConfidence({
        stalenessMs: 20000,
        spreadPct: 0.003,
        timeRemainingMs: 25000,
        marketPrice: 0.72,
      });

      // Should use fallback and not throw/return NaN
      expect(Number.isFinite(confidence)).toBe(true);
    });
  });
});
