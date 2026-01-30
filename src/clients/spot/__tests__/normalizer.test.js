/**
 * Tests for price normalization utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizePrice, isValidPrice, roundPrice } from '../normalizer.js';

describe('normalizer', () => {
  describe('normalizePrice', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-30T12:00:00.000Z'));
    });

    describe('Pyth source', () => {
      it('should normalize Pyth price with exponent', () => {
        const publishTime = Math.floor(Date.now() / 1000); // Current time in seconds
        const raw = {
          price: '10500000000000', // 105000 with expo -8
          expo: -8,
          publish_time: publishTime,
        };

        const result = normalizePrice(raw, 'pyth');

        expect(result.price).toBe(105000);
        expect(result.timestamp.getTime()).toBe(publishTime * 1000);
        expect(result.source).toBe('pyth');
        expect(result.staleness).toBe(0);
        expect(result.raw).toBe(raw);
      });

      it('should normalize already processed Pyth price', () => {
        const now = Date.now();
        const raw = {
          price: 105000,
          timestamp: now - 5000, // 5 seconds ago
        };

        const result = normalizePrice(raw, 'pyth');

        expect(result.price).toBe(105000);
        expect(result.staleness).toBe(5);
        expect(result.source).toBe('pyth');
      });

      it('should handle missing publish_time by using current time', () => {
        const raw = {
          price: '10500000000000', // 105000 with expo -8
          expo: -8,
        };

        const result = normalizePrice(raw, 'pyth');

        expect(result.price).toBe(105000);
        expect(result.staleness).toBe(0);
      });
    });

    describe('Chainlink source', () => {
      it('should normalize Chainlink price with decimals', () => {
        const updatedAt = Math.floor(Date.now() / 1000); // Current time in seconds
        const raw = {
          answer: 10500000000000, // Using number instead of BigInt for compatibility
          decimals: 8,
          updatedAt,
        };

        const result = normalizePrice(raw, 'chainlink');

        expect(result.price).toBe(105000);
        expect(result.timestamp.getTime()).toBe(updatedAt * 1000);
        expect(result.source).toBe('chainlink');
        expect(result.staleness).toBe(0);
      });

      it('should handle already processed Chainlink price', () => {
        const raw = {
          price: 105000,
          timestamp: Date.now(),
        };

        const result = normalizePrice(raw, 'chainlink');

        expect(result.price).toBe(105000);
        expect(result.staleness).toBe(0);
      });
    });

    describe('Generic source', () => {
      it('should normalize numeric price', () => {
        const raw = {
          price: 105000,
          timestamp: Date.now(),
        };

        const result = normalizePrice(raw, 'binance');

        expect(result.price).toBe(105000);
        expect(result.source).toBe('binance');
        expect(result.staleness).toBe(0);
      });

      it('should normalize string price', () => {
        const raw = {
          price: '105000.50',
          timestamp: Date.now(),
        };

        const result = normalizePrice(raw, 'coinbase');

        expect(result.price).toBe(105000.50);
      });

      it('should convert Unix seconds to milliseconds', () => {
        // Use a timestamp that's clearly in seconds (less than 1e12)
        const raw = {
          price: 105000,
          timestamp: 1738238400, // Unix seconds: 2026-01-30T12:00:00Z
        };

        const result = normalizePrice(raw, 'kraken');

        // The timestamp gets converted to ms
        expect(result.timestamp.getTime()).toBe(1738238400000);
      });

      it('should handle alternate timestamp field names', () => {
        const raw = {
          price: 105000,
          updatedAt: Date.now(),
        };

        const result = normalizePrice(raw, 'okx');

        expect(result.staleness).toBe(0);
      });

      it('should handle time field', () => {
        const raw = {
          price: 105000,
          time: Date.now(),
        };

        const result = normalizePrice(raw, 'coincap');

        expect(result.staleness).toBe(0);
      });
    });
  });

  describe('isValidPrice', () => {
    it('should return true for valid BTC price', () => {
      expect(isValidPrice(50000, 'btc')).toBe(true);
      expect(isValidPrice(100000, 'btc')).toBe(true);
    });

    it('should return true for valid ETH price', () => {
      expect(isValidPrice(3000, 'eth')).toBe(true);
      expect(isValidPrice(10000, 'eth')).toBe(true);
    });

    it('should return true for valid SOL price', () => {
      expect(isValidPrice(100, 'sol')).toBe(true);
      expect(isValidPrice(500, 'sol')).toBe(true);
    });

    it('should return true for valid XRP price', () => {
      expect(isValidPrice(0.5, 'xrp')).toBe(true);
      expect(isValidPrice(2.5, 'xrp')).toBe(true);
    });

    it('should return false for negative prices', () => {
      expect(isValidPrice(-100, 'btc')).toBe(false);
    });

    it('should return false for zero prices', () => {
      expect(isValidPrice(0, 'btc')).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isValidPrice(NaN, 'btc')).toBe(false);
    });

    it('should return false for Infinity', () => {
      expect(isValidPrice(Infinity, 'btc')).toBe(false);
    });

    it('should return false for non-number', () => {
      expect(isValidPrice('50000', 'btc')).toBe(false);
      expect(isValidPrice(null, 'btc')).toBe(false);
      expect(isValidPrice(undefined, 'btc')).toBe(false);
    });

    it('should return false for prices outside bounds', () => {
      // BTC too low
      expect(isValidPrice(500, 'btc')).toBe(false);
      // BTC too high
      expect(isValidPrice(2000000, 'btc')).toBe(false);
      // ETH too low
      expect(isValidPrice(50, 'eth')).toBe(false);
    });

    it('should return true for unknown crypto with positive price', () => {
      expect(isValidPrice(100, 'unknown')).toBe(true);
    });
  });

  describe('roundPrice', () => {
    it('should round to 2 decimal places by default', () => {
      expect(roundPrice(100.456)).toBe(100.46);
      expect(roundPrice(100.454)).toBe(100.45);
    });

    it('should round to specified decimal places', () => {
      expect(roundPrice(100.4567, 3)).toBe(100.457);
      expect(roundPrice(100.4564, 3)).toBe(100.456);
    });

    it('should handle 0 decimal places', () => {
      expect(roundPrice(100.6, 0)).toBe(101);
      expect(roundPrice(100.4, 0)).toBe(100);
    });

    it('should handle whole numbers', () => {
      expect(roundPrice(100, 2)).toBe(100);
    });
  });
});
