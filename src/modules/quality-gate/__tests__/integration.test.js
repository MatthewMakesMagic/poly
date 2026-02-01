/**
 * Quality Gate Integration Tests
 *
 * End-to-end tests for quality gate module functionality.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../../persistence/database.js', () => ({
  get: vi.fn(),
  all: vi.fn(() => []),
  run: vi.fn(),
}));

vi.mock('../../../clients/rtds/index.js', () => {
  throw new Error('RTDS not available in test');
});

import * as qualityGate from '../index.js';
import { DisableReason } from '../types.js';
import * as database from '../../../persistence/database.js';

// Helper for mock signals
let mockSignals = [];
let mockOracleUpdates = [];

describe('Quality Gate Integration', () => {
  beforeEach(async () => {
    mockSignals = [];
    mockOracleUpdates = [];
    await qualityGate.shutdown();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await qualityGate.shutdown();
    vi.clearAllMocks();
  });

  describe('End-to-end accuracy evaluation', () => {
    it('should trigger gate when accuracy drops below threshold', async () => {
      // Initialize with disabled periodic evaluation
      await qualityGate.init({
        qualityGate: {
          enabled: false,
          minAccuracyThreshold: 0.40,
          rollingWindowSize: 20,
          minSignalsForEvaluation: 10,
        },
      });

      // Simulate signals with 30% accuracy (below 40% threshold)
      for (let i = 0; i < 20; i++) {
        mockSignals.push({
          window_id: `window-${i}`,
          settlement_outcome: 'up',
          signal_correct: i < 6 ? 1 : 0, // 6 wins out of 20 = 30%
        });
      }

      // Reset mock to use our updated signals
      database.get.mockImplementation((query, params) => {
        if (query.includes('oracle_edge_signals')) {
          const windowSize = params?.[0] || 20;
          const settledSignals = mockSignals.filter(s => s.settlement_outcome !== null);
          const recentSignals = settledSignals.slice(-windowSize);
          const wins = recentSignals.filter(s => s.signal_correct === 1).length;
          return {
            total: recentSignals.length,
            wins,
            accuracy: recentSignals.length > 0 ? wins / recentSignals.length : null,
          };
        }
        return null;
      });
      database.all.mockReturnValue([]);

      // Run evaluation
      await qualityGate.evaluate();

      expect(qualityGate.isDisabled()).toBe(true);
      expect(qualityGate.getState().disableReason).toBe(DisableReason.ACCURACY_BELOW_THRESHOLD);
    });

    it('should not trigger gate when accuracy is above threshold', async () => {
      await qualityGate.init({
        qualityGate: {
          enabled: false,
          minAccuracyThreshold: 0.40,
          minSignalsForEvaluation: 10,
        },
      });

      // Simulate signals with 60% accuracy (above 40% threshold)
      for (let i = 0; i < 20; i++) {
        mockSignals.push({
          window_id: `window-${i}`,
          settlement_outcome: 'up',
          signal_correct: i < 12 ? 1 : 0, // 12 wins out of 20 = 60%
        });
      }

      database.get.mockImplementation((query, params) => {
        if (query.includes('oracle_edge_signals')) {
          const windowSize = params?.[0] || 20;
          const settledSignals = mockSignals.filter(s => s.settlement_outcome !== null);
          const recentSignals = settledSignals.slice(-windowSize);
          const wins = recentSignals.filter(s => s.signal_correct === 1).length;
          return {
            total: recentSignals.length,
            wins,
            accuracy: recentSignals.length > 0 ? wins / recentSignals.length : null,
          };
        }
        return null;
      });
      database.all.mockReturnValue([]);

      await qualityGate.evaluate();

      expect(qualityGate.isDisabled()).toBe(false);
    });

    it('should not evaluate with insufficient signals', async () => {
      await qualityGate.init({
        qualityGate: {
          enabled: false,
          minAccuracyThreshold: 0.40,
          minSignalsForEvaluation: 10,
        },
      });

      // Only 5 signals (below minSignalsForEvaluation)
      for (let i = 0; i < 5; i++) {
        mockSignals.push({
          window_id: `window-${i}`,
          settlement_outcome: 'up',
          signal_correct: 0, // All losses - but shouldn't trigger gate
        });
      }

      database.get.mockImplementation((query, params) => {
        if (query.includes('oracle_edge_signals')) {
          return { total: 5, wins: 0, accuracy: 0 };
        }
        return null;
      });
      database.all.mockReturnValue([]);

      await qualityGate.evaluate();

      // Should NOT disable due to insufficient data
      expect(qualityGate.isDisabled()).toBe(false);
    });
  });

  describe('Signal blocking integration', () => {
    it('should block signals via shouldAllowSignal when disabled', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      // Initially should allow signals
      expect(qualityGate.shouldAllowSignal()).toBe(true);

      // Disable the gate
      qualityGate.disable(DisableReason.ACCURACY_BELOW_THRESHOLD, {
        accuracy: 0.30,
        threshold: 0.40,
      });

      // Should now block signals
      expect(qualityGate.shouldAllowSignal()).toBe(false);
    });

    it('should allow signals after manual re-enable', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      qualityGate.disable(DisableReason.MANUAL, {});
      expect(qualityGate.shouldAllowSignal()).toBe(false);

      qualityGate.enable('Market conditions improved after analysis');
      expect(qualityGate.shouldAllowSignal()).toBe(true);
    });
  });

  describe('Feed health detection', () => {
    it('should track feed health through evaluations', async () => {
      await qualityGate.init({
        qualityGate: {
          enabled: false,
          feedUnavailableThresholdMs: 5000, // 5 seconds for test
        },
      });

      // Simulate good data
      database.get.mockReturnValue({ total: 20, wins: 12, accuracy: 0.6 });
      database.all.mockReturnValue([]);

      const result = await qualityGate.evaluate();

      expect(result.feedHealth.oracleAvailable).toBe(true);
    });
  });

  describe('Re-enable flow', () => {
    it('should require user reason to re-enable', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      qualityGate.disable(DisableReason.ACCURACY_BELOW_THRESHOLD, {
        accuracy: 0.30,
      });

      // Should throw without reason
      expect(() => qualityGate.enable()).toThrow();
      expect(() => qualityGate.enable('')).toThrow();
      expect(() => qualityGate.enable('   ')).toThrow();

      // Should succeed with reason
      qualityGate.enable('Verified data quality and market conditions');

      expect(qualityGate.isDisabled()).toBe(false);
    });

    it('should reset evaluation count after re-enable', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      // Run several evaluations
      database.get.mockReturnValue({ total: 20, wins: 12, accuracy: 0.6 });
      database.all.mockReturnValue([]);

      await qualityGate.evaluate();
      await qualityGate.evaluate();
      await qualityGate.evaluate();

      expect(qualityGate.getState().evaluationCount).toBe(3);

      // Disable and re-enable
      qualityGate.disable(DisableReason.MANUAL, {});
      qualityGate.enable('Testing reset');

      expect(qualityGate.getState().evaluationCount).toBe(0);
    });
  });

  describe('Disable reason tracking', () => {
    it('should track different disable reasons', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      // Disable for accuracy
      qualityGate.disable(DisableReason.ACCURACY_BELOW_THRESHOLD, {
        accuracy: 0.30,
        threshold: 0.40,
      });

      let state = qualityGate.getState();
      expect(state.disableReason).toBe(DisableReason.ACCURACY_BELOW_THRESHOLD);
      expect(state.disableContext.accuracy).toBe(0.30);

      // Re-enable and disable for different reason
      qualityGate.enable('Testing reason tracking');

      qualityGate.disable(DisableReason.FEED_UNAVAILABLE, {
        lastOracleTickAgeMs: 15000,
      });

      state = qualityGate.getState();
      expect(state.disableReason).toBe(DisableReason.FEED_UNAVAILABLE);
      expect(state.disableContext.lastOracleTickAgeMs).toBe(15000);
    });
  });

  describe('Event callbacks', () => {
    it('should notify on disable and enable events', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      const disableEvents = [];
      const enableEvents = [];

      qualityGate.onDisable((event) => disableEvents.push(event));
      qualityGate.onEnable((event) => enableEvents.push(event));

      // Trigger disable
      qualityGate.disable(DisableReason.MANUAL, { note: 'test' });
      expect(disableEvents).toHaveLength(1);
      expect(disableEvents[0].reason).toBe(DisableReason.MANUAL);

      // Trigger enable
      qualityGate.enable('Callback test');
      expect(enableEvents).toHaveLength(1);
      expect(enableEvents[0].userReason).toBe('Callback test');
    });
  });

  describe('Evaluation skip on disabled', () => {
    it('should skip evaluation when already disabled', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      qualityGate.disable(DisableReason.MANUAL, {});

      const result = await qualityGate.evaluate();

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('already_disabled');
    });
  });
});
