/**
 * Position Entry Safeguards Tests (Story 8-7)
 *
 * Tests for entry safeguard enforcement:
 * - Duplicate window prevention
 * - Rate limiting
 * - Concurrent position cap
 * - Per-tick entry limit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger
vi.mock('../../logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Import after mocks
import {
  init,
  canEnterPosition,
  recordEntry,
  resetTickEntries,
  getState,
  shutdown,
  resetState,
  hasEnteredWindow,
  getTimeSinceLastEntry,
  getTickEntryCount,
} from '../safeguards.js';

describe('Position Entry Safeguards', () => {
  beforeEach(() => {
    // Initialize with default config before each test
    init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 5000,
        max_entries_per_tick: 2,
        duplicate_window_prevention: true,
      },
    });
  });

  afterEach(() => {
    shutdown();
  });

  describe('init()', () => {
    it('initializes with custom config', () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 5,
          min_entry_interval_ms: 3000,
          max_entries_per_tick: 1,
          duplicate_window_prevention: false,
        },
      });

      const state = getState();
      expect(state.initialized).toBe(true);
      expect(state.config.max_concurrent_positions).toBe(5);
      expect(state.config.min_entry_interval_ms).toBe(3000);
      expect(state.config.max_entries_per_tick).toBe(1);
      expect(state.config.duplicate_window_prevention).toBe(false);
    });

    it('uses default config when not provided', () => {
      shutdown();
      init({});

      const state = getState();
      expect(state.config.max_concurrent_positions).toBe(8);
      expect(state.config.min_entry_interval_ms).toBe(5000);
      expect(state.config.max_entries_per_tick).toBe(2);
      expect(state.config.duplicate_window_prevention).toBe(true);
    });

    it('does not reinitialize if already initialized', () => {
      const state1 = getState();
      init({ safeguards: { max_concurrent_positions: 99 } });
      const state2 = getState();

      expect(state1.config.max_concurrent_positions).toBe(state2.config.max_concurrent_positions);
    });
  });

  describe('canEnterPosition() - Duplicate Window Check', () => {
    it('allows first entry to a window', () => {
      const signal = { window_id: 'window-123', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('blocks re-entry to same window_id', () => {
      const signal = { window_id: 'window-123', symbol: 'BTC' };

      // First entry
      recordEntry('window-123', 'BTC');

      // Attempt re-entry
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });

    it('allows entry to different window_id after recording (different symbol)', () => {
      recordEntry('window-123', 'BTC');

      // Different window AND different symbol to avoid rate limiting
      const signal = { window_id: 'window-456', symbol: 'ETH' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('allows duplicate entry when duplicate_window_prevention is disabled', () => {
      shutdown();
      init({
        safeguards: {
          duplicate_window_prevention: false,
          min_entry_interval_ms: 0, // Disable rate limiting for this test
        },
      });

      recordEntry('window-123', 'BTC');

      const signal = { window_id: 'window-123', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('canEnterPosition() - Rate Limiting', () => {
    it('allows first entry for a symbol', () => {
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('blocks rapid entry for same symbol within interval', () => {
      shutdown();
      init({
        safeguards: {
          min_entry_interval_ms: 5000,
        },
      });

      // First entry
      recordEntry('window-1', 'BTC');

      // Immediate second attempt (different window, same symbol)
      const signal = { window_id: 'window-2', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rate_limit_exceeded');
      expect(result.details.symbol).toBe('BTC');
      expect(result.details.min_interval_ms).toBe(5000);
    });

    it('allows entry for different symbol immediately', () => {
      recordEntry('window-1', 'BTC');

      const signal = { window_id: 'window-2', symbol: 'ETH' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('normalizes symbol to uppercase for comparison', () => {
      recordEntry('window-1', 'btc');

      const signal = { window_id: 'window-2', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rate_limit_exceeded');
    });

    it('allows entry after rate limit interval expires', async () => {
      shutdown();
      init({
        safeguards: {
          min_entry_interval_ms: 50, // Short interval for testing
        },
      });

      recordEntry('window-1', 'BTC');

      // Wait for interval to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      const signal = { window_id: 'window-2', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('canEnterPosition() - Concurrent Position Cap', () => {
    it('allows entry when under position limit', () => {
      const openPositions = [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ];
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(true);
    });

    it('blocks entry at max concurrent positions', () => {
      const openPositions = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_positions_reached');
      expect(result.details.current_positions).toBe(8);
      expect(result.details.max_positions).toBe(8);
    });

    it('blocks entry when over max concurrent positions', () => {
      const openPositions = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_positions_reached');
    });

    it('allows entry with configurable position limit', () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 3,
        },
      });

      const openPositions = [{ id: 1 }, { id: 2 }];
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(true);
    });

    it('blocks entry with configurable position limit', () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 3,
        },
      });

      const openPositions = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_positions_reached');
    });
  });

  describe('canEnterPosition() - Per-Tick Limit', () => {
    it('allows entries up to per-tick limit', () => {
      const signal1 = { window_id: 'window-1', symbol: 'BTC' };
      const signal2 = { window_id: 'window-2', symbol: 'ETH' };

      const result1 = canEnterPosition(signal1, []);
      recordEntry('window-1', 'BTC');

      // Need to reset rate limit for second symbol check
      shutdown();
      init({
        safeguards: {
          min_entry_interval_ms: 0, // Disable rate limiting for this test
          max_entries_per_tick: 2,
        },
      });
      recordEntry('window-1', 'BTC'); // Re-record for tick count

      const result2 = canEnterPosition(signal2, []);

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it('blocks entry when per-tick limit reached', () => {
      shutdown();
      init({
        safeguards: {
          min_entry_interval_ms: 0, // Disable rate limiting
          max_entries_per_tick: 2,
        },
      });

      // Record 2 entries (at limit)
      recordEntry('window-1', 'BTC');
      recordEntry('window-2', 'ETH');

      const signal = { window_id: 'window-3', symbol: 'SOL' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_entries_per_tick_reached');
      expect(result.details.current_tick_entries).toBe(2);
      expect(result.details.max_per_tick).toBe(2);
    });

    it('resets per-tick counter with resetTickEntries()', () => {
      shutdown();
      init({
        safeguards: {
          min_entry_interval_ms: 0,
          max_entries_per_tick: 2,
        },
      });

      recordEntry('window-1', 'BTC');
      recordEntry('window-2', 'ETH');

      expect(getTickEntryCount()).toBe(2);

      resetTickEntries();

      expect(getTickEntryCount()).toBe(0);

      const signal = { window_id: 'window-3', symbol: 'SOL' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('canEnterPosition() - Edge Cases', () => {
    it('blocks entry when not initialized', () => {
      shutdown();

      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('safeguards_not_initialized');
    });

    it('handles null signal gracefully', () => {
      const result = canEnterPosition(null, []);

      // Should still check other conditions but not crash
      expect(result).toHaveProperty('allowed');
    });

    it('handles undefined openPositions', () => {
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = canEnterPosition(signal, undefined);

      expect(result.allowed).toBe(true);
    });

    it('handles empty symbol', () => {
      const signal = { window_id: 'window-1', symbol: '' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('checks all conditions and fails on first violation', () => {
      // Record entry to create duplicate window
      recordEntry('window-1', 'BTC');

      // Create max positions
      const openPositions = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));

      // Signal would violate multiple conditions
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = canEnterPosition(signal, openPositions);

      // Should fail on first check (duplicate window)
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });
  });

  describe('recordEntry()', () => {
    it('tracks window as entered', () => {
      expect(hasEnteredWindow('window-123')).toBe(false);

      recordEntry('window-123', 'BTC');

      expect(hasEnteredWindow('window-123')).toBe(true);
    });

    it('tracks entry time for symbol', () => {
      expect(getTimeSinceLastEntry('BTC')).toBe(null);

      recordEntry('window-1', 'BTC');

      const timeSince = getTimeSinceLastEntry('BTC');
      expect(timeSince).toBeGreaterThanOrEqual(0);
      expect(timeSince).toBeLessThan(100); // Should be very recent
    });

    it('increments tick entry count', () => {
      expect(getTickEntryCount()).toBe(0);

      recordEntry('window-1', 'BTC');
      expect(getTickEntryCount()).toBe(1);

      recordEntry('window-2', 'ETH');
      expect(getTickEntryCount()).toBe(2);
    });

    it('normalizes symbol to uppercase', () => {
      recordEntry('window-1', 'btc');

      expect(getTimeSinceLastEntry('BTC')).not.toBe(null);
    });

    it('handles null/undefined window_id', () => {
      expect(() => recordEntry(null, 'BTC')).not.toThrow();
      expect(() => recordEntry(undefined, 'BTC')).not.toThrow();
    });

    it('handles null/undefined symbol', () => {
      expect(() => recordEntry('window-1', null)).not.toThrow();
      expect(() => recordEntry('window-1', undefined)).not.toThrow();
    });

    it('does nothing when not initialized', () => {
      shutdown();

      expect(() => recordEntry('window-1', 'BTC')).not.toThrow();
    });
  });

  describe('resetTickEntries()', () => {
    it('resets tick counter to zero', () => {
      recordEntry('window-1', 'BTC');
      recordEntry('window-2', 'ETH');

      expect(getTickEntryCount()).toBe(2);

      resetTickEntries();

      expect(getTickEntryCount()).toBe(0);
    });

    it('does not affect window tracking', () => {
      recordEntry('window-1', 'BTC');
      resetTickEntries();

      expect(hasEnteredWindow('window-1')).toBe(true);
    });

    it('does not affect rate limit tracking', () => {
      recordEntry('window-1', 'BTC');
      resetTickEntries();

      expect(getTimeSinceLastEntry('BTC')).not.toBe(null);
    });
  });

  describe('resetState()', () => {
    it('clears all tracking state', () => {
      recordEntry('window-1', 'BTC');
      recordEntry('window-2', 'ETH');

      expect(hasEnteredWindow('window-1')).toBe(true);
      expect(getTimeSinceLastEntry('BTC')).not.toBe(null);
      expect(getTickEntryCount()).toBe(2);

      resetState();

      expect(hasEnteredWindow('window-1')).toBe(false);
      expect(getTimeSinceLastEntry('BTC')).toBe(null);
      expect(getTickEntryCount()).toBe(0);
    });

    it('preserves initialization and config', () => {
      resetState();

      const state = getState();
      expect(state.initialized).toBe(true);
      expect(state.config.max_concurrent_positions).toBe(8);
    });
  });

  describe('getState()', () => {
    it('returns current state snapshot', () => {
      recordEntry('window-1', 'BTC');
      recordEntry('window-2', 'ETH');

      const state = getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.stats.windows_entered).toBe(2);
      expect(state.stats.tick_entry_count).toBe(2);
      expect(state.stats.symbols_tracked).toBe(2);
    });

    it('returns config values', () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 5,
          min_entry_interval_ms: 3000,
        },
      });

      const state = getState();

      expect(state.config.max_concurrent_positions).toBe(5);
      expect(state.config.min_entry_interval_ms).toBe(3000);
    });
  });

  describe('shutdown()', () => {
    it('clears all state', () => {
      recordEntry('window-1', 'BTC');

      shutdown();

      const state = getState();
      expect(state.initialized).toBe(false);
      expect(state.stats.windows_entered).toBe(0);
    });

    it('can be reinitialized after shutdown', () => {
      shutdown();
      init({ safeguards: { max_concurrent_positions: 10 } });

      const state = getState();
      expect(state.initialized).toBe(true);
      expect(state.config.max_concurrent_positions).toBe(10);
    });
  });

  describe('Helper Functions', () => {
    describe('hasEnteredWindow()', () => {
      it('returns false for unknown window', () => {
        expect(hasEnteredWindow('unknown')).toBe(false);
      });

      it('returns true for recorded window', () => {
        recordEntry('window-1', 'BTC');
        expect(hasEnteredWindow('window-1')).toBe(true);
      });
    });

    describe('getTimeSinceLastEntry()', () => {
      it('returns null for unknown symbol', () => {
        expect(getTimeSinceLastEntry('XRP')).toBe(null);
      });

      it('returns positive time for recorded symbol', () => {
        recordEntry('window-1', 'BTC');
        const time = getTimeSinceLastEntry('BTC');
        expect(time).toBeGreaterThanOrEqual(0);
      });

      it('normalizes symbol to uppercase', () => {
        recordEntry('window-1', 'btc');
        expect(getTimeSinceLastEntry('BTC')).not.toBe(null);
        expect(getTimeSinceLastEntry('btc')).not.toBe(null);
      });
    });

    describe('getTickEntryCount()', () => {
      it('returns 0 initially', () => {
        shutdown();
        init({});
        expect(getTickEntryCount()).toBe(0);
      });

      it('increments with each entry', () => {
        shutdown();
        init({ safeguards: { min_entry_interval_ms: 0 } });

        recordEntry('w1', 'BTC');
        expect(getTickEntryCount()).toBe(1);

        recordEntry('w2', 'ETH');
        expect(getTickEntryCount()).toBe(2);

        recordEntry('w3', 'SOL');
        expect(getTickEntryCount()).toBe(3);
      });
    });
  });

  describe('Integration Scenarios', () => {
    it('handles complete tick cycle', () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 8,
          min_entry_interval_ms: 0, // Disable for this test
          max_entries_per_tick: 2,
          duplicate_window_prevention: true,
        },
      });

      // Start of tick
      resetTickEntries();

      // First entry allowed
      const signal1 = { window_id: 'w1', symbol: 'BTC' };
      expect(canEnterPosition(signal1, []).allowed).toBe(true);
      recordEntry('w1', 'BTC');

      // Second entry allowed
      const signal2 = { window_id: 'w2', symbol: 'ETH' };
      expect(canEnterPosition(signal2, [{ id: 1 }]).allowed).toBe(true);
      recordEntry('w2', 'ETH');

      // Third entry blocked (per-tick limit)
      const signal3 = { window_id: 'w3', symbol: 'SOL' };
      expect(canEnterPosition(signal3, [{ id: 1 }, { id: 2 }]).allowed).toBe(false);

      // New tick starts
      resetTickEntries();

      // Entry allowed again
      const signal4 = { window_id: 'w4', symbol: 'XRP' };
      expect(canEnterPosition(signal4, [{ id: 1 }, { id: 2 }]).allowed).toBe(true);
    });

    it('persists window tracking across tick cycles', () => {
      shutdown();
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      // Tick 1
      recordEntry('window-1', 'BTC');
      resetTickEntries();

      // Tick 2 - same window should be blocked
      const signal = { window_id: 'window-1', symbol: 'ETH' };
      const result = canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });
  });
});
