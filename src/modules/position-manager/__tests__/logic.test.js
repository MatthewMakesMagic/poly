/**
 * Position Manager Logic Tests
 *
 * Tests the business logic for position management.
 * Uses vitest with mocked dependencies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { calculateUnrealizedPnl } from '../logic.js';

describe('Position Manager Logic', () => {
  describe('calculateUnrealizedPnl()', () => {
    it('returns 0 when current_price is null', () => {
      const position = {
        entry_price: 0.5,
        current_price: null,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBe(0);
    });

    it('returns 0 when current_price is undefined', () => {
      const position = {
        entry_price: 0.5,
        current_price: undefined,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBe(0);
    });

    it('calculates profit for long position with price increase', () => {
      // Long BTC at 0.45, current 0.50, size 100: (0.50 - 0.45) * 100 * 1 = +5 profit
      const position = {
        entry_price: 0.45,
        current_price: 0.50,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(5, 5);
    });

    it('calculates loss for long position with price decrease', () => {
      // Long SOL at 0.30, current 0.25, size 200: (0.25 - 0.30) * 200 * 1 = -10 loss
      const position = {
        entry_price: 0.30,
        current_price: 0.25,
        size: 200,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(-10, 5);
    });

    it('calculates profit for short position with price decrease', () => {
      // Short ETH at 0.60, current 0.55, size 50: (0.55 - 0.60) * 50 * -1 = +2.5 profit
      const position = {
        entry_price: 0.60,
        current_price: 0.55,
        size: 50,
        side: 'short',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(2.5, 5);
    });

    it('calculates loss for short position with price increase', () => {
      // Short at 0.40, current 0.50, size 100: (0.50 - 0.40) * 100 * -1 = -10 loss
      const position = {
        entry_price: 0.40,
        current_price: 0.50,
        size: 100,
        side: 'short',
      };

      expect(calculateUnrealizedPnl(position)).toBeCloseTo(-10, 5);
    });

    it('returns 0 when entry_price equals current_price', () => {
      const position = {
        entry_price: 0.5,
        current_price: 0.5,
        size: 100,
        side: 'long',
      };

      expect(calculateUnrealizedPnl(position)).toBe(0);
    });

    it('handles small price differences correctly', () => {
      const position = {
        entry_price: 0.501,
        current_price: 0.502,
        size: 1000,
        side: 'long',
      };

      // (0.502 - 0.501) * 1000 * 1 = 1
      expect(calculateUnrealizedPnl(position)).toBeCloseTo(1, 5);
    });

    it('handles large positions correctly', () => {
      const position = {
        entry_price: 0.50,
        current_price: 0.51,
        size: 10000,
        side: 'long',
      };

      // (0.51 - 0.50) * 10000 * 1 = 100
      expect(calculateUnrealizedPnl(position)).toBeCloseTo(100, 5);
    });

    it('handles edge case with zero entry price', () => {
      const position = {
        entry_price: 0,
        current_price: 0.5,
        size: 100,
        side: 'long',
      };

      // (0.5 - 0) * 100 * 1 = 50
      expect(calculateUnrealizedPnl(position)).toBe(50);
    });

    it('handles fractional size', () => {
      const position = {
        entry_price: 0.50,
        current_price: 0.60,
        size: 10.5,
        side: 'long',
      };

      // (0.60 - 0.50) * 10.5 * 1 = 1.05
      expect(calculateUnrealizedPnl(position)).toBeCloseTo(1.05, 5);
    });
  });
});
