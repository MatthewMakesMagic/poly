/**
 * Staleness Detector Unit Tests
 *
 * Tests for the StalenessDetector class core logic:
 * - Staleness condition evaluation
 * - Score calculation with edge cases
 * - State transitions
 * - Event emission
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { StalenessDetector } from '../detector.js';
import { DEFAULT_CONFIG, EventTypes } from '../types.js';

describe('StalenessDetector', () => {
  let detector;
  let mockLogger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    detector = new StalenessDetector({
      config: DEFAULT_CONFIG,
      logger: mockLogger,
    });
  });

  describe('evaluateStaleness', () => {
    test('returns not stale when all conditions are false', () => {
      const oracleState = {
        price: 95000,
        last_update_at: Date.now() - 5000, // 5 seconds ago (under threshold)
      };

      const divergence = {
        ui_price: 95000,
        oracle_price: 95000,
        spread_pct: 0, // No divergence
      };

      const result = detector.evaluateStaleness('btc', oracleState, divergence);

      expect(result.is_stale).toBe(false);
      expect(result.score).toBe(0);
      expect(result.conditions.time_stale).toBe(false);
      expect(result.conditions.has_divergence).toBe(false);
      expect(result.conditions.update_unlikely).toBe(true); // 0 < 0.5%
    });

    test('returns not stale when only time condition is met', () => {
      const oracleState = {
        price: 95000,
        last_update_at: Date.now() - 20000, // 20 seconds ago (over threshold)
      };

      const divergence = {
        ui_price: 95000,
        oracle_price: 95000,
        spread_pct: 0.0005, // 0.05% - below min divergence threshold
      };

      const result = detector.evaluateStaleness('btc', oracleState, divergence);

      expect(result.is_stale).toBe(false);
      expect(result.conditions.time_stale).toBe(true);
      expect(result.conditions.has_divergence).toBe(false);
      expect(result.conditions.update_unlikely).toBe(true);
    });

    test('returns not stale when divergence exceeds chainlink threshold', () => {
      const oracleState = {
        price: 95000,
        last_update_at: Date.now() - 20000, // 20 seconds ago
      };

      const divergence = {
        ui_price: 95500,
        oracle_price: 95000,
        spread_pct: 0.006, // 0.6% - above chainlink threshold, oracle likely to update
      };

      const result = detector.evaluateStaleness('btc', oracleState, divergence);

      expect(result.is_stale).toBe(false);
      expect(result.conditions.time_stale).toBe(true);
      expect(result.conditions.has_divergence).toBe(true);
      expect(result.conditions.update_unlikely).toBe(false);
    });

    test('returns stale when all conditions are met', () => {
      const oracleState = {
        price: 95000,
        last_update_at: Date.now() - 20000, // 20 seconds ago
      };

      const divergence = {
        ui_price: 95250,
        oracle_price: 95000,
        spread_pct: 0.0026, // 0.26% - between min (0.1%) and chainlink (0.5%)
      };

      const result = detector.evaluateStaleness('btc', oracleState, divergence);

      expect(result.is_stale).toBe(true);
      expect(result.score).toBeGreaterThan(0);
      expect(result.conditions.time_stale).toBe(true);
      expect(result.conditions.has_divergence).toBe(true);
      expect(result.conditions.update_unlikely).toBe(true);
    });

    test('includes all expected fields in evaluation result', () => {
      const oracleState = {
        price: 95000,
        last_update_at: Date.now() - 20000,
      };

      const divergence = {
        ui_price: 95250,
        oracle_price: 95000,
        spread_pct: 0.003,
      };

      const result = detector.evaluateStaleness('btc', oracleState, divergence, 0.85);

      expect(result).toHaveProperty('symbol', 'btc');
      expect(result).toHaveProperty('is_stale');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('conditions');
      expect(result).toHaveProperty('inputs');
      expect(result).toHaveProperty('evaluated_at');

      expect(result.inputs).toHaveProperty('time_since_update_ms');
      expect(result.inputs).toHaveProperty('ui_price', 95250);
      expect(result.inputs).toHaveProperty('oracle_price', 95000);
      expect(result.inputs).toHaveProperty('divergence_pct', 0.003);
      expect(result.inputs).toHaveProperty('p_no_update', 0.85);
    });
  });

  describe('calculateScore', () => {
    test('returns 0 when no divergence', () => {
      const score = detector.calculateScore({
        timeSinceUpdate: 30000,
        absDivergencePct: 0.0005, // below min divergence
        conditions: {
          time_stale: true,
          has_divergence: false,
          update_unlikely: true,
        },
        pNoUpdate: null,
      });

      expect(score).toBe(0);
    });

    test('calculates positive score when all conditions met', () => {
      const score = detector.calculateScore({
        timeSinceUpdate: 25000, // 1.67x threshold
        absDivergencePct: 0.003, // 0.3% - good divergence
        conditions: {
          time_stale: true,
          has_divergence: true,
          update_unlikely: true,
        },
        pNoUpdate: null,
      });

      expect(score).toBeGreaterThan(0.5);
      expect(score).toBeLessThanOrEqual(1);
    });

    test('score increases with time past threshold', () => {
      const baseConditions = {
        has_divergence: true,
        update_unlikely: true,
      };

      const score1 = detector.calculateScore({
        timeSinceUpdate: 16000, // Just over threshold
        absDivergencePct: 0.003,
        conditions: { ...baseConditions, time_stale: true },
        pNoUpdate: null,
      });

      const score2 = detector.calculateScore({
        timeSinceUpdate: 30000, // 2x threshold
        absDivergencePct: 0.003,
        conditions: { ...baseConditions, time_stale: true },
        pNoUpdate: null,
      });

      const score3 = detector.calculateScore({
        timeSinceUpdate: 45000, // 3x threshold
        absDivergencePct: 0.003,
        conditions: { ...baseConditions, time_stale: true },
        pNoUpdate: null,
      });

      expect(score2).toBeGreaterThan(score1);
      expect(score3).toBeGreaterThan(score2);
    });

    test('score increases with divergence magnitude', () => {
      const baseConditions = {
        time_stale: true,
        has_divergence: true,
        update_unlikely: true,
      };

      const score1 = detector.calculateScore({
        timeSinceUpdate: 20000,
        absDivergencePct: 0.0015, // Just above min
        conditions: baseConditions,
        pNoUpdate: null,
      });

      const score2 = detector.calculateScore({
        timeSinceUpdate: 20000,
        absDivergencePct: 0.003, // Middle of range
        conditions: baseConditions,
        pNoUpdate: null,
      });

      const score3 = detector.calculateScore({
        timeSinceUpdate: 20000,
        absDivergencePct: 0.0045, // Close to chainlink threshold
        conditions: baseConditions,
        pNoUpdate: null,
      });

      expect(score2).toBeGreaterThan(score1);
      expect(score3).toBeGreaterThan(score2);
    });

    test('adds bonus when predictor indicates low update probability', () => {
      const baseParams = {
        timeSinceUpdate: 20000,
        absDivergencePct: 0.003,
        conditions: {
          time_stale: true,
          has_divergence: true,
          update_unlikely: true,
        },
      };

      const scoreWithoutPredictor = detector.calculateScore({
        ...baseParams,
        pNoUpdate: null,
      });

      const scoreWithPredictor = detector.calculateScore({
        ...baseParams,
        pNoUpdate: 0.85, // 85% chance of no update
      });

      expect(scoreWithPredictor).toBeGreaterThan(scoreWithoutPredictor);
    });

    test('score is capped at 1', () => {
      const score = detector.calculateScore({
        timeSinceUpdate: 100000, // Very stale
        absDivergencePct: 0.0049, // Max divergence
        conditions: {
          time_stale: true,
          has_divergence: true,
          update_unlikely: true,
        },
        pNoUpdate: 0.99,
      });

      expect(score).toBeLessThanOrEqual(1);
    });

    test('handles edge case of zero divergence range', () => {
      // Create detector with equal min and chainlink thresholds (edge case)
      const edgeDetector = new StalenessDetector({
        config: {
          ...DEFAULT_CONFIG,
          minDivergencePct: 0.005,
          chainlinkDeviationThresholdPct: 0.005,
        },
        logger: mockLogger,
      });

      const score = edgeDetector.calculateScore({
        timeSinceUpdate: 20000,
        absDivergencePct: 0.005,
        conditions: {
          time_stale: true,
          has_divergence: true,
          update_unlikely: false,
        },
        pNoUpdate: null,
      });

      // Should not throw and should return valid score
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
    });

    test('handles future timestamp (clock skew) gracefully', () => {
      // Oracle timestamp is in the future (clock skew or bad data)
      const futureTimestamp = Date.now() + 60000; // 1 minute in future

      const result = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: futureTimestamp },
        { ui_price: 95250, oracle_price: 95000, spread_pct: 0.0026 }
      );

      // Should not be stale - time_since_update clamped to 0
      expect(result.conditions.time_stale).toBe(false);
      expect(result.inputs.time_since_update_ms).toBe(0);
      expect(result.is_stale).toBe(false);
    });
  });

  describe('state transitions and events', () => {
    test('emits staleness_detected when transitioning to stale', () => {
      const callback = vi.fn();
      detector.subscribe(callback);

      // First evaluation: not stale
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 5000 },
        { ui_price: 95000, oracle_price: 95000, spread_pct: 0 }
      );

      expect(callback).not.toHaveBeenCalled();

      // Second evaluation: stale with high score
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes.STALENESS_DETECTED,
          symbol: 'btc',
        })
      );
    });

    test('emits staleness_resolved when transitioning from stale', () => {
      const callback = vi.fn();
      detector.subscribe(callback);

      // Make it stale first
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      callback.mockClear();

      // Oracle updated - no longer stale
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: Date.now() - 1000 }, // Recent update
        { ui_price: 95300, oracle_price: 95300, spread_pct: 0 }
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes.STALENESS_RESOLVED,
          symbol: 'btc',
          staleness_duration_ms: expect.any(Number),
          price_at_resolution: 95300,
        })
      );
    });

    test('does not emit event when score below threshold', () => {
      const callback = vi.fn();
      detector.subscribe(callback);

      // Low divergence = low score
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 16000 }, // Just over time threshold
        { ui_price: 95100, oracle_price: 95000, spread_pct: 0.00105 } // Just over min divergence
      );

      // Should be stale but score too low for event
      const state = detector.getSymbolState('btc');
      expect(state.is_stale).toBe(true);
      expect(callback).not.toHaveBeenCalled();
    });

    test('tracks staleness duration correctly', () => {
      // Make stale
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      const state1 = detector.getSymbolState('btc');
      expect(state1.is_stale).toBe(true);
      expect(state1.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('subscription management', () => {
    test('subscribe returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = detector.subscribe(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    test('unsubscribe removes callback', () => {
      const callback = vi.fn();
      const unsubscribe = detector.subscribe(callback);

      // Make stale to trigger event
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      expect(callback).toHaveBeenCalled();
      callback.mockClear();

      // Unsubscribe
      unsubscribe();

      // Force state transition for new event
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: Date.now() - 1000 },
        { ui_price: 95300, oracle_price: 95300, spread_pct: 0 }
      );

      // New stale state to trigger detect event
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: Date.now() - 25000 },
        { ui_price: 95600, oracle_price: 95300, spread_pct: 0.0032 }
      );

      expect(callback).not.toHaveBeenCalled();
    });

    test('multiple subscribers receive events', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      detector.subscribe(callback1);
      detector.subscribe(callback2);

      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    test('subscriber error does not affect other subscribers', () => {
      const errorCallback = vi.fn().mockImplementation(() => {
        throw new Error('Subscriber error');
      });
      const normalCallback = vi.fn();

      detector.subscribe(errorCallback);
      detector.subscribe(normalCallback);

      // Should not throw
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      expect(normalCallback).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('throws when max subscribers exceeded', () => {
      const lowLimitLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const lowLimitDetector = new StalenessDetector({
        config: { ...DEFAULT_CONFIG, maxSubscribers: 3 },
        logger: lowLimitLogger,
      });

      // Add 3 subscribers (at limit)
      lowLimitDetector.subscribe(() => {});
      lowLimitDetector.subscribe(() => {});
      lowLimitDetector.subscribe(() => {});

      // 4th should throw
      expect(() => lowLimitDetector.subscribe(() => {})).toThrow('Max subscribers (3) exceeded');
      expect(lowLimitLogger.warn).toHaveBeenCalledWith(
        'max_subscribers_exceeded',
        expect.objectContaining({ current: 3, max: 3 })
      );
    });
  });

  describe('getSymbolState', () => {
    test('returns null for unknown symbol', () => {
      const state = detector.getSymbolState('unknown');
      expect(state).toBeNull();
    });

    test('returns correct state after evaluation', () => {
      detector.evaluateStaleness(
        'eth',
        { price: 3500, last_update_at: Date.now() - 25000 },
        { ui_price: 3510, oracle_price: 3500, spread_pct: 0.0028 }
      );

      const state = detector.getSymbolState('eth');

      expect(state).not.toBeNull();
      expect(state.is_stale).toBe(true);
      expect(state.score).toBeGreaterThan(0);
      expect(state.started_at).toBeDefined();
      expect(state.conditions).toBeDefined();
    });
  });

  describe('getStats', () => {
    test('returns correct initial stats', () => {
      const stats = detector.getStats();

      expect(stats.staleness_events_emitted).toBe(0);
      expect(stats.resolutions_detected).toBe(0);
      expect(stats.avg_staleness_duration_ms).toBe(0);
    });

    test('updates stats after events', () => {
      // Make stale (triggers event)
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      // Resolve (triggers resolution event)
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: Date.now() - 1000 },
        { ui_price: 95300, oracle_price: 95300, spread_pct: 0 }
      );

      const stats = detector.getStats();

      expect(stats.staleness_events_emitted).toBe(1);
      expect(stats.resolutions_detected).toBe(1);
    });
  });

  describe('reset', () => {
    test('clears all state', () => {
      detector.subscribe(() => {});
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: Date.now() - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      detector.reset();

      expect(detector.getAllStates()).toEqual({});
      expect(detector.getStats().staleness_events_emitted).toBe(0);
    });
  });
});
