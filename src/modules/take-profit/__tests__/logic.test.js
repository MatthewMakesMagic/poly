/**
 * Take-Profit Logic Unit Tests
 *
 * Tests the core take-profit calculation and evaluation logic.
 *
 * Key difference from stop-loss:
 * - Long: triggered when price RISES ABOVE threshold (profit)
 * - Short: triggered when price DROPS BELOW threshold (profit)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  calculateTakeProfitThreshold,
  evaluate,
  evaluateAll,
  evaluateTrailing,
} from '../logic.js';
import { TriggerReason, TakeProfitErrorCodes } from '../types.js';
import * as state from '../state.js';

// Mock logger
const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('calculateTakeProfitThreshold', () => {
  describe('long positions', () => {
    it('calculates threshold correctly for long position with 10% take-profit', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };
      const result = calculateTakeProfitThreshold(position, 0.10);

      expect(result.threshold).toBeCloseTo(0.55, 4); // 0.50 * (1 + 0.10)
      expect(result.entry_price).toBe(0.50);
      expect(result.side).toBe('long');
      expect(result.take_profit_pct).toBe(0.10);
    });

    it('calculates threshold correctly for long position with 5% take-profit', () => {
      const position = { id: 2, entry_price: 1.00, side: 'long' };
      const result = calculateTakeProfitThreshold(position, 0.05);

      expect(result.threshold).toBeCloseTo(1.05, 4); // 1.00 * (1 + 0.05)
    });

    it('calculates threshold for long position with 20% take-profit', () => {
      const position = { id: 3, entry_price: 0.65, side: 'long' };
      const result = calculateTakeProfitThreshold(position, 0.20);

      expect(result.threshold).toBeCloseTo(0.78, 4); // 0.65 * (1 + 0.20)
    });
  });

  describe('short positions', () => {
    it('calculates threshold correctly for short position with 10% take-profit', () => {
      const position = { id: 1, entry_price: 0.50, side: 'short' };
      const result = calculateTakeProfitThreshold(position, 0.10);

      expect(result.threshold).toBeCloseTo(0.45, 4); // 0.50 * (1 - 0.10)
      expect(result.entry_price).toBe(0.50);
      expect(result.side).toBe('short');
      expect(result.take_profit_pct).toBe(0.10);
    });

    it('calculates threshold correctly for short position with 5% take-profit', () => {
      const position = { id: 2, entry_price: 1.00, side: 'short' };
      const result = calculateTakeProfitThreshold(position, 0.05);

      expect(result.threshold).toBeCloseTo(0.95, 4); // 1.00 * (1 - 0.05)
    });
  });

  describe('edge cases', () => {
    it('handles zero take-profit percentage', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };
      const result = calculateTakeProfitThreshold(position, 0);

      expect(result.threshold).toBe(0.50); // Entry price = threshold
    });

    it('throws on invalid entry_price (zero)', () => {
      const position = { id: 1, entry_price: 0, side: 'long' };

      expect(() => calculateTakeProfitThreshold(position, 0.10))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on invalid entry_price (negative)', () => {
      const position = { id: 1, entry_price: -0.50, side: 'long' };

      expect(() => calculateTakeProfitThreshold(position, 0.10))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on invalid entry_price (undefined)', () => {
      const position = { id: 1, side: 'long' };

      expect(() => calculateTakeProfitThreshold(position, 0.10))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on negative take-profit percentage', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };

      expect(() => calculateTakeProfitThreshold(position, -0.10))
        .toThrow('Take-profit percentage must be a number between 0 and 1');
    });

    it('throws on take-profit percentage greater than 1', () => {
      const position = { id: 1, entry_price: 0.50, side: 'long' };

      expect(() => calculateTakeProfitThreshold(position, 1.5))
        .toThrow('Take-profit percentage must be a number between 0 and 1');
    });

    it('throws on invalid side', () => {
      const position = { id: 1, entry_price: 0.50, side: 'invalid' };

      expect(() => calculateTakeProfitThreshold(position, 0.10))
        .toThrow('Position has invalid side');
    });

    it('throws on missing side', () => {
      const position = { id: 1, entry_price: 0.50 };

      expect(() => calculateTakeProfitThreshold(position, 0.10))
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

    it('triggers when price rises above threshold', () => {
      // 10% take-profit: threshold = 0.55, price = 0.56 (12% gain)
      const result = evaluate(longPosition, 0.56, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_ABOVE_THRESHOLD);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('limit'); // NOT 'market' like stop-loss
      expect(result.position_id).toBe(1);
      expect(result.take_profit_threshold).toBeCloseTo(0.55, 4);
    });

    it('triggers when price equals threshold exactly', () => {
      const result = evaluate(longPosition, 0.55, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_ABOVE_THRESHOLD);
    });

    it('does NOT trigger when price is below threshold', () => {
      // Price = 0.54 (8% gain), threshold = 0.55
      const result = evaluate(longPosition, 0.54, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe(TriggerReason.NOT_TRIGGERED);
      expect(result.action).toBeNull();
      expect(result.closeMethod).toBeNull();
    });

    it('calculates profit amount correctly when triggered', () => {
      // Entry = 0.50, Current = 0.56, Size = 10
      // Profit = 10 * (0.56 - 0.50) = 0.60
      const result = evaluate(longPosition, 0.56, { takeProfitPct: 0.10, log: mockLog });

      expect(result.profit_amount).toBeCloseTo(0.60, 4);
      expect(result.profit_pct).toBeCloseTo(0.12, 4); // 12% profit
    });

    it('sets profit_amount to 0 when not triggered', () => {
      const result = evaluate(longPosition, 0.54, { takeProfitPct: 0.10, log: mockLog });

      expect(result.profit_amount).toBe(0);
      expect(result.profit_pct).toBe(0);
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

    it('triggers when price drops below threshold', () => {
      // 10% take-profit: threshold = 0.45, price = 0.44 (12% drop)
      const result = evaluate(shortPosition, 0.44, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_BELOW_THRESHOLD);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('limit');
      expect(result.take_profit_threshold).toBeCloseTo(0.45, 4);
    });

    it('triggers when price equals threshold exactly', () => {
      const result = evaluate(shortPosition, 0.45, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.PRICE_BELOW_THRESHOLD);
    });

    it('does NOT trigger when price is above threshold', () => {
      // Price = 0.46 (8% drop), threshold = 0.45
      const result = evaluate(shortPosition, 0.46, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe(TriggerReason.NOT_TRIGGERED);
    });

    it('calculates profit amount correctly when triggered', () => {
      // Entry = 0.50, Current = 0.44, Size = 10
      // Profit = 10 * (0.50 - 0.44) = 0.60
      const result = evaluate(shortPosition, 0.44, { takeProfitPct: 0.10, log: mockLog });

      expect(result.profit_amount).toBeCloseTo(0.60, 4);
      expect(result.profit_pct).toBeCloseTo(0.12, 4); // 12% profit
    });
  });

  describe('per-position override', () => {
    it('uses per-position take_profit_pct when provided', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
        take_profit_pct: 0.20, // Per-position 20% override
      };

      // Price = 0.56 (12% gain), 10% default would trigger, but 20% doesn't
      const result = evaluate(position, 0.56, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(false); // 12% < 20%
      expect(result.take_profit_pct).toBe(0.20);
    });

    it('uses default when per-position not set', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = evaluate(position, 0.56, { takeProfitPct: 0.10, log: mockLog });

      expect(result.triggered).toBe(true);
      expect(result.take_profit_pct).toBe(0.10);
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

      evaluate(position, 0.56, { takeProfitPct: 0.10, log: mockLog });

      expect(mockLog.info).toHaveBeenCalledWith('take_profit_triggered', expect.objectContaining({
        position_id: 1,
        entry_price: 0.50,
        current_price: 0.56,
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

      evaluate(position, 0.54, { takeProfitPct: 0.10, log: mockLog });

      expect(mockLog.debug).toHaveBeenCalledWith('take_profit_evaluated', expect.objectContaining({
        position_id: 1,
        current_price: 0.54,
      }));
    });
  });

  describe('error handling', () => {
    it('throws on invalid current price (zero)', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluate(position, 0, { takeProfitPct: 0.10 }))
        .toThrow('Invalid current price');
    });

    it('throws on invalid current price (negative)', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluate(position, -0.56, { takeProfitPct: 0.10 }))
        .toThrow('Invalid current price');
    });

    it('throws on invalid current price (non-number)', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluate(position, 'invalid', { takeProfitPct: 0.10 }))
        .toThrow('Invalid current price');
    });
  });

  describe('result fields', () => {
    it('includes all required fields in TakeProfitResult', () => {
      const position = {
        id: 1,
        window_id: 'btc-15m-2026-01-31',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = evaluate(position, 0.56, { takeProfitPct: 0.10 });

      expect(result).toMatchObject({
        triggered: expect.any(Boolean),
        position_id: 1,
        window_id: 'btc-15m-2026-01-31',
        side: 'long',
        entry_price: 0.50,
        current_price: 0.56,
        take_profit_threshold: expect.any(Number),
        take_profit_pct: 0.10,
        reason: expect.any(String),
        profit_amount: expect.any(Number),
        profit_pct: expect.any(Number),
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
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },  // Will trigger at 0.56
      { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50 },  // Safe at 0.54
      { id: 3, window_id: 'w3', side: 'short', size: 10, entry_price: 0.50 }, // Will trigger at 0.44
    ];

    const getCurrentPrice = (pos) => {
      if (pos.id === 1) return 0.56;  // 12% gain - triggered
      if (pos.id === 2) return 0.54;  // 8% gain - safe
      if (pos.id === 3) return 0.44;  // 12% drop - triggered
      return null;
    };

    const { triggered, summary } = evaluateAll(positions, getCurrentPrice, {
      takeProfitPct: 0.10,
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
    const { triggered, summary } = evaluateAll([], () => 0.56, {
      takeProfitPct: 0.10,
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

    const { triggered, summary } = evaluateAll(positions, () => 0.54, {
      takeProfitPct: 0.10,
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
      if (pos.id === 1) return 0.56;
      return null; // Position 2 has no price
    };

    const { triggered, summary } = evaluateAll(positions, getCurrentPrice, {
      takeProfitPct: 0.10,
      log: mockLog,
    });

    expect(triggered.length).toBe(1);
    expect(summary.evaluated).toBe(1);
    expect(mockLog.warn).toHaveBeenCalledWith('take_profit_skip_no_price', { position_id: 2 });
  });

  it('continues evaluating after individual position error', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },  // OK
      { id: 2, window_id: 'w2', side: 'invalid', size: 10, entry_price: 0.50 }, // Will error
      { id: 3, window_id: 'w3', side: 'long', size: 10, entry_price: 0.50 },  // OK
    ];

    const { triggered, summary } = evaluateAll(positions, () => 0.56, {
      takeProfitPct: 0.10,
      log: mockLog,
    });

    // Should still evaluate positions 1 and 3
    expect(triggered.length).toBe(2);
    expect(summary.evaluated).toBe(2);
    expect(mockLog.error).toHaveBeenCalledWith('take_profit_evaluation_error', expect.objectContaining({
      position_id: 2,
    }));
  });

  it('logs summary on completion', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 },
    ];

    evaluateAll(positions, () => 0.56, {
      takeProfitPct: 0.10,
      log: mockLog,
    });

    expect(mockLog.info).toHaveBeenCalledWith('take_profit_evaluation_complete', expect.objectContaining({
      total_positions: 1,
      evaluated: 1,
      triggered: 1,
      safe: 0,
    }));
  });

  it('uses per-position take_profit_pct when available', () => {
    const positions = [
      { id: 1, window_id: 'w1', side: 'long', size: 10, entry_price: 0.50 }, // Use default 10%
      { id: 2, window_id: 'w2', side: 'long', size: 10, entry_price: 0.50, take_profit_pct: 0.20 }, // Override to 20%
    ];

    // Price = 0.56 (12% gain) - triggers 10% but not 20%
    const { triggered, summary } = evaluateAll(positions, () => 0.56, {
      takeProfitPct: 0.10,
      log: mockLog,
    });

    expect(triggered.length).toBe(1);
    expect(triggered[0].position_id).toBe(1);
    expect(summary.safe).toBe(1);
  });
});

describe('evaluateTrailing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.resetState();
  });

  describe('high-water mark tracking', () => {
    it('tracks high-water mark for long positions (highest price)', () => {
      const position = {
        id: 1,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      // First eval at 0.55 - sets HWM
      const result1 = evaluateTrailing(position, 0.55, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result1.high_water_mark).toBe(0.55);

      // Second eval at 0.60 - HWM updates
      const result2 = evaluateTrailing(position, 0.60, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result2.high_water_mark).toBe(0.60);

      // Third eval at 0.58 - HWM stays at 0.60
      const result3 = evaluateTrailing(position, 0.58, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result3.high_water_mark).toBe(0.60);
    });

    it('tracks high-water mark for short positions (lowest price)', () => {
      const position = {
        id: 2,
        window_id: 'test',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      // First eval at 0.45 - sets HWM (lowest)
      const result1 = evaluateTrailing(position, 0.45, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result1.high_water_mark).toBe(0.45);

      // Second eval at 0.40 - HWM updates (lower)
      const result2 = evaluateTrailing(position, 0.40, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result2.high_water_mark).toBe(0.40);

      // Third eval at 0.42 - HWM stays at 0.40
      const result3 = evaluateTrailing(position, 0.42, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result3.high_water_mark).toBe(0.40);
    });
  });

  describe('trailing activation', () => {
    it('activates trailing when profit exceeds activation threshold for long', () => {
      const position = {
        id: 3,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      // 10% gain - below 15% activation threshold
      const result1 = evaluateTrailing(position, 0.55, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result1.trailing_active).toBe(false);

      // 20% gain - above 15% activation threshold
      const result2 = evaluateTrailing(position, 0.60, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result2.trailing_active).toBe(true);
      expect(mockLog.info).toHaveBeenCalledWith('trailing_activated', expect.objectContaining({
        position_id: 3,
      }));
    });

    it('activates trailing when profit exceeds activation threshold for short', () => {
      const position = {
        id: 4,
        window_id: 'test',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      // 10% drop - below 15% activation threshold
      const result1 = evaluateTrailing(position, 0.45, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result1.trailing_active).toBe(false);

      // 20% drop - above 15% activation threshold
      const result2 = evaluateTrailing(position, 0.40, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });
      expect(result2.trailing_active).toBe(true);
    });
  });

  describe('trailing stop trigger', () => {
    it('triggers when price drops from HWM by pullback % for long', () => {
      const position = {
        id: 5,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      // First: reach 20% profit to activate (HWM = 0.60)
      evaluateTrailing(position, 0.60, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      // Now price drops 10% from HWM: 0.60 * 0.90 = 0.54
      const result = evaluateTrailing(position, 0.54, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.TRAILING_STOP_HIT);
      expect(result.action).toBe('close');
      expect(result.closeMethod).toBe('limit');
      expect(result.trailing_stop_price).toBeCloseTo(0.54, 2); // HWM * (1 - pullback)
    });

    it('triggers when price rises from HWM by pullback % for short', () => {
      const position = {
        id: 6,
        window_id: 'test',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      // First: reach 20% profit to activate (HWM = 0.40)
      evaluateTrailing(position, 0.40, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      // Now price rises beyond 10% from HWM (0.45 > 0.40 * 1.10 = 0.44)
      // Using 0.45 to avoid floating point precision issues
      const result = evaluateTrailing(position, 0.45, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe(TriggerReason.TRAILING_STOP_HIT);
    });

    it('does not trigger if pullback not reached', () => {
      const position = {
        id: 7,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      // Activate at 0.60
      evaluateTrailing(position, 0.60, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });

      // Price at 0.56 - only 6.7% drop, not 10%
      const result = evaluateTrailing(position, 0.56, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        log: mockLog,
      });

      expect(result.triggered).toBe(false);
      expect(result.trailing_active).toBe(true);
    });
  });

  describe('minimum profit floor', () => {
    it('enforces minimum profit floor for long positions', () => {
      const position = {
        id: 8,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      // Activate at 0.58 (16% profit)
      evaluateTrailing(position, 0.58, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.50, // 50% pullback would be 0.29, but floor is 0.525 (5%)
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      // Price at 0.52 - below calculated trailing stop but above profit floor
      const result = evaluateTrailing(position, 0.52, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.50,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      // Trailing stop price should be max(0.29, 0.525) = 0.525
      expect(result.trailing_stop_price).toBeCloseTo(0.525, 3);
      expect(result.triggered).toBe(true); // 0.52 <= 0.525
    });

    it('enforces minimum profit floor for short positions', () => {
      const position = {
        id: 9,
        window_id: 'test',
        side: 'short',
        size: 10,
        entry_price: 0.50,
      };

      // Activate at 0.42 (16% drop profit)
      evaluateTrailing(position, 0.42, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.50, // 50% pullback would be 0.63, but floor is 0.475 (5%)
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      // Price at 0.48 - above calculated trailing stop but below profit floor
      const result = evaluateTrailing(position, 0.48, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.50,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      // Trailing stop price should be min(0.63, 0.475) = 0.475
      expect(result.trailing_stop_price).toBeCloseTo(0.475, 3);
      expect(result.triggered).toBe(true); // 0.48 >= 0.475
    });
  });

  describe('error handling', () => {
    it('throws on invalid current price', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0.50 };

      expect(() => evaluateTrailing(position, 0, {}))
        .toThrow('Invalid current price');
    });

    it('throws on invalid entry_price', () => {
      const position = { id: 1, side: 'long', size: 10, entry_price: 0 };

      expect(() => evaluateTrailing(position, 0.55, {}))
        .toThrow('Position has invalid entry_price');
    });

    it('throws on invalid side', () => {
      const position = { id: 1, side: 'invalid', size: 10, entry_price: 0.50 };

      expect(() => evaluateTrailing(position, 0.55, {}))
        .toThrow('Position has invalid side');
    });
  });

  describe('result fields', () => {
    it('includes trailing-specific fields in result', () => {
      const position = {
        id: 10,
        window_id: 'test',
        side: 'long',
        size: 10,
        entry_price: 0.50,
      };

      const result = evaluateTrailing(position, 0.60, {
        trailingActivationPct: 0.15,
        trailingPullbackPct: 0.10,
        minProfitFloorPct: 0.05,
        log: mockLog,
      });

      expect(result).toMatchObject({
        triggered: expect.any(Boolean),
        position_id: 10,
        trailing_active: expect.any(Boolean),
        high_water_mark: expect.any(Number),
      });
    });
  });
});
