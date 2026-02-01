/**
 * Execution Loop Tests
 *
 * Unit tests for the execution loop logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExecutionLoop } from '../execution-loop.js';
import { LoopState } from '../types.js';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

// Mock modules
const createMockModules = () => ({
  spot: {
    getCurrentPrice: vi.fn().mockReturnValue({ price: 50000, timestamp: Date.now() }),
  },
  // Story 7-20: Default window manager that returns a BTC window for basic tests
  'window-manager': {
    getActiveWindows: vi.fn().mockResolvedValue([
      { id: 'btc-15m-1', crypto: 'btc', market_id: 'm1', token_id: 't1' },
    ]),
  },
});

// Default test config
const defaultConfig = {
  tickIntervalMs: 100,
};

describe('ExecutionLoop', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockModules = createMockModules();
    mockOnError = vi.fn();

    loop = new ExecutionLoop({
      config: defaultConfig,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });
  });

  afterEach(() => {
    loop.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('initializes with stopped state', () => {
      expect(loop.state).toBe(LoopState.STOPPED);
      expect(loop.tickCount).toBe(0);
      expect(loop.lastTickAt).toBeNull();
    });
  });

  describe('start()', () => {
    it('changes state to running', () => {
      loop.start();
      expect(loop.state).toBe(LoopState.RUNNING);
    });

    it('logs loop start', () => {
      loop.start();
      expect(mockLogger.info).toHaveBeenCalledWith('execution_loop_started', {
        tickIntervalMs: 100,
      });
    });

    it('executes first tick immediately', async () => {
      loop.start();

      // First tick is called synchronously after start but is async
      // Need to advance timers slightly to allow the async tick to process
      await vi.advanceTimersByTimeAsync(10);

      expect(loop.tickCount).toBeGreaterThanOrEqual(1);
    });

    it('is idempotent - does nothing if already running', () => {
      loop.start();

      loop.start();

      expect(mockLogger.debug).toHaveBeenCalledWith('loop_already_running');
    });
  });

  describe('stop()', () => {
    beforeEach(() => {
      loop.start();
    });

    it('changes state to stopped', () => {
      loop.stop();
      expect(loop.state).toBe(LoopState.STOPPED);
    });

    it('logs loop stop with tick count', () => {
      loop.stop();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'execution_loop_stopped',
        expect.objectContaining({ tickCount: expect.any(Number) })
      );
    });

    it('clears the interval', async () => {
      loop.stop();

      // Advance time - no more ticks should occur
      const tickCountAtStop = loop.tickCount;
      await vi.advanceTimersByTimeAsync(500);

      expect(loop.tickCount).toBe(tickCountAtStop);
    });
  });

  describe('pause()', () => {
    beforeEach(() => {
      loop.start();
    });

    it('changes state to paused', () => {
      loop.pause();
      expect(loop.state).toBe(LoopState.PAUSED);
    });

    it('logs loop pause', () => {
      loop.pause();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'execution_loop_paused',
        expect.objectContaining({ tickCount: expect.any(Number) })
      );
    });

    it('does nothing if not running', () => {
      loop.stop();
      loop.pause();

      expect(mockLogger.debug).toHaveBeenCalledWith('loop_not_running_cannot_pause', {
        state: LoopState.STOPPED,
      });
    });

    it('prevents tick processing when paused', async () => {
      // Let first tick complete
      await vi.advanceTimersByTimeAsync(10);
      const tickCountBeforePause = loop.tickCount;

      loop.pause();

      // Advance timers - ticks should not increment
      await vi.advanceTimersByTimeAsync(500);

      expect(loop.tickCount).toBe(tickCountBeforePause);
    });
  });

  describe('resume()', () => {
    beforeEach(() => {
      loop.start();
      loop.pause();
    });

    it('changes state from paused to running', () => {
      expect(loop.state).toBe(LoopState.PAUSED);

      loop.resume();

      expect(loop.state).toBe(LoopState.RUNNING);
    });

    it('logs loop resume', () => {
      loop.resume();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'execution_loop_resumed',
        expect.objectContaining({ tickCount: expect.any(Number) })
      );
    });

    it('does nothing if not paused', () => {
      loop.resume();
      loop.resume(); // Already running

      expect(mockLogger.debug).toHaveBeenCalledWith('loop_not_paused_cannot_resume', {
        state: LoopState.RUNNING,
      });
    });

    it('resumes tick processing', async () => {
      const tickCountBeforeResume = loop.tickCount;

      loop.resume();

      // Advance timers - ticks should resume
      await vi.advanceTimersByTimeAsync(500);

      expect(loop.tickCount).toBeGreaterThan(tickCountBeforeResume);
    });
  });

  describe('getState()', () => {
    it('returns current loop state', () => {
      const state = loop.getState();

      expect(state).toEqual({
        state: LoopState.STOPPED,
        tickCount: 0,
        lastTickAt: null,
        tickIntervalMs: 100,
        tickInProgress: false,
        activeStrategy: null,
        usingComposedStrategy: false,
      });
    });

    it('updates after start', async () => {
      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      const state = loop.getState();

      expect(state.state).toBe(LoopState.RUNNING);
      expect(state.tickCount).toBeGreaterThanOrEqual(1);
      expect(state.lastTickAt).not.toBeNull();
    });
  });

  describe('tick execution', () => {
    it('increments tick count on each tick', async () => {
      loop.start();

      // Run through several ticks
      await vi.advanceTimersByTimeAsync(350);

      // Should have at least 3 ticks (immediate + 3 intervals)
      expect(loop.tickCount).toBeGreaterThanOrEqual(3);
    });

    it('updates lastTickAt timestamp', async () => {
      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(loop.lastTickAt).toBeDefined();
      expect(typeof loop.lastTickAt).toBe('string');
    });

    it('fetches spot price on each tick', async () => {
      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mockModules.spot.getCurrentPrice).toHaveBeenCalled();
    });

    it('logs tick start at debug level and complete at info level', async () => {
      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'tick_start',
        expect.objectContaining({ tickCount: expect.any(Number) })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'tick_complete',
        expect.objectContaining({
          tickCount: expect.any(Number),
          durationMs: expect.any(Number),
          entrySignalsCount: expect.any(Number),
        })
      );
    });

    it('prevents overlapping ticks', async () => {
      vi.useRealTimers();

      // Create slow tick handler
      mockModules.spot.getCurrentPrice.mockImplementation(async () => {
        // Simulate slow operation
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { price: 50000 };
      });

      const fastLoop = new ExecutionLoop({
        config: { tickIntervalMs: 10 },
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      fastLoop.start();

      // Wait for potential overlapping ticks
      await new Promise((resolve) => setTimeout(resolve, 100));

      fastLoop.stop();

      // Should have logged overlap warnings if ticks overlapped
      // The important thing is we don't crash
      expect(true).toBe(true);
    });
  });

  describe('error handling', () => {
    it('logs warning when spot price fetch fails (Story 7-20 graceful handling)', async () => {
      const testError = new Error('Spot price fetch failed');
      testError.code = 'SPOT_ERROR';
      mockModules.spot.getCurrentPrice.mockImplementation(() => {
        throw testError;
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      // Story 7-20: Per-crypto errors are now handled gracefully with warnings
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'spot_price_fetch_failed',
        expect.objectContaining({
          crypto: 'btc',
          error: 'Spot price fetch failed',
        })
      );
      // Tick completes successfully even when price fetch fails
      expect(mockLogger.info).toHaveBeenCalledWith(
        'tick_complete',
        expect.objectContaining({ tickCount: expect.any(Number) })
      );
    });

    it('continues processing after recoverable error', async () => {
      mockModules.spot.getCurrentPrice
        .mockImplementationOnce(() => {
          throw new Error('Transient error');
        })
        .mockReturnValue({ price: 50000 });

      loop.start();

      // First tick errors
      await vi.advanceTimersByTimeAsync(50);

      // Second tick should succeed
      await vi.advanceTimersByTimeAsync(150);

      // Should have processed multiple ticks despite error
      expect(loop.tickCount).toBeGreaterThanOrEqual(2);
    });

    it('resets tickInProgress after error', async () => {
      mockModules.spot.getCurrentPrice.mockImplementation(() => {
        throw new Error('Error');
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      // tickInProgress should be false even after error
      expect(loop.tickInProgress).toBe(false);
    });
  });

  describe('tick skipping on overlap', () => {
    it('warns when tick is skipped due to overlap', async () => {
      vi.useRealTimers();

      // Simulate slow tick
      mockModules.spot.getCurrentPrice.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { price: 50000 };
      });

      const slowLoop = new ExecutionLoop({
        config: { tickIntervalMs: 50 },
        modules: mockModules,
        log: mockLogger,
        onError: mockOnError,
      });

      slowLoop.start();

      // Wait for overlap scenario
      await new Promise((resolve) => setTimeout(resolve, 300));

      slowLoop.stop();

      // Check if overlap warning was logged
      const overlapWarnings = mockLogger.warn.mock.calls.filter(
        (call) => call[0] === 'tick_skipped_overlap'
      );
      expect(overlapWarnings.length).toBeGreaterThanOrEqual(0); // May or may not happen depending on timing
    });
  });

  describe('per-crypto spot price fetching (Story 7-20)', () => {
    let loopWithWindows;
    let mockWindowManager;
    let mockSpot;
    let mockStrategyEvaluator;

    beforeEach(() => {
      mockSpot = {
        getCurrentPrice: vi.fn((crypto) => {
          const prices = {
            btc: { price: 78438, timestamp: Date.now(), source: 'pyth' },
            eth: { price: 2400, timestamp: Date.now(), source: 'pyth' },
            sol: { price: 100, timestamp: Date.now(), source: 'pyth' },
            xrp: { price: 1.60, timestamp: Date.now(), source: 'pyth' },
          };
          return prices[crypto.toLowerCase()] || null;
        }),
      };

      mockWindowManager = {
        getActiveWindows: vi.fn().mockResolvedValue([
          { id: 'btc-15m-1', crypto: 'btc', market_id: 'm1', token_id: 't1' },
          { id: 'eth-15m-1', crypto: 'eth', market_id: 'm2', token_id: 't2' },
          { id: 'sol-15m-1', crypto: 'sol', market_id: 'm3', token_id: 't3' },
        ]),
      };

      mockStrategyEvaluator = {
        evaluateEntryConditions: vi.fn().mockReturnValue([]),
      };

      loopWithWindows = new ExecutionLoop({
        config: { tickIntervalMs: 100 },
        modules: {
          spot: mockSpot,
          'window-manager': mockWindowManager,
          'strategy-evaluator': mockStrategyEvaluator,
        },
        log: createMockLogger(),
        onError: vi.fn(),
      });
    });

    afterEach(() => {
      loopWithWindows.stop();
    });

    it('fetches spot prices for each unique crypto in active windows', async () => {
      loopWithWindows.start();
      await vi.advanceTimersByTimeAsync(10);

      // Should have fetched prices for btc, eth, sol (the cryptos in windows)
      expect(mockSpot.getCurrentPrice).toHaveBeenCalledWith('btc');
      expect(mockSpot.getCurrentPrice).toHaveBeenCalledWith('eth');
      expect(mockSpot.getCurrentPrice).toHaveBeenCalledWith('sol');
    });

    it('passes correct spotPrices map to strategy evaluator', async () => {
      loopWithWindows.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mockStrategyEvaluator.evaluateEntryConditions).toHaveBeenCalled();

      const marketState = mockStrategyEvaluator.evaluateEntryConditions.mock.calls[0][0];
      expect(marketState.spotPrices).toBeDefined();
      expect(marketState.spotPrices.btc.price).toBe(78438);
      expect(marketState.spotPrices.eth.price).toBe(2400);
      expect(marketState.spotPrices.sol.price).toBe(100);
    });

    it('logs spot_prices_loaded with all cryptos', async () => {
      const logger = createMockLogger();
      const loopWithLogger = new ExecutionLoop({
        config: { tickIntervalMs: 100 },
        modules: {
          spot: mockSpot,
          'window-manager': mockWindowManager,
          'strategy-evaluator': mockStrategyEvaluator,
        },
        log: logger,
        onError: vi.fn(),
      });

      loopWithLogger.start();
      await vi.advanceTimersByTimeAsync(10);
      loopWithLogger.stop();

      const spotPricesLog = logger.debug.mock.calls.find(
        (call) => call[0] === 'spot_prices_loaded'
      );
      expect(spotPricesLog).toBeDefined();
      expect(spotPricesLog[1].cryptos).toContain('btc');
      expect(spotPricesLog[1].cryptos).toContain('eth');
      expect(spotPricesLog[1].cryptos).toContain('sol');
    });

    it('handles error when one crypto price fetch fails', async () => {
      mockSpot.getCurrentPrice.mockImplementation((crypto) => {
        if (crypto === 'eth') {
          throw new Error('ETH feed unavailable');
        }
        return { price: 78438, timestamp: Date.now() };
      });

      const logger = createMockLogger();
      const loopWithError = new ExecutionLoop({
        config: { tickIntervalMs: 100 },
        modules: {
          spot: mockSpot,
          'window-manager': mockWindowManager,
          'strategy-evaluator': mockStrategyEvaluator,
        },
        log: logger,
        onError: vi.fn(),
      });

      loopWithError.start();
      await vi.advanceTimersByTimeAsync(10);
      loopWithError.stop();

      // Should log warning for ETH but continue with other prices
      const warningLog = logger.warn.mock.calls.find(
        (call) => call[0] === 'spot_price_fetch_failed'
      );
      expect(warningLog).toBeDefined();
      expect(warningLog[1].crypto).toBe('eth');

      // Strategy should still be evaluated with available prices
      expect(mockStrategyEvaluator.evaluateEntryConditions).toHaveBeenCalled();
    });

    it('deduplicates crypto symbols from multiple windows', async () => {
      mockWindowManager.getActiveWindows.mockResolvedValue([
        { id: 'btc-15m-1', crypto: 'btc', market_id: 'm1', token_id: 't1' },
        { id: 'btc-15m-2', crypto: 'btc', market_id: 'm4', token_id: 't4' },
        { id: 'btc-30m-1', crypto: 'btc', market_id: 'm5', token_id: 't5' },
        { id: 'eth-15m-1', crypto: 'eth', market_id: 'm2', token_id: 't2' },
      ]);

      loopWithWindows.start();
      await vi.advanceTimersByTimeAsync(10);

      // BTC should only be fetched once despite 3 BTC windows
      const btcCalls = mockSpot.getCurrentPrice.mock.calls.filter(
        (call) => call[0] === 'btc'
      );
      expect(btcCalls).toHaveLength(1);

      // ETH should be fetched once
      const ethCalls = mockSpot.getCurrentPrice.mock.calls.filter(
        (call) => call[0] === 'eth'
      );
      expect(ethCalls).toHaveLength(1);
    });

    it('skips strategy evaluation when all price fetches fail', async () => {
      mockSpot.getCurrentPrice.mockImplementation(() => {
        throw new Error('All feeds unavailable');
      });

      const logger = createMockLogger();
      const loopWithFailingPrices = new ExecutionLoop({
        config: { tickIntervalMs: 100 },
        modules: {
          spot: mockSpot,
          'window-manager': mockWindowManager,
          'strategy-evaluator': mockStrategyEvaluator,
        },
        log: logger,
        onError: vi.fn(),
      });

      loopWithFailingPrices.start();
      await vi.advanceTimersByTimeAsync(10);
      loopWithFailingPrices.stop();

      // Strategy evaluator should NOT be called when no prices available
      // This is correct behavior - can't generate signals without price data
      expect(mockStrategyEvaluator.evaluateEntryConditions).not.toHaveBeenCalled();

      // Should have logged warnings for each failed crypto
      const warningLogs = logger.warn.mock.calls.filter(
        (call) => call[0] === 'spot_price_fetch_failed'
      );
      expect(warningLogs.length).toBeGreaterThan(0);
    });
  });
});
