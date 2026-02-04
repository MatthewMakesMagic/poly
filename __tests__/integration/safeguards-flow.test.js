/**
 * Safeguards Flow Integration Tests (Story 8-9)
 *
 * Tests for the one-trade-per-strategy-per-window safeguard:
 * - Full flow from signal to confirmed entry
 * - Concurrent signals blocked correctly
 * - Multiple strategies can enter same window
 * - System restart with open positions loads entries correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger for safeguards module
vi.mock('../../src/modules/logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// V3 Stage 4: Mock persistence for DB-backed safeguards
// Simulates window_entries table in-memory for test isolation
const windowEntries = new Map(); // key: `${windowId}::${strategyId}` -> { id, window_id, strategy_id, status, symbol, confirmed_at, reserved_at }
let nextEntryId = 1;

vi.mock('../../src/persistence/index.js', () => ({
  default: {
    run: vi.fn(async (sql, params) => {
      // DELETE stale reservations
      if (sql.includes('DELETE FROM window_entries') && sql.includes('reserved')) {
        if (sql.includes('reserved_at')) {
          // Cleanup stale reservations - no-op in tests (no stale reservations)
          return { changes: 0 };
        }
        // Delete by window_id + strategy_id with status='reserved'
        const key = `${params[0]}::${params[1]}`;
        const entry = windowEntries.get(key);
        if (entry && entry.status === 'reserved') {
          windowEntries.delete(key);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      // DELETE by window_id + strategy_id (removeEntry)
      if (sql.includes('DELETE FROM window_entries') && !sql.includes('reserved')) {
        const key = `${params[0]}::${params[1]}`;
        if (windowEntries.has(key)) {
          windowEntries.delete(key);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      // DELETE all (resetState)
      if (sql === 'DELETE FROM window_entries') {
        windowEntries.clear();
        return { changes: 0 };
      }
      // INSERT (reserveEntry or recordEntry)
      if (sql.includes('INSERT INTO window_entries')) {
        const windowId = params[0];
        const strategyId = params[1];
        const key = `${windowId}::${strategyId}`;
        if (windowEntries.has(key)) {
          // ON CONFLICT handling
          if (sql.includes('DO NOTHING')) {
            return { changes: 0 };
          }
          // DO UPDATE (recordEntry - upsert to confirmed)
          const entry = windowEntries.get(key);
          entry.status = 'confirmed';
          entry.symbol = params[2] || entry.symbol;
          entry.confirmed_at = params[3] || new Date().toISOString();
          return { changes: 1 };
        }
        const entry = {
          id: nextEntryId++,
          window_id: windowId,
          strategy_id: strategyId,
          status: sql.includes("'reserved'") ? 'reserved' : 'confirmed',
          symbol: params[2] || null,
          confirmed_at: sql.includes("'confirmed'") ? (params[3] || new Date().toISOString()) : null,
          reserved_at: new Date().toISOString(),
        };
        windowEntries.set(key, entry);
        return { changes: 1 };
      }
      // UPDATE (confirmEntry)
      if (sql.includes('UPDATE window_entries')) {
        const windowId = params[2];
        const strategyId = params[3];
        const key = `${windowId}::${strategyId}`;
        const entry = windowEntries.get(key);
        if (entry && entry.status === 'reserved') {
          entry.status = 'confirmed';
          entry.symbol = params[0] || entry.symbol;
          entry.confirmed_at = params[1] || new Date().toISOString();
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      return { changes: 0 };
    }),
    get: vi.fn(async (sql, params) => {
      // Check entry existence
      if (sql.includes('SELECT') && sql.includes('window_entries') && sql.includes('window_id')) {
        if (sql.includes('COUNT')) {
          let count = 0;
          for (const entry of windowEntries.values()) {
            if (sql.includes('confirmed') && entry.status === 'confirmed') count++;
            else if (sql.includes('reserved') && entry.status === 'reserved') count++;
          }
          return { count };
        }
        // Lookup by window_id + strategy_id
        if (params && params.length >= 2) {
          const key = `${params[0]}::${params[1]}`;
          return windowEntries.get(key) || null;
        }
        return null;
      }
      // Rate limiting query - confirmed_at lookup by symbol
      if (sql.includes('confirmed_at') && sql.includes('ORDER BY')) {
        return null; // No rate limiting in tests
      }
      return null;
    }),
    all: vi.fn().mockResolvedValue([]),
  },
}));

import { ExecutionLoop } from '../../src/modules/orchestrator/execution-loop.js';
import * as safeguards from '../../src/modules/position-manager/safeguards.js';

// Mock logger for execution loop
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Create mock modules for integration testing
const createMockModules = (safeguardsModule, overrides = {}) => ({
  spot: {
    getCurrentPrice: vi.fn().mockReturnValue({ price: 50000, timestamp: Date.now() }),
  },
  // Story 7-20: Must return windows with crypto field for spot price fetching
  'window-manager': {
    getActiveWindows: vi.fn().mockResolvedValue([
      { id: 'btc-15m-window-1', crypto: 'btc', market_id: 'market-123', token_id: 'token-123' },
    ]),
  },
  'strategy-evaluator': {
    evaluateEntryConditions: vi.fn().mockReturnValue([]),
  },
  'position-sizer': {
    calculateSize: vi.fn().mockResolvedValue({
      success: true,
      window_id: 'test-window',
      requested_size: 10,
      actual_size: 10,
      adjustment_reason: 'none',
    }),
  },
  'order-manager': {
    placeOrder: vi.fn().mockResolvedValue({
      orderId: 'test-order-123',
      status: 'filled',
      latencyMs: 50,
      timestamps: {
        orderSubmittedAt: new Date().toISOString(),
        orderFilledAt: new Date().toISOString(),
      },
      fillPrice: 0.55,
      filledSize: 10,
    }),
  },
  'position-manager': {
    getPositions: vi.fn().mockReturnValue([]),
    getCurrentExposure: vi.fn().mockReturnValue(0),
    openPosition: vi.fn().mockReturnValue({ id: 'pos-123' }),
  },
  safeguards: safeguardsModule,
  safety: {
    checkDrawdownLimit: vi.fn().mockReturnValue({
      breached: false,
      current: 0,
      limit: 0.05,
      autoStopped: false,
    }),
  },
  ...overrides,
});

// Create mock signals for testing
const createSignal = (windowId, strategyId, symbol = 'BTC') => ({
  window_id: windowId,
  token_id: 'token-123',
  market_id: 'market-123',
  direction: 'long',
  confidence: 0.85,
  price: 0.55,
  market_price: 0.55,
  expected_price: 0.55,
  symbol,
  strategy_id: strategyId,
});

describe('Safeguards Flow Integration Tests (Story 8-9)', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();

    // Reset in-memory DB state
    windowEntries.clear();
    nextEntryId = 1;

    // Initialize real safeguards module
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0, // Disable for testing
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) {
      loop.stop();
    }
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('AC 8.1: Full flow from signal to confirmed entry', () => {
    it('processes signal through reserve -> order -> confirm flow in LIVE mode', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'LIVE',
      };

      mockModules = createMockModules(safeguards);
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createSignal('btc-15m-window-1', 'oracle-edge'),
      ]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Verify order was placed
      expect(mockModules['order-manager'].placeOrder).toHaveBeenCalled();

      // Verify entry is now confirmed
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(true);

      // Second attempt to same window/strategy should be blocked
      const result = await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('duplicate_window_entry');
    });

    it('processes signal through reserve -> confirm flow in PAPER mode', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules(safeguards);
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createSignal('btc-15m-window-1', 'paper-strategy'),
      ]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Verify no order was placed
      expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();

      // Verify entry is confirmed (prevents duplicate paper signals)
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'paper-strategy')).toBe(true);
    });
  });

  describe('AC 8.2: Concurrent signals to same window blocked correctly', () => {
    it('blocks second signal to same window/strategy while first is processing', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'LIVE',
      };

      mockModules = createMockModules(safeguards);

      // Return two identical signals in one tick (simulating concurrent arrival)
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createSignal('btc-15m-window-1', 'oracle-edge'),
        createSignal('btc-15m-window-1', 'oracle-edge'), // Duplicate
      ]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Only ONE order should be placed
      expect(mockModules['order-manager'].placeOrder).toHaveBeenCalledTimes(1);

      // Entry should be confirmed
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(true);
    });
  });

  describe('AC 8.3: Multiple strategies can enter same window simultaneously', () => {
    it('allows different strategies to enter the same window', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'LIVE',
      };

      mockModules = createMockModules(safeguards);

      // Two different strategies for the same window
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createSignal('btc-15m-window-1', 'oracle-edge'),
        createSignal('btc-15m-window-1', 'simple-threshold'),
      ]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // BOTH orders should be placed
      expect(mockModules['order-manager'].placeOrder).toHaveBeenCalledTimes(2);

      // Both entries should be confirmed
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(true);
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'simple-threshold')).toBe(true);

      // But same strategy should now be blocked
      const result = await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []);
      expect(result.allowed).toBe(false);
    });
  });

  describe('AC 8.4: System restart with open positions loads entries from DB', () => {
    it('blocks re-entry when window_entries exist in DB (simulating restart)', async () => {
      // V3 Stage 4: initializeFromPositions was removed.
      // On restart, the DB already has window_entries from previous run.
      // Simulate this by using recordEntry (which upserts as confirmed directly).
      await safeguards.recordEntry('btc-15m-window-1', 'BTC', 'oracle-edge');
      await safeguards.recordEntry('eth-15m-window-2', 'ETH', 'simple-threshold');
      await safeguards.recordEntry('btc-15m-window-3', 'BTC', 'default');

      // All positions should block re-entry
      expect((await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, [])).allowed).toBe(false);

      expect((await safeguards.canEnterPosition({
        window_id: 'eth-15m-window-2',
        strategy_id: 'simple-threshold',
        symbol: 'ETH',
      }, [])).allowed).toBe(false);

      expect((await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-3',
        strategy_id: 'default',
        symbol: 'BTC',
      }, [])).allowed).toBe(false);

      // But different strategies for same windows should be allowed
      expect((await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'simple-threshold',
        symbol: 'BTC',
      }, [])).allowed).toBe(true);
    });
  });

  describe('Order failure releases entry for retry', () => {
    it('releases reservation when order placement fails', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'LIVE',
      };

      mockModules = createMockModules(safeguards);

      // First order fails
      mockModules['order-manager'].placeOrder.mockRejectedValueOnce(new Error('Network error'));

      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createSignal('btc-15m-window-1', 'oracle-edge'),
      ]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Entry should NOT be confirmed (failure released it)
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(false);

      // Should allow retry
      const result = await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []);
      expect(result.allowed).toBe(true);
    });

    it('releases reservation when order is rejected', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'LIVE',
      };

      mockModules = createMockModules(safeguards);

      // Order rejected by exchange
      mockModules['order-manager'].placeOrder.mockResolvedValueOnce({
        orderId: 'test-order-rejected',
        status: 'rejected',
        latencyMs: 50,
      });

      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createSignal('btc-15m-window-1', 'oracle-edge'),
      ]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Entry should NOT be confirmed (rejection released it)
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(false);

      // Verify release was logged
      const releaseLogs = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'entry_released_order_rejected'
      );
      expect(releaseLogs.length).toBe(1);
    });
  });

  describe('Position close removes entry', () => {
    it('allows re-entry after position is closed', async () => {
      // Enter a position (use recordEntry which upserts as confirmed directly)
      await safeguards.recordEntry('btc-15m-window-1', 'BTC', 'oracle-edge');

      // Should be blocked
      expect((await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, [])).allowed).toBe(false);

      // Simulate position close
      await safeguards.removeEntry('btc-15m-window-1', 'oracle-edge');

      // Should be allowed now
      expect((await safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, [])).allowed).toBe(true);
    });
  });

  describe('Strategy ID handling', () => {
    it('uses default strategy ID when not provided in signal', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules(safeguards);

      // Signal without strategy_id
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([{
        window_id: 'btc-15m-window-1',
        token_id: 'token-123',
        market_id: 'market-123',
        direction: 'long',
        confidence: 0.85,
        price: 0.55,
        market_price: 0.55,
        expected_price: 0.55,
        symbol: 'BTC',
        // No strategy_id
      }]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Should use 'default' strategy_id
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'default')).toBe(true);
    });

    it('uses composed strategy name when strategy_id not in signal', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules(safeguards);

      // Signal without strategy_id
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([{
        window_id: 'btc-15m-window-1',
        token_id: 'token-123',
        market_id: 'market-123',
        direction: 'long',
        confidence: 0.85,
        price: 0.55,
        market_price: 0.55,
        expected_price: 0.55,
        symbol: 'BTC',
        // No strategy_id
      }]);

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
        composedStrategyName: 'my-composed-strategy', // Set the composed strategy name
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      // Should use composed strategy name
      expect(await safeguards.hasEnteredWindow('btc-15m-window-1', 'my-composed-strategy')).toBe(true);
    });
  });
});
