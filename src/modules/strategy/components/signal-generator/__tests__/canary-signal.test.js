/**
 * Tests for Canary Signal Generator Component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { metadata, evaluate, validateConfig } from '../canary-signal.js';

describe('canary-signal component', () => {
  describe('metadata', () => {
    it('has correct type', () => {
      expect(metadata.type).toBe('signal-generator');
    });

    it('has correct name', () => {
      expect(metadata.name).toBe('canary-signal');
    });

    it('has version 1', () => {
      expect(metadata.version).toBe(1);
    });
  });

  describe('evaluate()', () => {
    const baseConfig = {
      entryWindowSeconds: 60,
      minPositionSize: 1,
      maxPositionSize: 1,
    };

    it('returns no_signal when no window', () => {
      const result = evaluate({ window: null }, baseConfig);
      expect(result.has_signal).toBe(false);
      expect(result.reason).toBe('no_window');
    });

    it('returns no_signal when no close timestamp', () => {
      const result = evaluate({ window: {} }, baseConfig);
      expect(result.has_signal).toBe(false);
      expect(result.reason).toBe('no_close_timestamp');
    });

    it('returns no_signal when too early', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 120, // 120s away
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(false);
      expect(result.reason).toBe('too_early');
    });

    it('returns no_signal when too late', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 3, // 3s away
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(false);
      expect(result.reason).toBe('too_late');
    });

    it('returns no_signal when no CLOB prices', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 30,
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(false);
      expect(result.reason).toBe('no_clob_prices');
    });

    it('signals YES when yes price > no price', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 30,
        clobPrices: { yes: 0.65, no: 0.35 },
        tokenIds: { yes: 'yes-token-123', no: 'no-token-456' },
        id: 'win-1',
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(true);
      expect(result.direction).toBe('yes');
      expect(result.token_id).toBe('yes-token-123');
      expect(result.price).toBe(0.65);
      expect(result.size).toBe(1);
      expect(result.shouldEnter).toBe(true);
      expect(result.stopLoss).toBeNull();
      expect(result.strategy).toBe('always-trade-canary');
    });

    it('signals NO when no price > yes price', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 30,
        clobPrices: { yes: 0.35, no: 0.65 },
        tokenIds: { yes: 'yes-token-123', no: 'no-token-456' },
        id: 'win-2',
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(true);
      expect(result.direction).toBe('no');
      expect(result.token_id).toBe('no-token-456');
      expect(result.price).toBe(0.65);
    });

    it('signals YES when prices are equal', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 30,
        clobPrices: { yes: 0.50, no: 0.50 },
        tokenIds: { yes: 'yes-token', no: 'no-token' },
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(true);
      expect(result.direction).toBe('yes');
    });

    it('handles alternative field names (clob_prices)', () => {
      const window = {
        close_timestamp: Date.now() / 1000 + 30,
        clob_prices: { yes: 0.70, no: 0.30 },
        token_ids: { yes: 'yt', no: 'nt' },
      };
      const result = evaluate({ window }, baseConfig);
      expect(result.has_signal).toBe(true);
      expect(result.direction).toBe('yes');
    });

    it('uses default config when none provided', () => {
      const window = {
        closeTimestamp: Date.now() / 1000 + 30,
        clobPrices: { yes: 0.60, no: 0.40 },
        tokenIds: { yes: 'yt', no: 'nt' },
      };
      const result = evaluate({ window }, {});
      expect(result.has_signal).toBe(true);
      expect(result.size).toBe(1);
    });
  });

  describe('validateConfig()', () => {
    it('accepts empty config', () => {
      expect(validateConfig({}).valid).toBe(true);
    });

    it('accepts valid config', () => {
      expect(validateConfig({
        entryWindowSeconds: 60,
        minPositionSize: 1,
        maxPositionSize: 5,
      }).valid).toBe(true);
    });

    it('rejects negative entryWindowSeconds', () => {
      const result = validateConfig({ entryWindowSeconds: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('entryWindowSeconds must be a positive number');
    });

    it('rejects negative minPositionSize', () => {
      const result = validateConfig({ minPositionSize: -1 });
      expect(result.valid).toBe(false);
    });

    it('rejects string entryWindowSeconds', () => {
      const result = validateConfig({ entryWindowSeconds: 'abc' });
      expect(result.valid).toBe(false);
    });
  });
});
