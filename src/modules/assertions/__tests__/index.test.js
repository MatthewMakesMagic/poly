/**
 * Tests for Runtime Assertions Module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock persistence before import
const mockAll = vi.fn().mockResolvedValue([]);
const mockGet = vi.fn().mockResolvedValue({ count: '0' });
vi.mock('../../../persistence/index.js', () => ({
  default: {
    all: (...args) => mockAll(...args),
    get: (...args) => mockGet(...args),
  },
}));

// Mock logger
vi.mock('../../logger/index.js', () => ({
  child: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

let assertions;

beforeEach(async () => {
  vi.useFakeTimers();
  // Fresh import for each test
  vi.resetModules();
  const mod = await import('../index.js');
  assertions = mod;
});

afterEach(async () => {
  try {
    await assertions.shutdown();
  } catch {
    // ignore
  }
  vi.useRealTimers();
});

describe('assertions module', () => {
  describe('init()', () => {
    it('initializes with default config', async () => {
      await assertions.init({});
      const state = assertions.getState();
      expect(state.initialized).toBe(true);
      expect(state.assertions).toHaveLength(10);
      expect(state.assertions[0].name).toBe('signal_order_mapping');
    });

    it('initializes assertions as pending', async () => {
      await assertions.init({});
      const state = assertions.getState();
      for (const a of state.assertions) {
        expect(a.passed).toBe(null);
        expect(a.message).toBe('pending');
      }
    });

    it('is idempotent', async () => {
      await assertions.init({});
      await assertions.init({});
      expect(assertions.getState().initialized).toBe(true);
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state when not initialized', () => {
      const state = assertions.getState();
      expect(state.initialized).toBe(false);
      expect(state.assertions).toEqual([]);
    });

    it('includes stats', async () => {
      await assertions.init({});
      const state = assertions.getState();
      expect(state.stats).toEqual({
        passes: 0,
        failures: 0,
        totalChecks: 0,
      });
    });
  });

  describe('setCircuitBreaker()', () => {
    it('accepts a circuit breaker reference', async () => {
      await assertions.init({});
      const mockCB = { trip: vi.fn() };
      assertions.setCircuitBreaker(mockCB);
      // No error thrown
    });
  });

  describe('recordTickDuration()', () => {
    it('records tick duration for heartbeat', async () => {
      await assertions.init({});
      assertions.recordTickDuration(100);
      // After recording, heartbeat should pass
    });
  });

  describe('shutdown()', () => {
    it('cleans up state', async () => {
      await assertions.init({});
      await assertions.shutdown();
      const state = assertions.getState();
      expect(state.initialized).toBe(false);
    });
  });

  describe('assertion names', () => {
    it('has exactly 10 assertions', async () => {
      await assertions.init({});
      const state = assertions.getState();
      expect(state.assertions).toHaveLength(10);
    });

    it('all assertion names match spec', async () => {
      await assertions.init({});
      const names = assertions.getState().assertions.map(a => a.name);
      expect(names).toEqual([
        'signal_order_mapping',
        'order_fill_confirmation',
        'fill_position_created',
        'position_count_match',
        'pnl_balance_match',
        'no_null_order_ids',
        'instrument_scope',
        'no_future_windows',
        'capital_cap',
        'system_heartbeat',
      ]);
    });
  });
});
