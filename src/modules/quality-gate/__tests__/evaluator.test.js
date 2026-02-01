/**
 * Quality Gate Evaluator Tests
 *
 * Unit tests for QualityGateEvaluator class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QualityGateEvaluator } from '../evaluator.js';
import { DisableReason, QualityGateErrorCodes, DEFAULT_CONFIG } from '../types.js';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Mock database
const createMockDb = () => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
});

describe('QualityGateEvaluator', () => {
  let evaluator;
  let mockLogger;
  let mockDb;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockDb = createMockDb();

    evaluator = new QualityGateEvaluator({
      config: DEFAULT_CONFIG,
      logger: mockLogger,
      db: mockDb,
    });
  });

  afterEach(() => {
    if (evaluator) {
      evaluator.cleanup();
    }
    vi.clearAllMocks();
  });

  describe('calculateRollingAccuracy', () => {
    it('should return accuracy when signals with outcomes exist', async () => {
      mockDb.get.mockReturnValue({
        total: 20,
        wins: 12,
        accuracy: 0.6,
      });

      const result = await evaluator.calculateRollingAccuracy(20);

      expect(result.accuracy).toBe(0.6);
      expect(result.signalsInWindow).toBe(20);
      expect(result.wins).toBe(12);
      expect(result.insufficientData).toBe(false);
    });

    it('should handle fewer signals than window size', async () => {
      mockDb.get.mockReturnValue({
        total: 5,
        wins: 3,
        accuracy: 0.6,
      });

      const result = await evaluator.calculateRollingAccuracy(20);

      expect(result.accuracy).toBe(0.6);
      expect(result.signalsInWindow).toBe(5);
      expect(result.insufficientData).toBe(true);
    });

    it('should handle zero signals', async () => {
      mockDb.get.mockReturnValue({
        total: 0,
        wins: 0,
        accuracy: null,
      });

      const result = await evaluator.calculateRollingAccuracy(20);

      expect(result.accuracy).toBe(null);
      expect(result.signalsInWindow).toBe(0);
      expect(result.insufficientData).toBe(true);
    });

    it('should handle no result from database', async () => {
      mockDb.get.mockReturnValue(null);

      const result = await evaluator.calculateRollingAccuracy(20);

      expect(result.accuracy).toBe(null);
      expect(result.signalsInWindow).toBe(0);
    });

    it('should throw error on database failure', async () => {
      mockDb.get.mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      await expect(evaluator.calculateRollingAccuracy(20)).rejects.toThrow('Failed to calculate rolling accuracy');
    });
  });

  describe('calculateBucketedAccuracy', () => {
    it('should return bucketed accuracy for all dimensions', async () => {
      mockDb.get.mockReturnValue({
        total: 20,
        wins: 12,
        accuracy: 0.6,
      });

      mockDb.all.mockReturnValue([
        { bucket: '0-10s', signals: 10, wins: 6, accuracy: 0.6 },
        { bucket: '10-20s', signals: 7, wins: 4, accuracy: 0.57 },
        { bucket: '20-30s', signals: 3, wins: 2, accuracy: 0.67 },
      ]);

      const result = await evaluator.calculateBucketedAccuracy(20);

      expect(result.overall).toBe(0.6);
      expect(result.signalsInWindow).toBe(20);
      expect(result.by_time).toHaveProperty('0-10s');
      expect(result.by_staleness).toBeDefined();
      expect(result.by_spread).toBeDefined();
    });

    it('should handle empty buckets gracefully', async () => {
      mockDb.get.mockReturnValue({
        total: 0,
        wins: 0,
        accuracy: null,
      });

      mockDb.all.mockReturnValue([]);

      const result = await evaluator.calculateBucketedAccuracy(20);

      expect(result.overall).toBe(null);
      expect(result.by_time).toEqual({});
    });
  });

  describe('checkAccuracyThreshold', () => {
    it('should detect when accuracy is below threshold', () => {
      const result = evaluator.checkAccuracyThreshold(0.35, 0.40);

      expect(result.breached).toBe(true);
      expect(result.accuracy).toBe(0.35);
      expect(result.threshold).toBe(0.40);
      expect(result.deficit).toBeCloseTo(0.05);
    });

    it('should pass when accuracy meets threshold', () => {
      const result = evaluator.checkAccuracyThreshold(0.50, 0.40);

      expect(result.breached).toBe(false);
      expect(result.accuracy).toBe(0.50);
      expect(result.deficit).toBe(0);
    });

    it('should handle null accuracy', () => {
      const result = evaluator.checkAccuracyThreshold(null, 0.40);

      expect(result.breached).toBe(false);
      expect(result.accuracy).toBe(null);
      expect(result.reason).toBe('insufficient_data');
    });

    it('should use default threshold from config', () => {
      const result = evaluator.checkAccuracyThreshold(0.35);

      expect(result.threshold).toBe(DEFAULT_CONFIG.minAccuracyThreshold);
    });
  });

  describe('checkFeedHealth', () => {
    it('should report healthy when oracle tick is recent', () => {
      evaluator.updateOracleTick();

      const result = evaluator.checkFeedHealth();

      expect(result.healthy).toBe(true);
      expect(result.oracleAvailable).toBe(true);
      expect(result.reason).toBe(null);
    });

    it('should report unhealthy when oracle tick is stale', () => {
      // Set last tick time to 15 seconds ago
      evaluator.lastOracleTickTime = Date.now() - 15000;

      const result = evaluator.checkFeedHealth();

      expect(result.healthy).toBe(false);
      expect(result.oracleAvailable).toBe(false);
      expect(result.reason).toBe('feed_unavailable');
      expect(result.lastOracleTickAgeMs).toBeGreaterThan(10000);
    });
  });

  describe('checkPatternChange', () => {
    it('should skip check with invalid symbol', async () => {
      const result = await evaluator.checkPatternChange('INVALID_SYMBOL');

      expect(result.healthy).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('invalid_symbol');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'invalid_symbol_for_pattern_check',
        expect.objectContaining({ symbol: 'INVALID_SYMBOL' })
      );
    });

    it('should normalize symbol to uppercase', async () => {
      mockDb.get.mockReturnValue(null); // Table doesn't exist

      const result = await evaluator.checkPatternChange('eth');

      // Should not return invalid_symbol since 'eth' normalizes to valid 'ETH'
      expect(result.skipReason).toBe('oracle_updates_table_not_found');
    });

    it('should skip check when oracle_updates table does not exist', async () => {
      mockDb.get.mockReturnValue(null);

      const result = await evaluator.checkPatternChange('ETH');

      expect(result.healthy).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('oracle_updates_table_not_found');
    });

    it('should skip check when insufficient data', async () => {
      mockDb.get.mockReturnValueOnce({ name: 'oracle_updates' }); // Table exists
      mockDb.get.mockReturnValueOnce({ count: 5, avg_interval: 1000 }); // Recent
      mockDb.get.mockReturnValueOnce({ count: 50, avg_interval: 1000 }); // Historical

      const result = await evaluator.checkPatternChange('ETH');

      expect(result.healthy).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('insufficient_pattern_data');
    });

    it('should detect pattern change when frequency ratio exceeds threshold', async () => {
      mockDb.get.mockReturnValueOnce({ name: 'oracle_updates' }); // Table exists
      mockDb.get.mockReturnValueOnce({ count: 100, avg_interval: 1000 }); // Recent: 100/hour
      mockDb.get.mockReturnValueOnce({ count: 230, avg_interval: 1000 }); // Historical: 10/hour

      const result = await evaluator.checkPatternChange('ETH');

      expect(result.healthy).toBe(false);
      expect(result.reason).toBe('pattern_change_detected');
      expect(result.updateFrequencyRatio).toBeGreaterThan(2.0);
    });

    it('should report healthy when pattern is stable', async () => {
      mockDb.get.mockReturnValueOnce({ name: 'oracle_updates' }); // Table exists
      mockDb.get.mockReturnValueOnce({ count: 10, avg_interval: 1000 }); // Recent
      mockDb.get.mockReturnValueOnce({ count: 230, avg_interval: 1000 }); // Historical

      const result = await evaluator.checkPatternChange('ETH');

      expect(result.healthy).toBe(true);
    });
  });

  describe('disableStrategy', () => {
    it('should set disabled state with reason', () => {
      evaluator.disableStrategy(DisableReason.ACCURACY_BELOW_THRESHOLD, {
        accuracy: 0.35,
        threshold: 0.40,
      });

      expect(evaluator.disabled).toBe(true);
      expect(evaluator.disableReason).toBe(DisableReason.ACCURACY_BELOW_THRESHOLD);
      expect(evaluator.disabledAt).toBeTruthy();
      expect(evaluator.disableContext.accuracy).toBe(0.35);
    });

    it('should log warning when disabled', () => {
      evaluator.disableStrategy(DisableReason.FEED_UNAVAILABLE, {
        lastOracleTickAgeMs: 15000,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'quality_gate_triggered',
        expect.objectContaining({ reason: DisableReason.FEED_UNAVAILABLE })
      );
    });

    it('should not disable again if already disabled', () => {
      evaluator.disableStrategy(DisableReason.ACCURACY_BELOW_THRESHOLD, {});
      const firstDisabledAt = evaluator.disabledAt;

      evaluator.disableStrategy(DisableReason.FEED_UNAVAILABLE, {});

      expect(evaluator.disabledAt).toBe(firstDisabledAt);
      expect(evaluator.disableReason).toBe(DisableReason.ACCURACY_BELOW_THRESHOLD);
    });

    it('should throw error for invalid reason', () => {
      expect(() => {
        evaluator.disableStrategy('invalid_reason', {});
      }).toThrow();
    });

    it('should call onDisable callback', () => {
      const callback = vi.fn();
      evaluator.setOnDisable(callback);

      evaluator.disableStrategy(DisableReason.MANUAL, { userNote: 'test' });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: DisableReason.MANUAL,
        })
      );
    });
  });

  describe('enableStrategy', () => {
    beforeEach(() => {
      evaluator.disableStrategy(DisableReason.ACCURACY_BELOW_THRESHOLD, {
        accuracy: 0.35,
      });
    });

    it('should clear disabled state with user reason', () => {
      evaluator.enableStrategy('Manual re-enable after market stabilized');

      expect(evaluator.disabled).toBe(false);
      expect(evaluator.disableReason).toBe(null);
      expect(evaluator.disabledAt).toBe(null);
      expect(evaluator.enabledAt).toBeTruthy();
    });

    it('should log re-enable event', () => {
      evaluator.enableStrategy('Testing re-enable');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'quality_gate_reenabled',
        expect.objectContaining({
          userReason: 'Testing re-enable',
          previousDisableReason: DisableReason.ACCURACY_BELOW_THRESHOLD,
        })
      );
    });

    it('should reset evaluation count', () => {
      evaluator.evaluationCount = 10;

      evaluator.enableStrategy('Reset test');

      expect(evaluator.evaluationCount).toBe(0);
    });

    it('should throw error if not disabled', () => {
      evaluator.disabled = false;

      expect(() => {
        evaluator.enableStrategy('Test');
      }).toThrow();
    });

    it('should throw error if no reason provided', () => {
      expect(() => {
        evaluator.enableStrategy('');
      }).toThrow();
    });

    it('should call onEnable callback', () => {
      const callback = vi.fn();
      evaluator.setOnEnable(callback);

      evaluator.enableStrategy('Callback test');

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          userReason: 'Callback test',
        })
      );
    });
  });

  describe('evaluate', () => {
    it('should skip evaluation when already disabled', async () => {
      evaluator.disabled = true;
      evaluator.disableReason = DisableReason.MANUAL;

      const result = await evaluator.evaluate();

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('already_disabled');
      expect(mockDb.get).not.toHaveBeenCalled();
    });

    it('should run full evaluation cycle', async () => {
      mockDb.get.mockReturnValue({
        total: 20,
        wins: 12,
        accuracy: 0.6,
      });
      mockDb.all.mockReturnValue([]);

      const result = await evaluator.evaluate();

      expect(result.skipped).toBe(false);
      expect(result.rollingAccuracy).toBe(0.6);
      expect(result.feedHealth).toBeDefined();
      expect(evaluator.evaluationCount).toBe(1);
    });

    it('should disable when accuracy below threshold', async () => {
      mockDb.get.mockReturnValue({
        total: 20,
        wins: 6,
        accuracy: 0.30,
      });
      mockDb.all.mockReturnValue([]);

      await evaluator.evaluate();

      expect(evaluator.disabled).toBe(true);
      expect(evaluator.disableReason).toBe(DisableReason.ACCURACY_BELOW_THRESHOLD);
    });

    it('should disable when feed unavailable', async () => {
      mockDb.get.mockReturnValue({
        total: 20,
        wins: 12,
        accuracy: 0.6,
      });
      mockDb.all.mockReturnValue([]);

      // Set stale feed
      evaluator.lastOracleTickTime = Date.now() - 15000;

      await evaluator.evaluate();

      expect(evaluator.disabled).toBe(true);
      expect(evaluator.disableReason).toBe(DisableReason.FEED_UNAVAILABLE);
    });

    it('should not evaluate accuracy with insufficient signals', async () => {
      mockDb.get.mockReturnValue({
        total: 5,
        wins: 3,
        accuracy: 0.6,
      });
      mockDb.all.mockReturnValue([]);

      const result = await evaluator.evaluate();

      expect(result.insufficientData).toBe(true);
      expect(evaluator.disabled).toBe(false);
    });

    it('should store last evaluation result', async () => {
      mockDb.get.mockReturnValue({
        total: 20,
        wins: 12,
        accuracy: 0.6,
      });
      mockDb.all.mockReturnValue([]);

      await evaluator.evaluate();

      expect(evaluator.lastEvaluation).toBeTruthy();
      expect(evaluator.lastEvaluation.timestamp).toBeTruthy();
      expect(evaluator.lastEvaluation.rollingAccuracy).toBe(0.6);
    });
  });

  describe('shouldAllowSignal', () => {
    it('should return true when not disabled', () => {
      expect(evaluator.shouldAllowSignal()).toBe(true);
    });

    it('should return false when disabled', () => {
      evaluator.disableStrategy(DisableReason.MANUAL, {});

      expect(evaluator.shouldAllowSignal()).toBe(false);
    });
  });

  describe('getState', () => {
    it('should return full state object', () => {
      const state = evaluator.getState();

      expect(state).toHaveProperty('disabled', false);
      expect(state).toHaveProperty('disabledAt', null);
      expect(state).toHaveProperty('disableReason', null);
      expect(state).toHaveProperty('lastEvaluation', null);
      expect(state).toHaveProperty('evaluationCount', 0);
      expect(state).toHaveProperty('config');
    });
  });

  describe('periodic evaluation', () => {
    it('should start and stop periodic evaluation', () => {
      vi.useFakeTimers();

      evaluator.startPeriodicEvaluation(1000);

      expect(evaluator.evaluationInterval).toBeTruthy();

      evaluator.stopPeriodicEvaluation();

      expect(evaluator.evaluationInterval).toBe(null);

      vi.useRealTimers();
    });

    it('should not start if already running', () => {
      vi.useFakeTimers();

      evaluator.startPeriodicEvaluation(1000);
      const firstInterval = evaluator.evaluationInterval;

      evaluator.startPeriodicEvaluation(1000);

      expect(evaluator.evaluationInterval).toBe(firstInterval);
      expect(mockLogger.warn).toHaveBeenCalledWith('periodic_evaluation_already_running');

      evaluator.cleanup();
      vi.useRealTimers();
    });
  });

  describe('cleanup', () => {
    it('should stop periodic evaluation and clear callbacks', () => {
      vi.useFakeTimers();

      const disableCallback = vi.fn();
      const enableCallback = vi.fn();

      evaluator.setOnDisable(disableCallback);
      evaluator.setOnEnable(enableCallback);
      evaluator.startPeriodicEvaluation(1000);

      evaluator.cleanup();

      expect(evaluator.evaluationInterval).toBe(null);
      expect(evaluator.onDisable).toBe(null);
      expect(evaluator.onEnable).toBe(null);

      vi.useRealTimers();
    });
  });
});
