/**
 * Trading Mode Integration Tests (Story 8-8)
 *
 * Tests for the live trading gate feature that ensures:
 * - System runs in PAPER mode by default
 * - PAPER mode blocks orders but records entries
 * - LIVE mode enables actual order placement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExecutionLoop } from '../../src/modules/orchestrator/execution-loop.js';
import { LoopState } from '../../src/modules/orchestrator/types.js';

// Mock logger that captures all calls
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Mock modules for integration testing
const createMockModules = (overrides = {}) => ({
  spot: {
    getCurrentPrice: vi.fn().mockReturnValue({ price: 50000, timestamp: Date.now() }),
  },
  // Story 7-20: Must return windows with crypto field for spot price fetching
  'window-manager': {
    getActiveWindows: vi.fn().mockResolvedValue([
      { id: 'btc-15m-test-window', crypto: 'btc', market_id: 'market-123', token_id: 'token-123' },
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
  safeguards: {
    resetTickEntries: vi.fn(),
    canEnterPosition: vi.fn().mockReturnValue({ allowed: true }),
    recordEntry: vi.fn(),
    reserveEntry: vi.fn().mockReturnValue(true),
    confirmEntry: vi.fn(),
    releaseEntry: vi.fn(),
  },
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

// Create a mock signal for testing
const createMockSignal = () => ({
  window_id: 'btc-15m-test-window',
  token_id: 'token-123',
  market_id: 'market-123',
  direction: 'long',
  confidence: 0.85,
  price: 0.55,
  market_price: 0.55,
  expected_price: 0.55,
  symbol: 'BTC',
  strategy_id: 'test-strategy',
});

describe('Trading Mode Integration Tests (Story 8-8)', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();
  });

  afterEach(() => {
    if (loop) {
      loop.stop();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('AC1: PAPER Mode Default - TRADING_MODE=undefined', () => {
    it('runs in PAPER mode when TRADING_MODE is undefined', async () => {
      // Config with no tradingMode (simulates undefined env var)
      const config = {
        tickIntervalMs: 100,
        // tradingMode is undefined
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Should have logged paper_mode_signal (order blocked)
      const paperModeSignals = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'paper_mode_signal'
      );
      expect(paperModeSignals.length).toBeGreaterThanOrEqual(1);

      // Verify trading_mode is PAPER in the log
      expect(paperModeSignals[0][1].trading_mode).toBe('PAPER');
      expect(paperModeSignals[0][1].message).toBe('Order blocked - PAPER mode active');

      // Should NOT have placed an order
      expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();
    });
  });

  describe('AC2: PAPER Mode with explicit TRADING_MODE=PAPER', () => {
    it('runs in PAPER mode when TRADING_MODE is explicitly PAPER', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Should have logged paper_mode_signal
      const paperModeSignals = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'paper_mode_signal'
      );
      expect(paperModeSignals.length).toBeGreaterThanOrEqual(1);
      expect(paperModeSignals[0][1].trading_mode).toBe('PAPER');

      // Should NOT have placed an order
      expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();
    });
  });

  describe('AC3: LIVE Mode with TRADING_MODE=LIVE', () => {
    it('places orders when TRADING_MODE is LIVE', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'LIVE',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Should NOT have logged paper_mode_signal
      const paperModeSignals = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'paper_mode_signal'
      );
      expect(paperModeSignals.length).toBe(0);

      // Should have placed an order
      expect(mockModules['order-manager'].placeOrder).toHaveBeenCalled();

      // Should have logged order_placed with trading_mode=LIVE
      const orderPlacedLogs = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'order_placed'
      );
      expect(orderPlacedLogs.length).toBeGreaterThanOrEqual(1);
      expect(orderPlacedLogs[0][1].trading_mode).toBe('LIVE');
    });
  });

  describe('AC4: PAPER mode blocks orders but records entries', () => {
    it('calls safeguards.recordEntry in PAPER mode', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Should have used reserve/confirm flow for PAPER mode (Story 8-9)
      expect(mockModules.safeguards.reserveEntry).toHaveBeenCalledWith(
        'btc-15m-test-window',
        'test-strategy'
      );
      expect(mockModules.safeguards.confirmEntry).toHaveBeenCalledWith(
        'btc-15m-test-window',
        'test-strategy',
        'BTC'
      );

      // Should NOT have placed an order
      expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();
    });

    it('does not open a position in PAPER mode', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Should NOT have opened a position
      expect(mockModules['position-manager'].openPosition).not.toHaveBeenCalled();
    });
  });

  describe('AC7: Log tagging with trading_mode', () => {
    it('includes trading_mode in entry_signals_generated log', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      const entrySignalsLogs = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'entry_signals_generated'
      );
      expect(entrySignalsLogs.length).toBeGreaterThanOrEqual(1);
      expect(entrySignalsLogs[0][1].trading_mode).toBe('PAPER');
    });

    it('includes trading_mode in tick_complete log', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules();

      loop = new ExecutionLoop({
        config,
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(50);
      loop.stop();

      const tickCompleteLogs = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'tick_complete'
      );
      expect(tickCompleteLogs.length).toBeGreaterThanOrEqual(1);
      expect(tickCompleteLogs[0][1].trading_mode).toBe('PAPER');
    });

    it('includes trading_mode in paper_mode_signal log', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'PAPER',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      const paperModeSignals = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'paper_mode_signal'
      );
      expect(paperModeSignals.length).toBeGreaterThanOrEqual(1);
      expect(paperModeSignals[0][1].trading_mode).toBe('PAPER');
    });
  });

  describe('Edge cases', () => {
    it('treats any non-LIVE value as PAPER mode', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: 'invalid-value',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Should have logged paper_mode_signal since tradingMode !== 'LIVE'
      const paperModeSignals = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'paper_mode_signal'
      );
      expect(paperModeSignals.length).toBeGreaterThanOrEqual(1);
      expect(paperModeSignals[0][1].trading_mode).toBe('invalid-value');

      // Should NOT have placed an order
      expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();
    });

    it('handles empty string as PAPER mode', async () => {
      const config = {
        tickIntervalMs: 100,
        tradingMode: '',
      };

      mockModules = createMockModules();
      mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([
        createMockSignal(),
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

      // Empty string is falsy, so tradingMode || 'PAPER' = 'PAPER'
      const paperModeSignals = mockLogger.info.mock.calls.filter(
        (call) => call[0] === 'paper_mode_signal'
      );
      expect(paperModeSignals.length).toBeGreaterThanOrEqual(1);
      expect(paperModeSignals[0][1].trading_mode).toBe('PAPER');
    });
  });
});
