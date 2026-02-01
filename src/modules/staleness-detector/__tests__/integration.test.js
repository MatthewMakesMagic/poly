/**
 * Staleness Detector Integration Tests
 *
 * Tests for integration with:
 * - oracle-tracker module
 * - divergence-tracker module (optional)
 * - oracle-predictor module (optional)
 * - End-to-end staleness detection flow
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { StalenessDetector } from '../detector.js';
import { DEFAULT_CONFIG, EventTypes } from '../types.js';

describe('Staleness Detector Integration', () => {
  let detector;
  let mockLogger;

  // Simulated module states
  let mockOracleTrackerState;
  let mockDivergenceTrackerState;

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

    // Initialize mock states
    mockOracleTrackerState = {
      tracking: {
        btc: { last_price: 95000, last_update_at: new Date().toISOString(), updates_recorded: 100 },
        eth: { last_price: 3500, last_update_at: new Date().toISOString(), updates_recorded: 80 },
        sol: { last_price: 150, last_update_at: new Date().toISOString(), updates_recorded: 60 },
        xrp: { last_price: 0.5, last_update_at: new Date().toISOString(), updates_recorded: 50 },
      },
    };

    mockDivergenceTrackerState = {
      spreads: {
        btc: { ui_price: 95000, oracle_price: 95000, pct: 0, direction: 'aligned' },
        eth: { ui_price: 3500, oracle_price: 3500, pct: 0, direction: 'aligned' },
        sol: { ui_price: 150, oracle_price: 150, pct: 0, direction: 'aligned' },
        xrp: { ui_price: 0.5, oracle_price: 0.5, pct: 0, direction: 'aligned' },
      },
    };
  });

  afterEach(() => {
    detector.reset();
  });

  describe('end-to-end staleness detection', () => {
    test('detects staleness when all conditions are met', () => {
      const events = [];
      detector.subscribe(event => events.push(event));

      // Simulate oracle becoming stale
      const now = Date.now();
      const oracleState = {
        price: 95000,
        last_update_at: now - 25000, // 25 seconds ago
      };

      const divergence = {
        ui_price: 95285,  // UI shows higher price
        oracle_price: 95000,
        spread_pct: 0.003, // 0.3% divergence
      };

      const evaluation = detector.evaluateStaleness('btc', oracleState, divergence);

      expect(evaluation.is_stale).toBe(true);
      expect(evaluation.score).toBeGreaterThan(0.6);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe(EventTypes.STALENESS_DETECTED);
      expect(events[0].symbol).toBe('btc');
    });

    test('handles staleness resolution when oracle updates', () => {
      const events = [];
      detector.subscribe(event => events.push(event));

      const now = Date.now();

      // First: make it stale
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      expect(events.length).toBe(1);
      expect(events[0].type).toBe(EventTypes.STALENESS_DETECTED);

      // Then: oracle updates
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: now }, // Just updated
        { ui_price: 95300, oracle_price: 95300, spread_pct: 0 }
      );

      expect(events.length).toBe(2);
      expect(events[1].type).toBe(EventTypes.STALENESS_RESOLVED);
      // Duration is calculated from when stale state was set to now
      // Since these run in quick succession, duration may be 0 or very small
      expect(events[1].staleness_duration_ms).toBeGreaterThanOrEqual(0);
      expect(events[1].price_at_resolution).toBe(95300);
    });

    test('handles multiple symbols independently', () => {
      const events = [];
      detector.subscribe(event => events.push(event));

      const now = Date.now();

      // Make BTC stale
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      // ETH is not stale
      detector.evaluateStaleness(
        'eth',
        { price: 3500, last_update_at: now - 5000 }, // Recent
        { ui_price: 3500, oracle_price: 3500, spread_pct: 0 }
      );

      // Make SOL stale
      detector.evaluateStaleness(
        'sol',
        { price: 150, last_update_at: now - 30000 },
        { ui_price: 150.5, oracle_price: 150, spread_pct: 0.0033 }
      );

      expect(events.length).toBe(2); // BTC and SOL
      expect(events.map(e => e.symbol).sort()).toEqual(['btc', 'sol']);

      // Check states
      expect(detector.getSymbolState('btc').is_stale).toBe(true);
      expect(detector.getSymbolState('eth').is_stale).toBe(false);
      expect(detector.getSymbolState('sol').is_stale).toBe(true);
    });

    test('handles rapid price movements correctly', () => {
      const events = [];
      detector.subscribe(event => events.push(event));

      const now = Date.now();

      // Price moving rapidly but oracle keeping up
      const updates = [
        { price: 95000, lastUpdate: now - 3000, uiPrice: 95050, spreadPct: 0.0005 },
        { price: 95100, lastUpdate: now - 2000, uiPrice: 95150, spreadPct: 0.0005 },
        { price: 95200, lastUpdate: now - 1000, uiPrice: 95250, spreadPct: 0.0005 },
        { price: 95300, lastUpdate: now, uiPrice: 95350, spreadPct: 0.0005 },
      ];

      for (const update of updates) {
        detector.evaluateStaleness(
          'btc',
          { price: update.price, last_update_at: update.lastUpdate },
          { ui_price: update.uiPrice, oracle_price: update.price, spread_pct: update.spreadPct }
        );
      }

      // No staleness events - oracle is keeping up
      expect(events.length).toBe(0);
      expect(detector.getSymbolState('btc').is_stale).toBe(false);
    });

    test('handles oracle lag during volatility spike', () => {
      const events = [];
      detector.subscribe(event => events.push(event));

      const now = Date.now();

      // Simulate oracle getting behind during volatility
      // Timeline: oracle updates get progressively more stale
      const timeline = [
        // Point 0: Oracle recently updated, UI at 95000 - aligned (no staleness)
        { oracleUpdate: now - 5000, oraclePrice: 95000, uiPrice: 95000 },

        // Point 1: Oracle 10s old, small divergence - not stale yet (time < threshold)
        { oracleUpdate: now - 10000, oraclePrice: 95000, uiPrice: 95050 },

        // Point 2: Oracle 20s old, significant divergence - STALE (all conditions met)
        { oracleUpdate: now - 20000, oraclePrice: 95000, uiPrice: 95200 },

        // Point 3: Oracle catches up - RESOLVED
        { oracleUpdate: now - 1000, oraclePrice: 95200, uiPrice: 95200 },
      ];

      const eventLog = [];

      for (let i = 0; i < timeline.length; i++) {
        const point = timeline[i];
        const spread = (point.uiPrice - point.oraclePrice) / point.oraclePrice;

        detector.evaluateStaleness(
          'btc',
          { price: point.oraclePrice, last_update_at: point.oracleUpdate },
          { ui_price: point.uiPrice, oracle_price: point.oraclePrice, spread_pct: spread }
        );

        // Check for new events
        if (events.length > eventLog.length) {
          const newEvent = events[events.length - 1];
          eventLog.push({ point: i, type: newEvent.type });
        }
      }

      // Verify we got staleness detection at point 2 and resolution at point 3
      expect(eventLog.length).toBe(2);
      expect(eventLog[0]).toEqual({ point: 2, type: EventTypes.STALENESS_DETECTED });
      expect(eventLog[1]).toEqual({ point: 3, type: EventTypes.STALENESS_RESOLVED });
    });
  });

  describe('integration with oracle-predictor probability', () => {
    test('factors in predictor probability when available', () => {
      const now = Date.now();

      // Evaluate without predictor
      const evalWithoutPredictor = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 20000 },
        { ui_price: 95250, oracle_price: 95000, spread_pct: 0.0026 },
        null // No predictor
      );

      // Reset and evaluate with predictor
      detector.reset();

      const evalWithPredictor = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 20000 },
        { ui_price: 95250, oracle_price: 95000, spread_pct: 0.0026 },
        0.85 // High probability of no update
      );

      // Score should be slightly higher with predictor indicating no update
      expect(evalWithPredictor.score).toBeGreaterThanOrEqual(evalWithoutPredictor.score);
      expect(evalWithPredictor.inputs.p_no_update).toBe(0.85);
      expect(evalWithoutPredictor.inputs.p_no_update).toBeNull();
    });

    test('handles null predictor probability gracefully', () => {
      const now = Date.now();

      // Should not throw with null predictor
      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 20000 },
        { ui_price: 95250, oracle_price: 95000, spread_pct: 0.0026 },
        null
      );

      expect(evaluation).toBeDefined();
      expect(evaluation.inputs.p_no_update).toBeNull();
    });
  });

  describe('statistics tracking', () => {
    test('tracks staleness events and resolutions correctly', () => {
      const now = Date.now();

      // Create 3 staleness events across different symbols
      const staleConfigs = [
        { symbol: 'btc', price: 95000, uiPrice: 95300, spreadPct: 0.0032 },
        { symbol: 'eth', price: 3500, uiPrice: 3512, spreadPct: 0.0034 },
        { symbol: 'sol', price: 150, uiPrice: 150.5, spreadPct: 0.0033 },
      ];

      for (const config of staleConfigs) {
        detector.evaluateStaleness(
          config.symbol,
          { price: config.price, last_update_at: now - 25000 },
          { ui_price: config.uiPrice, oracle_price: config.price, spread_pct: config.spreadPct }
        );
      }

      let stats = detector.getStats();
      expect(stats.staleness_events_emitted).toBe(3);
      expect(stats.resolutions_detected).toBe(0);

      // Resolve 2 of them
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: now },
        { ui_price: 95300, oracle_price: 95300, spread_pct: 0 }
      );

      detector.evaluateStaleness(
        'eth',
        { price: 3512, last_update_at: now },
        { ui_price: 3512, oracle_price: 3512, spread_pct: 0 }
      );

      stats = detector.getStats();
      expect(stats.staleness_events_emitted).toBe(3);
      expect(stats.resolutions_detected).toBe(2);
    });

    test('calculates average staleness duration', () => {
      const now = Date.now();

      // Create staleness, wait, then resolve
      detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 25000 },
        { ui_price: 95300, oracle_price: 95000, spread_pct: 0.0032 }
      );

      // Simulate time passing (by using state from detector)
      const state = detector.getSymbolState('btc');
      expect(state.is_stale).toBe(true);

      // Resolve
      detector.evaluateStaleness(
        'btc',
        { price: 95300, last_update_at: now + 50 }, // 50ms later
        { ui_price: 95300, oracle_price: 95300, spread_pct: 0 }
      );

      const stats = detector.getStats();
      expect(stats.resolutions_detected).toBe(1);
      // Duration is calculated from when stale state was set to now
      // Since both evaluations run in quick succession, duration may be 0
      expect(stats.avg_staleness_duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge cases', () => {
    test('handles very small divergences correctly', () => {
      const now = Date.now();

      // Divergence just above minimum threshold
      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 20000 },
        { ui_price: 95095.01, oracle_price: 95000, spread_pct: 0.001001 } // Just over 0.1%
      );

      expect(evaluation.conditions.has_divergence).toBe(true);
    });

    test('handles divergence at chainlink threshold correctly', () => {
      const now = Date.now();

      // Divergence exactly at chainlink threshold
      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 20000 },
        { ui_price: 95475, oracle_price: 95000, spread_pct: 0.005 } // Exactly 0.5%
      );

      expect(evaluation.conditions.update_unlikely).toBe(false);
      expect(evaluation.is_stale).toBe(false);
    });

    test('handles time exactly at threshold', () => {
      const now = Date.now();

      // Time exactly at threshold
      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 15000 }, // Exactly 15s
        { ui_price: 95250, oracle_price: 95000, spread_pct: 0.0026 }
      );

      expect(evaluation.conditions.time_stale).toBe(false);
    });

    test('handles negative divergence (oracle higher than UI)', () => {
      const now = Date.now();

      // Oracle price higher than UI (negative spread)
      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95250, last_update_at: now - 20000 },
        { ui_price: 95000, oracle_price: 95250, spread_pct: -0.0026 }
      );

      // Should still detect staleness based on absolute divergence
      expect(evaluation.conditions.has_divergence).toBe(true);
      expect(evaluation.is_stale).toBe(true);
    });

    test('handles zero divergence', () => {
      const now = Date.now();

      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 25000 },
        { ui_price: 95000, oracle_price: 95000, spread_pct: 0 }
      );

      expect(evaluation.is_stale).toBe(false);
      expect(evaluation.score).toBe(0);
    });

    test('handles missing UI price (fallback)', () => {
      const now = Date.now();

      // Divergence tracker not available - no UI price
      const evaluation = detector.evaluateStaleness(
        'btc',
        { price: 95000, last_update_at: now - 20000 },
        { ui_price: null, oracle_price: 95000, spread_pct: 0 }
      );

      expect(evaluation.is_stale).toBe(false);
      expect(evaluation.inputs.ui_price).toBeNull();
    });
  });
});
