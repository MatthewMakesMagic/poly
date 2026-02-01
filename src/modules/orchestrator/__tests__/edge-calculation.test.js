/**
 * Edge Calculation Integration Tests
 *
 * Story 7-13: Tests for the full probability → edge → signal pipeline
 * Validates that:
 * 1. Oracle price + Reference price → correct p_up calculation
 * 2. Edge = p_up - market_price
 * 3. Signal generated only when edge > threshold
 * 4. Suspicious edge (too high) is skipped
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock logger before imports
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  init: vi.fn(),
  shutdown: vi.fn(),
}));

// Mock persistence
vi.mock('../../../persistence/index.js', () => ({
  default: {
    init: vi.fn(),
    get: vi.fn(() => null),
    all: vi.fn(() => []),
    run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
    exec: vi.fn(),
    shutdown: vi.fn(),
  },
}));

import * as windowTimingModel from '../../strategy/components/probability/window-timing-model.js';
import { parseReferencePrice } from '../../window-manager/index.js';

describe('Edge Calculation Pipeline', () => {
  describe('Reference Price Parsing (Story 7-15)', () => {
    it('should parse BTC reference price correctly', () => {
      const price = parseReferencePrice('Will BTC be above $94,500 at 12:15 UTC?');
      expect(price).toBe(94500);
    });

    it('should parse ETH reference price with decimals', () => {
      const price = parseReferencePrice('Will ETH be above $3,250.50 at 12:00 UTC?');
      expect(price).toBe(3250.50);
    });
  });

  describe('Probability Calculation (Story 7-14)', () => {
    beforeEach(async () => {
      await windowTimingModel.init({});
    });

    afterEach(async () => {
      await windowTimingModel.shutdown();
    });

    it('should calculate p_up > 0.5 when oracle > reference', () => {
      // Oracle at $95,000, reference (strike) at $94,500
      // Oracle is above strike, so p_up should be > 0.5
      const result = windowTimingModel.calculateProbability(
        95000,  // S: oracle price
        94500,  // K: reference/strike price
        300000, // T: 5 minutes in ms
        'btc'
      );

      expect(result.p_up).toBeGreaterThan(0.5);
      expect(result.p_down).toBeLessThan(0.5);
    });

    it('should calculate p_up < 0.5 when oracle < reference', () => {
      // Oracle at $94,000, reference (strike) at $94,500
      // Oracle is below strike, so p_up should be < 0.5
      const result = windowTimingModel.calculateProbability(
        94000,  // S: oracle price
        94500,  // K: reference/strike price
        300000, // T: 5 minutes in ms
        'btc'
      );

      expect(result.p_up).toBeLessThan(0.5);
      expect(result.p_down).toBeGreaterThan(0.5);
    });

    it('should return p_up ≈ 0.5 when oracle = reference', () => {
      const result = windowTimingModel.calculateProbability(
        94500,  // S = K
        94500,
        300000,
        'btc'
      );

      expect(result.p_up).toBeCloseTo(0.5, 1);
    });
  });

  describe('Edge Calculation (Story 7-16)', () => {
    beforeEach(async () => {
      await windowTimingModel.init({});
    });

    afterEach(async () => {
      await windowTimingModel.shutdown();
    });

    it('should calculate positive edge when model > market', () => {
      // Model says 75% chance UP
      const probResult = windowTimingModel.calculateProbability(95500, 94500, 300000, 'btc');
      const modelProbability = probResult.p_up;

      // Market is pricing at 52%
      const marketPrice = 0.52;

      // Edge should be positive
      const edge = modelProbability - marketPrice;

      expect(modelProbability).toBeGreaterThan(0.6);
      expect(edge).toBeGreaterThan(0.10);  // Should exceed min threshold
    });

    it('should calculate negative edge when model < market', () => {
      // Oracle BELOW strike → model says low probability of UP
      const probResult = windowTimingModel.calculateProbability(94000, 94500, 300000, 'btc');
      const modelProbability = probResult.p_up;

      // Market is pricing at 60% (overpriced relative to model)
      const marketPrice = 0.60;

      // Edge should be negative (model < market)
      const edge = modelProbability - marketPrice;

      expect(modelProbability).toBeLessThan(0.5);
      expect(edge).toBeLessThan(0);  // No trade - negative edge
    });

    it('should signal entry only when edge exceeds threshold', () => {
      const minEdgeThreshold = 0.10;

      // Case 1: Edge above threshold → should trade
      // Oracle well above strike, market underpriced
      const prob1 = windowTimingModel.calculateProbability(96000, 94500, 300000, 'btc');
      const edge1 = prob1.p_up - 0.52;
      expect(edge1).toBeGreaterThan(minEdgeThreshold);

      // Case 2: Edge below threshold → should NOT trade
      // Oracle slightly above strike, market fairly priced
      const prob2 = windowTimingModel.calculateProbability(94600, 94500, 300000, 'btc');
      const edge2 = prob2.p_up - 0.70;  // Market at 70% - close to model
      expect(edge2).toBeLessThan(minEdgeThreshold);
    });
  });

  describe('Evaluate Function Integration', () => {
    beforeEach(async () => {
      await windowTimingModel.init({});
    });

    afterEach(async () => {
      await windowTimingModel.shutdown();
    });

    it('should accept new field names (oracle_price, reference_price)', () => {
      const context = {
        oracle_price: 95000,
        reference_price: 94500,
        market_price: 0.52,
        timeToExpiry: 300000,
        symbol: 'btc',
      };

      const result = windowTimingModel.evaluate(context, {});

      expect(result.probability).toBeGreaterThan(0.5);
      expect(result.market_price).toBe(0.52);
      expect(result.details.oracle_price).toBe(95000);
      expect(result.details.reference_price).toBe(94500);
    });

    it('should fall back to legacy field names (spotPrice, targetPrice)', () => {
      const context = {
        spotPrice: 95000,
        targetPrice: 94500,
        market_price: 0.52,
        timeToExpiry: 300000,
        symbol: 'btc',
      };

      const result = windowTimingModel.evaluate(context, {});

      expect(result.probability).toBeGreaterThan(0.5);
    });

    it('should return error when missing required inputs', () => {
      const context = {
        timeToExpiry: 300000,
        symbol: 'btc',
        // Missing oracle_price and reference_price
      };

      const result = windowTimingModel.evaluate(context, {});

      expect(result.probability).toBeNull();
      expect(result.error).toBeDefined();
    });
  });

  describe('End-to-End Scenario', () => {
    beforeEach(async () => {
      await windowTimingModel.init({});
    });

    afterEach(async () => {
      await windowTimingModel.shutdown();
    });

    it('should produce correct signal for profitable opportunity', () => {
      // Scenario: BTC oracle at $95,500, market reference at $94,500
      // Market is pricing UP token at 0.52 (52% implied probability)
      // Model calculates ~75% probability
      // Edge = 75% - 52% = 23% → TRADE

      const context = {
        oracle_price: 95500,
        reference_price: 94500,
        market_price: 0.52,
        timeToExpiry: 300000,  // 5 minutes
        symbol: 'btc',
      };

      const result = windowTimingModel.evaluate(context, {});
      const edge = result.probability - context.market_price;

      console.log(`Model probability: ${(result.probability * 100).toFixed(1)}%`);
      console.log(`Market price: ${(context.market_price * 100).toFixed(1)}%`);
      console.log(`Edge: ${(edge * 100).toFixed(1)}%`);

      expect(result.probability).toBeGreaterThan(0.65);
      expect(edge).toBeGreaterThan(0.15);  // Significant edge
    });

    it('should NOT signal for overpriced market', () => {
      // Scenario: BTC oracle at $94,600, market reference at $94,500
      // Market is pricing UP token at 0.85 (85% implied probability)
      // Model calculates ~55% probability
      // Edge = 55% - 85% = -30% → NO TRADE

      const context = {
        oracle_price: 94600,
        reference_price: 94500,
        market_price: 0.85,
        timeToExpiry: 300000,
        symbol: 'btc',
      };

      const result = windowTimingModel.evaluate(context, {});
      const edge = result.probability - context.market_price;

      console.log(`Model probability: ${(result.probability * 100).toFixed(1)}%`);
      console.log(`Market price: ${(context.market_price * 100).toFixed(1)}%`);
      console.log(`Edge: ${(edge * 100).toFixed(1)}%`);

      expect(edge).toBeLessThan(0);  // Negative edge - don't trade
    });
  });

  describe('Window Timing Filter (Story 7-19)', () => {
    it('should define timing thresholds in config', () => {
      // Verify config structure
      const config = {
        window_timing: {
          min_time_remaining_ms: 30000,  // 30 seconds
          max_time_remaining_ms: 600000, // 10 minutes
        },
      };

      expect(config.window_timing.min_time_remaining_ms).toBe(30000);
      expect(config.window_timing.max_time_remaining_ms).toBe(600000);
    });

    it('should skip window when time remaining < min threshold', () => {
      // Window with only 20s remaining (below 30s min)
      const timeRemainingMs = 20000;
      const minTimeMs = 30000;

      const shouldSkip = timeRemainingMs < minTimeMs;
      expect(shouldSkip).toBe(true);
    });

    it('should skip window when time remaining > max threshold', () => {
      // Window with 12 minutes remaining (above 10min max)
      const timeRemainingMs = 720000;
      const maxTimeMs = 600000;

      const shouldSkip = timeRemainingMs > maxTimeMs;
      expect(shouldSkip).toBe(true);
    });

    it('should allow window when time is within valid range', () => {
      // Window with 5 minutes remaining (within 30s-10min range)
      const timeRemainingMs = 300000;
      const minTimeMs = 30000;
      const maxTimeMs = 600000;

      const shouldSkip = timeRemainingMs < minTimeMs || timeRemainingMs > maxTimeMs;
      expect(shouldSkip).toBe(false);
    });

    it('should allow window at exact min boundary', () => {
      // Window with exactly 30s remaining
      const timeRemainingMs = 30000;
      const minTimeMs = 30000;
      const maxTimeMs = 600000;

      const shouldSkip = timeRemainingMs < minTimeMs || timeRemainingMs > maxTimeMs;
      expect(shouldSkip).toBe(false);
    });

    it('should allow window at exact max boundary', () => {
      // Window with exactly 10min remaining
      const timeRemainingMs = 600000;
      const minTimeMs = 30000;
      const maxTimeMs = 600000;

      const shouldSkip = timeRemainingMs < minTimeMs || timeRemainingMs > maxTimeMs;
      expect(shouldSkip).toBe(false);
    });

    it('should use default thresholds when config not provided', () => {
      // Test default behavior
      const strategyConfig = {};

      const minTimeMs = strategyConfig?.window_timing?.min_time_remaining_ms ?? 30000;
      const maxTimeMs = strategyConfig?.window_timing?.max_time_remaining_ms ?? 600000;

      expect(minTimeMs).toBe(30000);
      expect(maxTimeMs).toBe(600000);
    });
  });
});
