/**
 * Stop-Loss Logic Unit Tests
 *
 * Tests the core stop-loss calculation and evaluation logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  calculateStopLossThreshold,
  evaluate,
  evaluateAll,
} from '../logic.js';
import { TriggerReason, StopLossErrorCodes } from '../types.js';
import * as state from '../state.js';

// Mock logger
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('calculateStopLossThreshold', () => {
  describe('long positions', () => {
    it('calculates threshold correctly for long position with 5% stop-loss', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };
      const result = calculateStopLossThreshold(position, 0.05);

      expect(result.threshold).toBeCloseTo(0.475, 4); // 0.50 * (1 - 0.05)
      expect(result.entry_price).toBe(0.50);
      expect(result.side).toBe('long');
      expect(result.stop_loss_pct).toBe(0.05);
    });

    it('calculates threshold correctly for long position with 10% stop-loss', () => {
      const position = { id: 2, entry_price: 1.00, side: 'long' };
      const result = calculateStopLossThreshold(position, 0.10);

      expect(result.threshold).toBeCloseTo(0.90, 4); // 1.00 * (1 - 0.10)
    });

    it('calculates threshold for long position with 2% stop-loss', () => {
      const position = { id: 3, entry_price: 0.65, side: 'long' };
      const result = calculateStopLossThreshold(position, 0.02);

      expect(result.threshold).toBeCloseTo(0.637, 4); // 0.65 * (1 - 0.02)
    });
  });

  describe('short positions', () => {
    it('calculates threshold correctly for short position with 5% stop-loss', () => {
      const position = { id: 1, entry_price: 0.50, side: 'short' };
      const result = calculateStopLossThreshold(position, 0.05);

      expect(result.threshold).toBeCloseTo(0.525, 4); // 0.50 * (1 + 0.05)
      expect(result.entry_price).toBe(0.50);
      expect(result.side).toBe('short');
      expect(result.stop_loss_pct).toBe(0.05);
    });

    it('calculates threshold correctly for short position with 10% stop-loss', () => {
      const position = { id: 2, entry_price: 1.00, side: 'short' };
      const result = calculateStopLossThreshold(position, 0.10);

      expect(result.threshold).toBeCloseTo(1.10, 4); // 1.00 * (1 + 0.10)
    });
  });

  describe('edge cases', () => {
    it('handles zero stop-loss percentage', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };
      const result = calculateStopLossThreshold(position, 0);

      expect(result.threshold).toBe(0.50); // Entry price = threshold
    });

    it('throws on invalid entry_price (zero)', () => {
      const position = { id: 1, entry_price: 0, side: 'long' };

      expect(() => calculateStopLossThreshold(position, 0.05))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on invalid entry_price (negative)', () => {
      const position = { id: 1, entry_price: -0.50, side: 'long' };

      expect(() => calculateStopLossThreshold(position, 0.05))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on invalid entry_price (undefined)', () => {
      const position = { id: 1, side: 'long' };

      expect(() => calculateStopLossThreshold(position, 0.05))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on negative stop-loss percentage', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };

      expect(() => calculateStopLossThreshold(position, -0.05))
        .toThrow('Stop-loss percentage must be a number between 0 and 1');
    });

    it('throws on stop-loss percentage greater than 1', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };

      expect(() => calculateStopLossThreshold(position, 1.5))
        .toThrow('Stop-loss percentage must be a number between 0 and 1');
    });

    it('throws on invalid side', () => {
      const position = { id: 1, entry_price: 0.50, side: 'invalid' };

      expect(() => calculateStopLossThreshold(position, 0.05))
        .toThrow('Position has invalid side');
    });

    it('throws on missing side', () => {
      const position = { id: 1, entry_price: 0.50 };

      expect(() => calculateStopLossThreshold(position, 0.05))
        .toThrow('Position has invalid side');
    });
  });
});

describe('evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  describe('long positions', () => {
    const longPosition = {
      id: 1,
      window_id: 'btc-15m-2026-01-31',
      side: 'long',
      size: 10,
      entry_price: 0.50,
    };

    it('triggers when price drops below threshold', () => {
      // 5% stop-loss: threshold = 0.475, price = 0.47 (6% drop)
      const result = evaluate(longPosition, 0.47, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_BELOW_THRESHOLD);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('market');
      expect(result.position_id).toBe(1);
      expect(result.stop_loss_threshold).toBeCloseTo(0.475, 4);
    });

    it('triggers when price equals threshold exactly', () => {
      const result = evaluate(longPosition, 0.475, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_BELOW_THRESHOLD);
    });

    it('does NOT trigger when price is above threshold', () => {
      // Price = 0.48 (4% drop), threshold = 0.475
      const result = evaluate(longPosition, 0.48, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe(TriggerReason.NOT_TRIGGERED);
      expect(result.action).toBeNull();
      expect(result.closeMethod).toBeNull();
    });

    it('calculates loss amount correctly when triggered', () => {
      // Entry = 0.50, Current = 0.47, Size = 10
      // Loss = 10 * (0.50 - 0.47) = 0.30
      const result = evaluate(longPosition, 0.47, { stopLossPct: 0.05, log: mockLog });

      expect(result.loss_amount).toBeCloseTo(0.30, 4);
      expect(result.loss_pct).toBeCloseTo(0.06, 4); // 6% loss
    });

    it('sets loss_amount to 0 when not triggered', () => {
      const result = evaluate(longPosition, 0.48, { stopLossPct: 0.05, log: mockLog });

      expect(result.loss_amount).toBe(0);
      expect(result.loss_pct).toBe(0);
    });
  });

  describe('short positions', () => {
    const shortPosition = {
      id: 2,
      window_id: 'btc-15m-2026-01-31',
      side: 'short',
      size: 10,
      entry_price: 0.50,
    };

    it('triggers when price rises above threshold', () => {
      // 5% stop-loss: threshold = 0.525, price = 0.53 (6% rise)
      const result = evaluate(shortPosition, 0.53, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_ABOVE_THRESHOLD);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('market');
      expect(result.stop_loss_threshold).toBeCloseTo(0.525, 4);
    });

    it('triggers when price equals threshold exactly', () => {
      const result = evaluate(shortPosition, 0.525, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_ABOVE_THRESHOLD);
    });

    it('does NOT trigger when price is below threshold', () => {
      // Price = 0.52 (4% rise), threshold = 0.525
      const result = evaluate(shortPosition, 0.52, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe(TriggerReason.NOT_TRIGGERED);
    });

    it('calculates loss amount correctly when triggered', () => {
      // Entry = 0.50, Current = 0.53, Size = 10
      // Loss = 10 * (0.53 - 0.50) = 0.30
      const result = evaluate(shortPosition, 0.53, { stopLossPct: 0.05, log: mockLog });

      expect(result.loss_amount).toBeCloseTo(0.30, 4);
      expect(result.loss_pct).toBeCloseTo(0.06, 4); // 6% loss
    });
  });

  describe('per-position override', () => {
    it('uses per-position stop_loss_pct when provided', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
        stop_loss_pct: 0.10, // Per-position 10% override
      };

      // Price = 0.47 (6% drop), 5% default would trigger, but 10% doesn't
      const result = evaluate(position, 0.47, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(false); // 6% < 10%
      expect(result.stop_loss_pct).toBe(0.10);
    });

    it('uses default when per-position not set', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = evaluate(position, 0.47, { stopLossPct: 0.05, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.stop_loss_pct).toBe(0.05);
    });
  });

  describe('logging', () => {
    it('logs at info level when triggered', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      evaluate(position, 0.47, { stopLossPct: 0.05, log: mockLog });

      expect(mockLog.info).toHaveBeenCalledWith('stop_loss_triggered', expect.objectContaining({
        position_id: 1,
        entry_price: 0.50,
        current_price: 0.47,
      }));
    });

    it('logs at debug level when not triggered', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      evaluate(position, 0.48, { stopLossPct: 0.05, log: mockLog });

      expect(mockLog.debug).toHaveBeenCalledWith('stop_loss_evaluated', expect.objectContaining({
        position_id: 1,
        current_price: 0.48,
      }));
    });
  });

  describe('error handling', () => {
    it('throws on invalid current price (zero)', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluate(position, 0, { stopLossPct: 0.05 }))
        .toThrow('Invalid current price');
    });

    it('throws on invalid current price (negative)', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluate(position, -0.47, { stopLossPct: 0.05 }))
        .toThrow('Invalid current price');
    });

    it('throws on invalid current price (non-number)', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluate(position, 'invalid', { stopLossPct: 0.05 }))
        .toThrow('Invalid current price');
    });
  });

  describe('result fields', () => {
    it('includes all required fields in StopLossResult', () => {
      const position = {
        id: 1,
        window_id: 'btc-15m-2026-01-31',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = evaluate(position, 0.47, { stopLossPct: 0.05 });

      expect(result).toMatchObject({
        triggered: expect.any(Boolean),
        position_id: 1,
        window_id: 'btc-15m-2026-01-31',
        side: 'long',
        entry_price: 0.50,
        current_price: 0.47,
        stop_loss_threshold: expect.any(Number),
        stop_loss_pct: 0.05,
        reason: expect.any(String),
        loss_amount: expect.any(Number),
        loss_pct: expect.any(Number),
        evaluated_at: expect.any(String),
      });
    });
  });
});

describe('evaluateAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  it('evaluates multiple positions and returns only triggered', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },  // Will trigger at 0.47
      { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50 },  // Safe at 0.50
      { id: 3, window_id: 'w3', side: 'short', size: 10, entry_price: 0.50 }, // Will trigger at 0.53
    ];

    const getCurrentPrice = (pos) => {
      if (pos.id === 1) return 0.47;  // 6% drop - triggered
      if (pos.id === 2) return 0.50;  // No change - safe
      if (pos.id === 3) return 0.53;  // 6% rise - triggered
      return null;
    };

    const { triggered, summary } = evaluateAll(positions, getCurrentPrice, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    expect(triggered.length).toBe(2);
    expect(triggered[0].position_id).toBe(1);
    expect(triggered[1].position_id).toBe(3);
    expect(summary.evaluated).toBe(3);
    expect(summary.triggered).toBe(2);
    expect(summary.safe).toBe(1);
  });

  it('returns empty array when no positions', () => {
    const { triggered, summary } = evaluateAll([], () => 0.50, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    expect(triggered.length).toBe(0);
    expect(summary.evaluated).toBe(0);
    expect(summary.triggered).toBe(0);
    expect(summary.safe).toBe(0);
  });

  it('returns empty array when all positions are safe', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
      { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50 },
    ];

    const { triggered, summary } = evaluateAll(positions, () => 0.50, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    expect(triggered.length).toBe(0);
    expect(summary.evaluated).toBe(2);
    expect(summary.triggered).toBe(0);
    expect(summary.safe).toBe(2);
  });

  it('skips positions without price and logs warning', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
      { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50 }, // No price
    ];

    const getCurrentPrice = (pos) => {
      if (pos.id === 1) return 0.47;
      return null; // Position 2 has no price
    };

    const { triggered, summary } = evaluateAll(positions, getCurrentPrice, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    expect(triggered.length).toBe(1);
    expect(summary.evaluated).toBe(1);
    expect(mockLog.warn).toHaveBeenCalledWith('stop_loss_skip_no_price', { position_id: 2 });
  });

  it('continues evaluating after individual position error', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },  // OK
      { id: 2, window_id: 'w2', side: 'invalid', size: 10, entry_price: 0.50 }, // Will error
      { id: 3, window_id: 'w3', side: 'long', size: 10, entry_price: 0.50 },  // OK
    ];

    const { triggered, summary } = evaluateAll(positions, () => 0.47, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    // Should still evaluate positions 1 and 3
    expect(triggered.length).toBe(2);
    expect(summary.evaluated).toBe(2);
    expect(mockLog.error).toHaveBeenCalledWith('stop_loss_evaluation_error', expect.objectContaining({
      position_id: 2,
    }));
  });

  it('logs summary on completion', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
    ];

    evaluateAll(positions, () => 0.47, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    expect(mockLog.info).toHaveBeenCalledWith('stop_loss_evaluation_complete', expect.objectContaining({
      total_positions: 1,
      evaluated: 1,
      triggered: 1,
      safe: 0,
    }));
  });

  it('uses per-position stop_loss_pct when available', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 }, // Use default 5%
      { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50, stop_loss_pct: 0.10 }, // Override to 10%
    ];

    // Price = 0.47 (6% drop) - triggers 5% but not 10%
    const { triggered, summary } = evaluateAll(positions, () => 0.47, {
      stopLossPct: 0.05,
      log: mockLog,
    });

    expect(triggered.length).toBe(1);
    expect(triggered[0].position_id).toBe(1);
    expect(summary.safe).toBe(1);
  });
});
