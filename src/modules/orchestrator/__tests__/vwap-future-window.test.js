/**
 * VWAP Future Window Rejection Tests
 *
 * Verifies hotfix ee64cac: the VWAP contrarian strategy must skip windows
 * where time_remaining_ms > windowDurationMs (15 min = 900,000 ms).
 *
 * Future windows have time_remaining > 900s and CLOB at ~50¢ default,
 * which causes false signals on every instrument if not filtered.
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

describe('VWAP future window rejection (hotfix ee64cac)', () => {
  let loop;
  let mockLogger;
  let mockOnError;

  const WINDOW_DURATION_MS = 15 * 60 * 1000; // 900,000 ms

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();
  });

  afterEach(() => {
    if (loop) loop.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createLoop(windows, vwapData = null) {
    const mockEtc = {
      getCompositeVWAP: vi.fn().mockReturnValue(vwapData || {
        vwap: 50100,
        exchangeCount: 21,
        totalVolume: 1000000,
      }),
    };

    const modules = {
      spot: {
        getCurrentPrice: vi.fn().mockReturnValue({ price: 50000, timestamp: Date.now() }),
      },
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue(windows),
      },
      'exchange-trade-collector': mockEtc,
    };

    loop = new ExecutionLoop({
      config: {
        tickIntervalMs: 1000,
        vwapStrategy: {
          deltaThresholdPct: 0.01, // Very low threshold to ensure signal fires if not filtered
          maxClobConviction: 0.40,
        },
        strategy: { sizing: { baseSizeDollars: 2 } },
      },
      modules,
      log: mockLogger,
      onError: mockOnError,
    });

    return { modules, mockEtc };
  }

  it('skips windows with time_remaining_ms > 15 minutes (future window)', async () => {
    const futureWindow = {
      window_id: 'btc-future-1',
      market_id: 'market-1',
      crypto: 'btc',
      token_id_up: 'token-up',
      token_id_down: 'token-down',
      market_price: 0.50, // Default 50¢ for future windows
      time_remaining_ms: WINDOW_DURATION_MS + 60000, // 16 minutes = future
    };

    const { mockEtc } = createLoop([futureWindow]);

    loop.start();
    await vi.advanceTimersByTimeAsync(50);

    // Should log the skip and NOT call evaluateMarketState
    const skipLogs = mockLogger.debug.mock.calls.filter(
      ([event]) => event === 'vwap_skip_future_window'
    );
    expect(skipLogs.length).toBeGreaterThanOrEqual(1);
    expect(skipLogs[0][1]).toMatchObject({
      window_id: 'btc-future-1',
    });

    // Should NOT generate any VWAP signal
    const signalLogs = mockLogger.info.mock.calls.filter(
      ([event]) => event === 'vwap_contrarian_signal'
    );
    expect(signalLogs).toHaveLength(0);
  });

  it('processes windows with time_remaining_ms within 15 minutes (active window)', async () => {
    const activeWindow = {
      window_id: 'btc-active-1',
      market_id: 'market-1',
      crypto: 'btc',
      token_id_up: 'token-up',
      token_id_down: 'token-down',
      market_price: 0.40, // CLOB says DOWN
      time_remaining_ms: 300000, // 5 minutes remaining — active
    };

    // VWAP is above open price = UP direction, CLOB is DOWN = disagreement
    const { mockEtc } = createLoop([activeWindow], {
      vwap: 50200,
      exchangeCount: 21,
      totalVolume: 1000000,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);

    // Should NOT skip this window
    const skipLogs = mockLogger.debug.mock.calls.filter(
      ([event]) => event === 'vwap_skip_future_window'
    );
    expect(skipLogs).toHaveLength(0);

    // Should evaluate this window
    const evalLogs = mockLogger.debug.mock.calls.filter(
      ([event]) => event === 'vwap_contrarian_evaluated'
    );
    expect(evalLogs.length).toBeGreaterThanOrEqual(1);
  });

  it('skips windows with < 5s remaining', async () => {
    const expiredWindow = {
      window_id: 'btc-expiring-1',
      market_id: 'market-1',
      crypto: 'btc',
      token_id_up: 'token-up',
      token_id_down: 'token-down',
      market_price: 0.40,
      time_remaining_ms: 3000, // 3 seconds remaining — too late
    };

    createLoop([expiredWindow]);

    loop.start();
    await vi.advanceTimersByTimeAsync(50);

    // Should not produce any VWAP signal or evaluation for this window
    const signalLogs = mockLogger.info.mock.calls.filter(
      ([event]) => event === 'vwap_contrarian_signal'
    );
    expect(signalLogs).toHaveLength(0);

    const evalLogs = mockLogger.debug.mock.calls.filter(
      ([event]) => event === 'vwap_contrarian_evaluated'
    );
    expect(evalLogs).toHaveLength(0);
  });

  it('boundary: window at exactly 15 minutes is NOT skipped', async () => {
    const boundaryWindow = {
      window_id: 'btc-boundary-1',
      market_id: 'market-1',
      crypto: 'btc',
      token_id_up: 'token-up',
      token_id_down: 'token-down',
      market_price: 0.50,
      time_remaining_ms: WINDOW_DURATION_MS, // Exactly 15 minutes
    };

    createLoop([boundaryWindow]);

    loop.start();
    await vi.advanceTimersByTimeAsync(50);

    // Should NOT be skipped as future (guard is >windowDuration, not >=)
    const skipLogs = mockLogger.debug.mock.calls.filter(
      ([event]) => event === 'vwap_skip_future_window'
    );
    expect(skipLogs).toHaveLength(0);
  });
});
