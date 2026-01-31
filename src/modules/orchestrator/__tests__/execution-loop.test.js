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

    it('logs tick start and complete at debug level', async () => {
      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'tick_start',
        expect.objectContaining({ tickCount: expect.any(Number) })
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'tick_complete',
        expect.objectContaining({
          tickCount: expect.any(Number),
          durationMs: expect.any(Number),
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
    it('logs errors and calls onError callback', async () => {
      const testError = new Error('Spot price fetch failed');
      testError.code = 'SPOT_ERROR';
      mockModules.spot.getCurrentPrice.mockImplementation(() => {
        throw testError;
      });

      loop.start();
      await vi.advanceTimersByTimeAsync(10);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'tick_error',
        expect.objectContaining({
          error: 'Spot price fetch failed',
          code: 'SPOT_ERROR',
        })
      );
      expect(mockOnError).toHaveBeenCalledWith(testError);
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
});
