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
import { ExecutionLoop } from '../../src/modules/orchestrator/execution-loop.js';
import * as safeguards from '../../src/modules/position-manager/safeguards.js';

// Mock the logger for safeguards module
vi.mock('../../src/modules/logger/index.js', () => ({
  child: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(true);

      // Second attempt to same window/strategy should be blocked
      const result = safeguards.canEnterPosition({
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'paper-strategy')).toBe(true);
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(true);
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(true);
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'simple-threshold')).toBe(true);

      // But same strategy should now be blocked
      const result = safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []);
      expect(result.allowed).toBe(false);
    });
  });

  describe('AC 8.4: System restart with open positions loads entries correctly', () => {
    it('initializes entries from existing open positions', () => {
      // Simulate existing positions from a restart
      const existingPositions = [
        { window_id: 'btc-15m-window-1', strategy_id: 'oracle-edge' },
        { window_id: 'eth-15m-window-2', strategy_id: 'simple-threshold' },
        { window_id: 'btc-15m-window-3' }, // No strategy_id - uses default
      ];

      // Initialize from positions (simulating startup hydration)
      const count = safeguards.initializeFromPositions(existingPositions);
      expect(count).toBe(3);

      // All positions should block re-entry
      expect(safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []).allowed).toBe(false);

      expect(safeguards.canEnterPosition({
        window_id: 'eth-15m-window-2',
        strategy_id: 'simple-threshold',
        symbol: 'ETH',
      }, []).allowed).toBe(false);

      expect(safeguards.canEnterPosition({
        window_id: 'btc-15m-window-3',
        strategy_id: 'default',
        symbol: 'BTC',
      }, []).allowed).toBe(false);

      // But different strategies for same windows should be allowed
      expect(safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'simple-threshold',
        symbol: 'BTC',
      }, []).allowed).toBe(true);
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(false);

      // Should allow retry
      const result = safeguards.canEnterPosition({
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'oracle-edge')).toBe(false);

      // Verify release was logged
      const releaseLogs = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'entry_released_order_rejected'
      );
      expect(releaseLogs.length).toBe(1);
    });
  });

  describe('Position close removes entry', () => {
    it('allows re-entry after position is closed', () => {
      // Enter a position
      safeguards.confirmEntry('btc-15m-window-1', 'oracle-edge', 'BTC');

      // Should be blocked
      expect(safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []).allowed).toBe(false);

      // Simulate position close
      safeguards.removeEntry('btc-15m-window-1', 'oracle-edge');

      // Should be allowed now
      expect(safeguards.canEnterPosition({
        window_id: 'btc-15m-window-1',
        strategy_id: 'oracle-edge',
        symbol: 'BTC',
      }, []).allowed).toBe(true);
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'default')).toBe(true);
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
      expect(safeguards.hasEnteredWindow('btc-15m-window-1', 'my-composed-strategy')).toBe(true);
    });
  });
});
