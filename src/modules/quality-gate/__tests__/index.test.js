/**
 * Quality Gate Module Tests
 *
 * Unit tests for quality gate module public interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
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
  all: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../../../clients/rtds/index.js', () => {
  throw new Error('RTDS not available in test');
});

import * as qualityGate from '../index.js';
import { DisableReason, QualityGateErrorCodes } from '../types.js';
import * as database from '../../../persistence/database.js';

describe('Quality Gate Module', () => {
  beforeEach(async () => {
    // Reset module state
    await qualityGate.shutdown();
  });

  afterEach(async () => {
    await qualityGate.shutdown();
    vi.clearAllMocks();
  });

  describe('init', () => {
    it('should initialize with default config', async () => {
      await qualityGate.init({});

      const state = qualityGate.getState();
      expect(state.initialized).toBe(true);
      expect(state.disabled).toBe(false);
    });

    it('should initialize with custom config', async () => {
      await qualityGate.init({
        qualityGate: {
          rollingWindowSize: 30,
          minAccuracyThreshold: 0.50,
        },
      });

      const state = qualityGate.getState();
      expect(state.config.rollingWindowSize).toBe(30);
      expect(state.config.minAccuracyThreshold).toBe(0.50);
    });

    it('should not reinitialize if already initialized', async () => {
      await qualityGate.init({});
      await qualityGate.init({ qualityGate: { rollingWindowSize: 100 } });

      const state = qualityGate.getState();
      expect(state.config.rollingWindowSize).toBe(20); // Original default
    });

    it('should throw on invalid evaluationIntervalMs', async () => {
      await expect(qualityGate.init({
        qualityGate: { evaluationIntervalMs: 100 },
      })).rejects.toThrow();
    });

    it('should throw on invalid rollingWindowSize', async () => {
      await expect(qualityGate.init({
        qualityGate: { rollingWindowSize: 0 },
      })).rejects.toThrow();
    });

    it('should throw on invalid minAccuracyThreshold', async () => {
      await expect(qualityGate.init({
        qualityGate: { minAccuracyThreshold: 1.5 },
      })).rejects.toThrow();
    });

    it('should throw on invalid feedUnavailableThresholdMs', async () => {
      await expect(qualityGate.init({
        qualityGate: { feedUnavailableThresholdMs: 500 },
      })).rejects.toThrow();
    });

    it('should throw on invalid patternChangeThreshold', async () => {
      await expect(qualityGate.init({
        qualityGate: { patternChangeThreshold: 0 },
      })).rejects.toThrow();
    });

    it('should throw on invalid spreadBehaviorStdDev', async () => {
      await expect(qualityGate.init({
        qualityGate: { spreadBehaviorStdDev: -1 },
      })).rejects.toThrow();
    });

    it('should throw on invalid patternCheckFrequency', async () => {
      await expect(qualityGate.init({
        qualityGate: { patternCheckFrequency: 0 },
      })).rejects.toThrow();
    });

    it('should throw on invalid minSignalsForEvaluation', async () => {
      await expect(qualityGate.init({
        qualityGate: { minSignalsForEvaluation: -5 },
      })).rejects.toThrow();
    });
  });

  describe('evaluate', () => {
    beforeEach(async () => {
      await qualityGate.init({
        qualityGate: { enabled: false }, // Disable periodic evaluation for tests
      });
    });

    it('should throw if not initialized', async () => {
      await qualityGate.shutdown();

      await expect(qualityGate.evaluate()).rejects.toThrow();
    });

    it('should run evaluation', async () => {
      database.get.mockReturnValue({
        total: 20,
        wins: 12,
        accuracy: 0.6,
      });
      database.all.mockReturnValue([]);

      const result = await qualityGate.evaluate();

      expect(result.skipped).toBe(false);
      expect(result.rollingAccuracy).toBe(0.6);
    });
  });

  describe('isDisabled', () => {
    beforeEach(async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });
    });

    it('should return false when not disabled', () => {
      expect(qualityGate.isDisabled()).toBe(false);
    });

    it('should return true after manual disable', () => {
      qualityGate.disable(DisableReason.MANUAL, { reason: 'test' });

      expect(qualityGate.isDisabled()).toBe(true);
    });

    it('should throw if not initialized', async () => {
      await qualityGate.shutdown();

      expect(() => qualityGate.isDisabled()).toThrow();
    });
  });

  describe('shouldAllowSignal', () => {
    beforeEach(async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });
    });

    it('should return true when not disabled', () => {
      expect(qualityGate.shouldAllowSignal()).toBe(true);
    });

    it('should return false when disabled', () => {
      qualityGate.disable(DisableReason.MANUAL, {});

      expect(qualityGate.shouldAllowSignal()).toBe(false);
    });
  });

  describe('disable', () => {
    beforeEach(async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });
    });

    it('should disable with valid reason', () => {
      qualityGate.disable(DisableReason.ACCURACY_BELOW_THRESHOLD, {
        accuracy: 0.35,
      });

      expect(qualityGate.isDisabled()).toBe(true);
      expect(qualityGate.getState().disableReason).toBe(DisableReason.ACCURACY_BELOW_THRESHOLD);
    });

    it('should throw on invalid reason', () => {
      expect(() => {
        qualityGate.disable('not_a_valid_reason', {});
      }).toThrow();
    });

    it('should throw if not initialized', async () => {
      await qualityGate.shutdown();

      expect(() => qualityGate.disable(DisableReason.MANUAL, {})).toThrow();
    });
  });

  describe('enable', () => {
    beforeEach(async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });
      qualityGate.disable(DisableReason.MANUAL, {});
    });

    it('should enable with user reason', () => {
      qualityGate.enable('Market conditions improved');

      expect(qualityGate.isDisabled()).toBe(false);
      expect(qualityGate.getState().enabledAt).toBeTruthy();
    });

    it('should throw if no reason provided', () => {
      expect(() => qualityGate.enable('')).toThrow();
    });

    it('should throw if not disabled', async () => {
      qualityGate.enable('First enable');

      expect(() => qualityGate.enable('Second enable')).toThrow();
    });

    it('should throw if not initialized', async () => {
      await qualityGate.shutdown();

      expect(() => qualityGate.enable('Test')).toThrow();
    });
  });

  describe('getState', () => {
    it('should return uninitialized state before init', () => {
      const state = qualityGate.getState();

      expect(state.initialized).toBe(false);
      expect(state.disabled).toBe(false);
      expect(state.config).toBe(null);
    });

    it('should return full state after init', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      const state = qualityGate.getState();

      expect(state.initialized).toBe(true);
      expect(state.disabled).toBe(false);
      expect(state.config).toBeDefined();
      expect(state.evaluationCount).toBe(0);
    });
  });

  describe('onDisable and onEnable callbacks', () => {
    beforeEach(async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });
    });

    it('should call onDisable callback when disabled', () => {
      const callback = vi.fn();
      qualityGate.onDisable(callback);

      qualityGate.disable(DisableReason.MANUAL, { note: 'test' });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: DisableReason.MANUAL,
        })
      );
    });

    it('should call onEnable callback when enabled', () => {
      const callback = vi.fn();
      qualityGate.onEnable(callback);
      qualityGate.disable(DisableReason.MANUAL, {});

      qualityGate.enable('Testing callbacks');

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          userReason: 'Testing callbacks',
        })
      );
    });
  });

  describe('shutdown', () => {
    it('should reset module state', async () => {
      await qualityGate.init({
        qualityGate: { enabled: false },
      });

      await qualityGate.shutdown();

      const state = qualityGate.getState();
      expect(state.initialized).toBe(false);
    });

    it('should be idempotent', async () => {
      await qualityGate.init({});
      await qualityGate.shutdown();
      await qualityGate.shutdown();
      await qualityGate.shutdown();

      const state = qualityGate.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('exports', () => {
    it('should export error classes and constants', () => {
      expect(qualityGate.QualityGateError).toBeDefined();
      expect(qualityGate.QualityGateErrorCodes).toBeDefined();
      expect(qualityGate.DisableReason).toBeDefined();
    });
  });
});
