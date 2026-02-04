/**
 * Position Entry Safeguards Tests (V3 Stage 4: Atomic DB Safeguards)
 *
 * Tests for entry safeguard enforcement using DB-backed operations:
 * - Duplicate window prevention (per-strategy, via UNIQUE constraint)
 * - Rate limiting (via confirmed_at timestamps)
 * - Concurrent position cap
 * - Per-tick entry limit
 * - Reserve/Confirm flow for race conditions
 * - Position close removes entry
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

// In-memory store to simulate DB
let store = [];

vi.mock('../../../persistence/index.js', () => {
  return {
    default: {
      run: vi.fn(async (sql, params) => {
        if (sql.includes('INSERT INTO window_entries')) {
          const windowId = params[0];
          const strategyId = params[1];
          const existing = store.find(e => e.window_id === windowId && e.strategy_id === strategyId);
          if (sql.includes('ON CONFLICT') && sql.includes('DO NOTHING') && existing) {
            return { changes: 0 };
          }
          if (sql.includes('ON CONFLICT') && sql.includes('DO UPDATE') && existing) {
            existing.status = 'confirmed';
            existing.symbol = params[2];
            existing.confirmed_at = params[3];
            return { changes: 1 };
          }
          if (existing) {
            return { changes: 0 };
          }
          const status = sql.includes("'confirmed'") ? 'confirmed' : 'reserved';
          store.push({
            id: store.length + 1,
            window_id: windowId,
            strategy_id: strategyId,
            status,
            symbol: params[2] || null,
            reserved_at: new Date().toISOString(),
            confirmed_at: status === 'confirmed' ? (params[3] || new Date().toISOString()) : null,
          });
          return { changes: 1 };
        }
        if (sql.includes('UPDATE window_entries SET status')) {
          const windowId = params[2];
          const strategyId = params[3];
          const entry = store.find(e => e.window_id === windowId && e.strategy_id === strategyId && e.status === 'reserved');
          if (entry) {
            entry.status = 'confirmed';
            entry.symbol = params[0];
            entry.confirmed_at = params[1];
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        if (sql.includes('DELETE FROM window_entries WHERE window_id')) {
          const windowId = params[0];
          const strategyId = params[1];
          const idx = store.findIndex(e => {
            const matchesId = e.window_id === windowId && e.strategy_id === strategyId;
            if (sql.includes("status = 'reserved'")) return matchesId && e.status === 'reserved';
            return matchesId;
          });
          if (idx >= 0) { store.splice(idx, 1); return { changes: 1 }; }
          return { changes: 0 };
        }
        if (sql.includes('DELETE FROM window_entries WHERE status') && sql.includes('reserved_at')) {
          // Stale reservation cleanup - only remove truly stale entries
          const timeoutMs = params?.[0] || 30000;
          const cutoff = Date.now() - timeoutMs;
          const before = store.length;
          store = store.filter(e => {
            if (e.status !== 'reserved') return true;
            const reservedTime = new Date(e.reserved_at).getTime();
            return reservedTime >= cutoff;
          });
          return { changes: before - store.length };
        }
        if (sql.includes('DELETE FROM window_entries')) {
          const count = store.length;
          store = [];
          return { changes: count };
        }
        return { changes: 0 };
      }),
      get: vi.fn(async (sql, params) => {
        if (sql.includes('COUNT(*)')) {
          if (sql.includes("status = 'confirmed'")) {
            return { count: store.filter(e => e.status === 'confirmed').length };
          }
          if (sql.includes("status = 'reserved'")) {
            return { count: store.filter(e => e.status === 'reserved').length };
          }
          return { count: store.length };
        }
        if (sql.includes('SELECT id, status FROM window_entries') || sql.includes('SELECT id FROM window_entries')) {
          const windowId = params[0];
          const strategyId = params[1];
          return store.find(e => e.window_id === windowId && e.strategy_id === strategyId) || undefined;
        }
        if (sql.includes('SELECT confirmed_at FROM window_entries')) {
          const symbol = params[0];
          const matches = store.filter(e => e.symbol === symbol && e.status === 'confirmed' && e.confirmed_at);
          if (matches.length === 0) return undefined;
          matches.sort((a, b) => new Date(b.confirmed_at) - new Date(a.confirmed_at));
          return { confirmed_at: matches[0].confirmed_at };
        }
        return undefined;
      }),
      all: vi.fn(async () => []),
      exec: vi.fn(async () => {}),
    },
  };
});

// Import after mocks
import {
  init,
  canEnterPosition,
  recordEntry,
  reserveEntry,
  confirmEntry,
  releaseEntry,
  removeEntry,
  resetTickEntries,
  getState,
  shutdown,
  resetState,
  hasEnteredWindow,
  getTimeSinceLastEntry,
  getTickEntryCount,
} from '../safeguards.js';

describe('Position Entry Safeguards', () => {
  beforeEach(async () => {
    // Reset the in-memory store
    store = [];

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
    it('initializes with custom config', async () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 5,
          min_entry_interval_ms: 3000,
          max_entries_per_tick: 1,
          duplicate_window_prevention: false,
        },
      });

      const state = await getState();
      expect(state.initialized).toBe(true);
      expect(state.config.max_concurrent_positions).toBe(5);
      expect(state.config.min_entry_interval_ms).toBe(3000);
      expect(state.config.max_entries_per_tick).toBe(1);
      expect(state.config.duplicate_window_prevention).toBe(false);
    });

    it('uses default config when not provided', async () => {
      shutdown();
      init({});

      const state = await getState();
      expect(state.config.max_concurrent_positions).toBe(8);
      expect(state.config.min_entry_interval_ms).toBe(5000);
      expect(state.config.max_entries_per_tick).toBe(2);
      expect(state.config.duplicate_window_prevention).toBe(true);
    });

    it('does not reinitialize if already initialized', async () => {
      const state1 = await getState();
      init({ safeguards: { max_concurrent_positions: 99 } });
      const state2 = await getState();

      expect(state1.config.max_concurrent_positions).toBe(state2.config.max_concurrent_positions);
    });
  });

  describe('canEnterPosition() - Duplicate Window Check', () => {
    it('allows first entry to a window', async () => {
      const signal = { window_id: 'window-123', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('blocks re-entry to same window_id', async () => {
      const signal = { window_id: 'window-123', symbol: 'BTC' };

      // First entry
      await recordEntry('window-123', 'BTC');

      // Attempt re-entry
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });

    it('allows entry to different window_id after recording (different symbol)', async () => {
      await recordEntry('window-123', 'BTC');

      // Different window AND different symbol to avoid rate limiting
      const signal = { window_id: 'window-456', symbol: 'ETH' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('allows duplicate entry when duplicate_window_prevention is disabled', async () => {
      shutdown();
      init({
        safeguards: {
          duplicate_window_prevention: false,
          min_entry_interval_ms: 0, // Disable rate limiting for this test
        },
      });

      await recordEntry('window-123', 'BTC');

      const signal = { window_id: 'window-123', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('canEnterPosition() - Rate Limiting', () => {
    it('allows first entry for a symbol', async () => {
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('blocks rapid entry for same symbol within interval', async () => {
      shutdown();
      init({
        safeguards: {
          min_entry_interval_ms: 5000,
        },
      });

      // First entry
      await recordEntry('window-1', 'BTC');

      // Immediate second attempt (different window, same symbol)
      const signal = { window_id: 'window-2', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rate_limit_exceeded');
      expect(result.details.symbol).toBe('BTC');
      expect(result.details.min_interval_ms).toBe(5000);
    });

    it('allows entry for different symbol immediately', async () => {
      await recordEntry('window-1', 'BTC');

      const signal = { window_id: 'window-2', symbol: 'ETH' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('normalizes symbol to uppercase for comparison', async () => {
      await recordEntry('window-1', 'btc');

      const signal = { window_id: 'window-2', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

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

      await recordEntry('window-1', 'BTC');

      // Wait for interval to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      const signal = { window_id: 'window-2', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('canEnterPosition() - Concurrent Position Cap', () => {
    it('allows entry when under position limit', async () => {
      const openPositions = [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ];
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = await canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(true);
    });

    it('blocks entry at max concurrent positions', async () => {
      const openPositions = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = await canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_positions_reached');
      expect(result.details.current_positions).toBe(8);
      expect(result.details.max_positions).toBe(8);
    });

    it('blocks entry when over max concurrent positions', async () => {
      const openPositions = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = await canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_positions_reached');
    });

    it('allows entry with configurable position limit', async () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 3,
        },
      });

      const openPositions = [{ id: 1 }, { id: 2 }];
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = await canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(true);
    });

    it('blocks entry with configurable position limit', async () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 3,
        },
      });

      const openPositions = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const signal = { window_id: 'window-1', symbol: 'BTC' };

      const result = await canEnterPosition(signal, openPositions);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_concurrent_positions_reached');
    });
  });

  describe('canEnterPosition() - Per-Tick Limit', () => {
    it('allows entries up to per-tick limit', async () => {
      const signal1 = { window_id: 'window-1', symbol: 'BTC' };
      const signal2 = { window_id: 'window-2', symbol: 'ETH' };

      const result1 = await canEnterPosition(signal1, []);
      await recordEntry('window-1', 'BTC');

      // Need to reset rate limit for second symbol check
      shutdown();
      store = [];
      init({
        safeguards: {
          min_entry_interval_ms: 0, // Disable rate limiting for this test
          max_entries_per_tick: 2,
        },
      });
      await recordEntry('window-1', 'BTC'); // Re-record for tick count

      const result2 = await canEnterPosition(signal2, []);

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });

    it('blocks entry when per-tick limit reached', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          min_entry_interval_ms: 0, // Disable rate limiting
          max_entries_per_tick: 2,
        },
      });

      // Record 2 entries (at limit)
      await recordEntry('window-1', 'BTC');
      await recordEntry('window-2', 'ETH');

      const signal = { window_id: 'window-3', symbol: 'SOL' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_entries_per_tick_reached');
      expect(result.details.current_tick_entries).toBe(2);
      expect(result.details.max_per_tick).toBe(2);
    });

    it('resets per-tick counter with resetTickEntries()', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          min_entry_interval_ms: 0,
          max_entries_per_tick: 2,
        },
      });

      await recordEntry('window-1', 'BTC');
      await recordEntry('window-2', 'ETH');

      expect(getTickEntryCount()).toBe(2);

      resetTickEntries();

      expect(getTickEntryCount()).toBe(0);

      const signal = { window_id: 'window-3', symbol: 'SOL' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });
  });

  describe('canEnterPosition() - Edge Cases', () => {
    it('blocks entry when not initialized', async () => {
      shutdown();

      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('safeguards_not_initialized');
    });

    it('handles null signal gracefully', async () => {
      const result = await canEnterPosition(null, []);

      // Should still check other conditions but not crash
      expect(result).toHaveProperty('allowed');
    });

    it('handles undefined openPositions', async () => {
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = await canEnterPosition(signal, undefined);

      expect(result.allowed).toBe(true);
    });

    it('handles empty symbol', async () => {
      const signal = { window_id: 'window-1', symbol: '' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('checks all conditions and fails on first violation', async () => {
      // Record entry to create duplicate window
      await recordEntry('window-1', 'BTC');

      // Create max positions
      const openPositions = Array.from({ length: 8 }, (_, i) => ({ id: i + 1 }));

      // Signal would violate multiple conditions
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = await canEnterPosition(signal, openPositions);

      // Should fail on first check (duplicate window)
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });
  });

  describe('recordEntry()', () => {
    it('tracks window as entered', async () => {
      expect(await hasEnteredWindow('window-123')).toBe(false);

      await recordEntry('window-123', 'BTC');

      expect(await hasEnteredWindow('window-123')).toBe(true);
    });

    it('tracks entry time for symbol', async () => {
      expect(await getTimeSinceLastEntry('BTC')).toBe(null);

      await recordEntry('window-1', 'BTC');

      const timeSince = await getTimeSinceLastEntry('BTC');
      expect(timeSince).toBeGreaterThanOrEqual(0);
      expect(timeSince).toBeLessThan(1000); // Should be very recent
    });

    it('increments tick entry count', async () => {
      expect(getTickEntryCount()).toBe(0);

      await recordEntry('window-1', 'BTC');
      expect(getTickEntryCount()).toBe(1);

      await recordEntry('window-2', 'ETH');
      expect(getTickEntryCount()).toBe(2);
    });

    it('normalizes symbol to uppercase', async () => {
      await recordEntry('window-1', 'btc');

      expect(await getTimeSinceLastEntry('BTC')).not.toBe(null);
    });

    it('handles null/undefined window_id', async () => {
      await expect(recordEntry(null, 'BTC')).resolves.not.toThrow();
      await expect(recordEntry(undefined, 'BTC')).resolves.not.toThrow();
    });

    it('handles null/undefined symbol', async () => {
      await expect(recordEntry('window-1', null)).resolves.not.toThrow();
      await expect(recordEntry('window-1', undefined)).resolves.not.toThrow();
    });

    it('does nothing when not initialized', async () => {
      shutdown();

      await expect(recordEntry('window-1', 'BTC')).resolves.not.toThrow();
    });
  });

  describe('resetTickEntries()', () => {
    it('resets tick counter to zero', async () => {
      await recordEntry('window-1', 'BTC');
      await recordEntry('window-2', 'ETH');

      expect(getTickEntryCount()).toBe(2);

      resetTickEntries();

      expect(getTickEntryCount()).toBe(0);
    });

    it('does not affect window tracking', async () => {
      await recordEntry('window-1', 'BTC');
      resetTickEntries();

      expect(await hasEnteredWindow('window-1')).toBe(true);
    });

    it('does not affect rate limit tracking', async () => {
      await recordEntry('window-1', 'BTC');
      resetTickEntries();

      expect(await getTimeSinceLastEntry('BTC')).not.toBe(null);
    });
  });

  describe('resetState()', () => {
    it('clears all tracking state', async () => {
      await recordEntry('window-1', 'BTC');
      await recordEntry('window-2', 'ETH');

      expect(await hasEnteredWindow('window-1')).toBe(true);
      expect(await getTimeSinceLastEntry('BTC')).not.toBe(null);
      expect(getTickEntryCount()).toBe(2);

      await resetState();

      expect(await hasEnteredWindow('window-1')).toBe(false);
      expect(await getTimeSinceLastEntry('BTC')).toBe(null);
      expect(getTickEntryCount()).toBe(0);
    });

    it('preserves initialization and config', async () => {
      await resetState();

      const state = await getState();
      expect(state.initialized).toBe(true);
      expect(state.config.max_concurrent_positions).toBe(8);
    });
  });

  describe('getState()', () => {
    it('returns current state snapshot', async () => {
      await recordEntry('window-1', 'BTC');
      await recordEntry('window-2', 'ETH');

      const state = await getState();

      expect(state.initialized).toBe(true);
      expect(state.config).toBeDefined();
      expect(state.stats.entries_confirmed).toBe(2);
      expect(state.stats.tick_entry_count).toBe(2);
    });

    it('returns config values', async () => {
      shutdown();
      init({
        safeguards: {
          max_concurrent_positions: 5,
          min_entry_interval_ms: 3000,
        },
      });

      const state = await getState();

      expect(state.config.max_concurrent_positions).toBe(5);
      expect(state.config.min_entry_interval_ms).toBe(3000);
    });

    it('tracks reservations separately from confirmed entries', async () => {
      await reserveEntry('window-1', 'strategy-a');
      await confirmEntry('window-2', 'strategy-b');

      const state = await getState();
      expect(state.stats.entries_reserved).toBe(1);
      // confirmEntry on non-existent reservation won't produce a confirmed entry
      // since there's no reserved entry for window-2/strategy-b to confirm.
      // Instead, let's use recordEntry for the confirmed one:
    });

    it('tracks reservations and confirmed entries correctly', async () => {
      await reserveEntry('window-1', 'strategy-a');
      await recordEntry('window-2', 'BTC', 'strategy-b');

      const state = await getState();
      expect(state.stats.entries_reserved).toBe(1);
      expect(state.stats.entries_confirmed).toBe(1);
    });
  });

  describe('shutdown()', () => {
    it('clears all state', async () => {
      await recordEntry('window-1', 'BTC');
      await reserveEntry('window-2', 'strategy-a');

      shutdown();

      const state = await getState();
      expect(state.initialized).toBe(false);
      // After shutdown, getState returns 0 for counts since initialized is false
      expect(state.stats.entries_confirmed).toBe(0);
      expect(state.stats.entries_reserved).toBe(0);
    });

    it('can be reinitialized after shutdown', async () => {
      shutdown();
      init({ safeguards: { max_concurrent_positions: 10 } });

      const state = await getState();
      expect(state.initialized).toBe(true);
      expect(state.config.max_concurrent_positions).toBe(10);
    });
  });

  describe('Helper Functions', () => {
    describe('hasEnteredWindow()', () => {
      it('returns false for unknown window', async () => {
        expect(await hasEnteredWindow('unknown')).toBe(false);
      });

      it('returns true for recorded window', async () => {
        await recordEntry('window-1', 'BTC');
        expect(await hasEnteredWindow('window-1')).toBe(true);
      });
    });

    describe('getTimeSinceLastEntry()', () => {
      it('returns null for unknown symbol', async () => {
        expect(await getTimeSinceLastEntry('XRP')).toBe(null);
      });

      it('returns positive time for recorded symbol', async () => {
        await recordEntry('window-1', 'BTC');
        const time = await getTimeSinceLastEntry('BTC');
        expect(time).toBeGreaterThanOrEqual(0);
      });

      it('normalizes symbol to uppercase', async () => {
        await recordEntry('window-1', 'btc');
        expect(await getTimeSinceLastEntry('BTC')).not.toBe(null);
        expect(await getTimeSinceLastEntry('btc')).not.toBe(null);
      });
    });

    describe('getTickEntryCount()', () => {
      it('returns 0 initially', () => {
        shutdown();
        init({});
        expect(getTickEntryCount()).toBe(0);
      });

      it('increments with each entry', async () => {
        shutdown();
        store = [];
        init({ safeguards: { min_entry_interval_ms: 0 } });

        await recordEntry('w1', 'BTC');
        expect(getTickEntryCount()).toBe(1);

        await recordEntry('w2', 'ETH');
        expect(getTickEntryCount()).toBe(2);

        await recordEntry('w3', 'SOL');
        expect(getTickEntryCount()).toBe(3);
      });
    });
  });

  describe('Integration Scenarios', () => {
    it('handles complete tick cycle', async () => {
      shutdown();
      store = [];
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
      expect((await canEnterPosition(signal1, [])).allowed).toBe(true);
      await recordEntry('w1', 'BTC');

      // Second entry allowed
      const signal2 = { window_id: 'w2', symbol: 'ETH' };
      expect((await canEnterPosition(signal2, [{ id: 1 }])).allowed).toBe(true);
      await recordEntry('w2', 'ETH');

      // Third entry blocked (per-tick limit)
      const signal3 = { window_id: 'w3', symbol: 'SOL' };
      expect((await canEnterPosition(signal3, [{ id: 1 }, { id: 2 }])).allowed).toBe(false);

      // New tick starts
      resetTickEntries();

      // Entry allowed again
      const signal4 = { window_id: 'w4', symbol: 'XRP' };
      expect((await canEnterPosition(signal4, [{ id: 1 }, { id: 2 }])).allowed).toBe(true);
    });

    it('persists window tracking across tick cycles', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      // Tick 1
      await recordEntry('window-1', 'BTC');
      resetTickEntries();

      // Tick 2 - same window should be blocked
      const signal = { window_id: 'window-1', symbol: 'ETH' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });
  });

  // ==========================================
  // Strategy-Aware Tracking Tests
  // ==========================================

  describe('Strategy-Aware Duplicate Prevention', () => {
    it('same window_id, different strategy_id = allowed', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Strategy A enters window-1
      await recordEntry('window-1', 'BTC', 'oracle-edge');

      // Strategy B should be able to enter the same window
      const signal = { window_id: 'window-1', symbol: 'BTC', strategy_id: 'simple-threshold' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(true);
    });

    it('same window_id, same strategy_id = blocked', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Oracle-edge enters window-1
      await recordEntry('window-1', 'BTC', 'oracle-edge');

      // Oracle-edge tries to enter window-1 again
      const signal = { window_id: 'window-1', symbol: 'BTC', strategy_id: 'oracle-edge' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
      expect(result.details.strategy_id).toBe('oracle-edge');
    });

    it('uses default strategy_id when not provided (backward compatibility)', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Entry without strategy_id
      await recordEntry('window-1', 'BTC');

      // Try again without strategy_id - should be blocked
      const signal = { window_id: 'window-1', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
    });

    it('hasEnteredWindow is strategy-aware', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      await recordEntry('window-1', 'BTC', 'oracle-edge');

      // Same window, different strategy = not entered
      expect(await hasEnteredWindow('window-1', 'simple-threshold')).toBe(false);
      // Same window, same strategy = entered
      expect(await hasEnteredWindow('window-1', 'oracle-edge')).toBe(true);
      // Default strategy not entered
      expect(await hasEnteredWindow('window-1', 'default')).toBe(false);
    });
  });

  describe('Reserve/Confirm Flow', () => {
    it('reserveEntry blocks concurrent signals', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      // First signal reserves the slot
      const reserved1 = await reserveEntry('window-1', 'oracle-edge');
      expect(reserved1).toBe(true);

      // Second signal to same window/strategy is blocked
      const reserved2 = await reserveEntry('window-1', 'oracle-edge');
      expect(reserved2).toBe(false);

      // Different strategy can still reserve
      const reserved3 = await reserveEntry('window-1', 'simple-threshold');
      expect(reserved3).toBe(true);
    });

    it('canEnterPosition checks both reserved and confirmed entries', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Reserve but don't confirm
      await reserveEntry('window-1', 'oracle-edge');

      // canEnterPosition should still block
      const signal = { window_id: 'window-1', symbol: 'BTC', strategy_id: 'oracle-edge' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
      expect(result.details.is_reserved).toBe(true);
      expect(result.details.is_confirmed).toBe(false);
    });

    it('confirmEntry moves reservation to confirmed', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      await reserveEntry('window-1', 'oracle-edge');

      const state1 = await getState();
      expect(state1.stats.entries_reserved).toBe(1);
      expect(state1.stats.entries_confirmed).toBe(0);

      await confirmEntry('window-1', 'oracle-edge', 'BTC');

      const state2 = await getState();
      expect(state2.stats.entries_reserved).toBe(0);
      expect(state2.stats.entries_confirmed).toBe(1);
    });

    it('releaseEntry allows retry on failure', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Reserve the slot
      await reserveEntry('window-1', 'oracle-edge');

      // Simulate order failure - release the reservation
      const released = await releaseEntry('window-1', 'oracle-edge');
      expect(released).toBe(true);

      // Now canEnterPosition should allow entry
      const signal = { window_id: 'window-1', symbol: 'BTC', strategy_id: 'oracle-edge' };
      const result = await canEnterPosition(signal, []);
      expect(result.allowed).toBe(true);
    });

    it('confirmEntry increments tick count', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          max_entries_per_tick: 2,
        },
      });

      expect(getTickEntryCount()).toBe(0);
      await confirmEntry('window-1', 'oracle-edge');
      expect(getTickEntryCount()).toBe(1);
    });
  });

  describe('Position Close Removes Entry', () => {
    it('removeEntry allows future re-entry', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Entry made
      await recordEntry('window-1', 'BTC', 'oracle-edge');

      // Blocked
      expect((await canEnterPosition({ window_id: 'window-1', strategy_id: 'oracle-edge' }, [])).allowed).toBe(false);

      // Position closed - entry removed
      const removed = await removeEntry('window-1', 'oracle-edge');
      expect(removed).toBe(true);

      // Now allowed
      expect((await canEnterPosition({ window_id: 'window-1', strategy_id: 'oracle-edge' }, [])).allowed).toBe(true);
    });

    it('removeEntry returns false if entry not found', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      const removed = await removeEntry('nonexistent-window', 'oracle-edge');
      expect(removed).toBe(false);
    });

    it('removeEntry cleans up any reservations too', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
        },
      });

      await reserveEntry('window-1', 'oracle-edge');
      await removeEntry('window-1', 'oracle-edge');

      const state = await getState();
      expect(state.stats.entries_reserved).toBe(0);
    });
  });

  describe('PAPER Mode Parity', () => {
    it('tracking works identically for PAPER mode (using reserve/confirm flow)', async () => {
      shutdown();
      store = [];
      init({
        safeguards: {
          duplicate_window_prevention: true,
          min_entry_interval_ms: 0,
        },
      });

      // Simulate PAPER mode flow: reserve -> confirm (same as LIVE)
      const reserved = await reserveEntry('window-1', 'paper-strategy');
      expect(reserved).toBe(true);

      await confirmEntry('window-1', 'paper-strategy', 'BTC');

      // Duplicate blocked
      const signal = { window_id: 'window-1', strategy_id: 'paper-strategy', symbol: 'BTC' };
      const result = await canEnterPosition(signal, []);

      expect(result.allowed).toBe(false);
    });
  });
});
