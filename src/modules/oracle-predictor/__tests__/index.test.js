/**
 * Oracle Predictor Module Tests
 *
 * Tests for the oracle-predictor module public interface.
 * Tests init, getPrediction, getPatterns, getState, shutdown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as oraclePredictor from '../index.js';
import { OraclePredictorError, OraclePredictorErrorCodes } from '../types.js';

// Mock dependencies
vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../persistence/index.js', () => ({
  default: {
    all: vi.fn(() => []),
    get: vi.fn(() => null),
    run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  },
}));

vi.mock('../../oracle-tracker/index.js', () => ({
  getState: vi.fn(() => ({
    initialized: true,
    tracking: {
      btc: { last_price: 95000, last_update_at: new Date().toISOString(), updates_recorded: 100 },
      eth: { last_price: 3200, last_update_at: new Date().toISOString(), updates_recorded: 100 },
      sol: { last_price: 150, last_update_at: new Date().toISOString(), updates_recorded: 100 },
      xrp: { last_price: 2.50, last_update_at: new Date().toISOString(), updates_recorded: 100 },
    },
  })),
}));

describe('oracle-predictor module', () => {
  beforeEach(async () => {
    // Ensure clean state before each test
    try {
      await oraclePredictor.shutdown();
    } catch {
      // Ignore shutdown errors if not initialized
    }
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await oraclePredictor.shutdown();
    } catch {
      // Ignore shutdown errors
    }
  });

  describe('init', () => {
    it('should initialize successfully', async () => {
      await oraclePredictor.init();
      const state = oraclePredictor.getState();
      expect(state.initialized).toBe(true);
    });

    it('should initialize with custom config', async () => {
      await oraclePredictor.init({
        oraclePredictor: {
          minHistoricalUpdates: 10,
          patternCacheExpiryMs: 60000,
        },
      });
      const state = oraclePredictor.getState();
      expect(state.initialized).toBe(true);
      expect(state.config.minHistoricalUpdates).toBe(10);
    });

    it('should be idempotent (calling twice does not error)', async () => {
      await oraclePredictor.init();
      await oraclePredictor.init();
      const state = oraclePredictor.getState();
      expect(state.initialized).toBe(true);
    });
  });

  describe('getPrediction (before init)', () => {
    it('should throw NOT_INITIALIZED error if not initialized', () => {
      expect(() => oraclePredictor.getPrediction('btc', 30000))
        .toThrow(OraclePredictorError);
      try {
        oraclePredictor.getPrediction('btc', 30000);
      } catch (err) {
        expect(err.code).toBe(OraclePredictorErrorCodes.NOT_INITIALIZED);
      }
    });
  });

  describe('getPrediction (after init)', () => {
    beforeEach(async () => {
      await oraclePredictor.init();
    });

    it('should throw INVALID_SYMBOL for unknown symbol', () => {
      expect(() => oraclePredictor.getPrediction('invalid', 30000))
        .toThrow(OraclePredictorError);
    });

    it('should throw INVALID_INPUT for invalid time to expiry', () => {
      expect(() => oraclePredictor.getPrediction('btc', NaN))
        .toThrow(OraclePredictorError);
    });

    it('should return prediction for valid inputs', () => {
      const result = oraclePredictor.getPrediction('btc', 30000);
      expect(result).toHaveProperty('p_update');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('inputs_used');
    });

    it('should accept all supported symbols', () => {
      const symbols = ['btc', 'eth', 'sol', 'xrp'];
      for (const symbol of symbols) {
        expect(() => oraclePredictor.getPrediction(symbol, 30000)).not.toThrow();
      }
    });

    it('should throw INVALID_INPUT when oracle state produces invalid timeSinceLastUpdate', async () => {
      // Re-mock oracle tracker with invalid date
      const { getState } = await import('../../oracle-tracker/index.js');
      getState.mockReturnValueOnce({
        initialized: true,
        tracking: {
          btc: { last_price: 95000, last_update_at: 'invalid-date', updates_recorded: 100 },
        },
      });

      expect(() => oraclePredictor.getPrediction('btc', 30000))
        .toThrow(OraclePredictorError);
    });
  });

  describe('getPatterns', () => {
    it('should throw NOT_INITIALIZED if not initialized', () => {
      expect(() => oraclePredictor.getPatterns('btc'))
        .toThrow(OraclePredictorError);
      try {
        oraclePredictor.getPatterns('btc');
      } catch (err) {
        expect(err.code).toBe(OraclePredictorErrorCodes.NOT_INITIALIZED);
      }
    });

    it('should throw INVALID_SYMBOL for unknown symbol', async () => {
      await oraclePredictor.init();
      expect(() => oraclePredictor.getPatterns('invalid'))
        .toThrow(OraclePredictorError);
    });

    it('should return null for symbol with no historical data', async () => {
      await oraclePredictor.init();
      const result = oraclePredictor.getPatterns('btc');
      // With mocked empty persistence, should return null
      expect(result).toBeNull();
    });
  });

  describe('getState', () => {
    it('should return not initialized state before init', () => {
      const state = oraclePredictor.getState();
      expect(state.initialized).toBe(false);
    });

    it('should return initialized state after init', async () => {
      await oraclePredictor.init();
      const state = oraclePredictor.getState();
      expect(state.initialized).toBe(true);
      expect(state.patterns).toBeDefined();
      expect(state.calibration).toBeDefined();
      expect(state.stats).toBeDefined();
      expect(state.config).toBeDefined();
    });

    it('should include prediction statistics', async () => {
      await oraclePredictor.init();
      oraclePredictor.getPrediction('btc', 30000);
      const state = oraclePredictor.getState();
      expect(state.stats.predictionsGenerated).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should reset state', async () => {
      await oraclePredictor.init();
      expect(oraclePredictor.getState().initialized).toBe(true);
      await oraclePredictor.shutdown();
      expect(oraclePredictor.getState().initialized).toBe(false);
    });

    it('should allow re-initialization after shutdown', async () => {
      await oraclePredictor.init();
      await oraclePredictor.shutdown();
      await oraclePredictor.init();
      expect(oraclePredictor.getState().initialized).toBe(true);
    });
  });

  describe('error classes', () => {
    it('should export OraclePredictorError', () => {
      expect(OraclePredictorError).toBeDefined();
    });

    it('should export OraclePredictorErrorCodes', () => {
      expect(OraclePredictorErrorCodes).toBeDefined();
      expect(OraclePredictorErrorCodes.NOT_INITIALIZED).toBe('ORACLE_PREDICTOR_NOT_INITIALIZED');
      expect(OraclePredictorErrorCodes.INVALID_SYMBOL).toBe('ORACLE_PREDICTOR_INVALID_SYMBOL');
      expect(OraclePredictorErrorCodes.INVALID_INPUT).toBe('ORACLE_PREDICTOR_INVALID_INPUT');
      expect(OraclePredictorErrorCodes.INSUFFICIENT_DATA).toBe('ORACLE_PREDICTOR_INSUFFICIENT_DATA');
      expect(OraclePredictorErrorCodes.PERSISTENCE_ERROR).toBe('ORACLE_PREDICTOR_PERSISTENCE_ERROR');
    });
  });
});
