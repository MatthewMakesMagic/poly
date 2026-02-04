/**
 * Execution Flow Integration Tests (Story 7-19)
 *
 * Purpose: Verify modules work together with real data to prevent data contract mismatches.
 *
 * Root Cause Context:
 * This story was created after a ~$90 USD production loss caused by:
 * 1. Wrong Oracle Price Bug: Called getCurrentPrice('btc') for ALL windows - ETH/SOL/XRP received BTC price
 * 2. Duplicate Entry Bug: Safeguards failed to block re-entry to same window
 *
 * 2,936 unit tests passed but production failed. Tests mocked everything - they verified
 * isolated components work correctly but never tested that components work together with real data.
 *
 * Philosophy: Use REAL module instances wherever possible. Only mock EXTERNAL dependencies (APIs, databases).
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
const windowEntries = new Map();
let nextEntryId = 1;

vi.mock('../../src/persistence/index.js', () => ({
  default: {
    run: vi.fn(async (sql, params) => {
      if (sql.includes('DELETE FROM window_entries') && sql.includes('reserved_at')) {
        return { changes: 0 };
      }
      if (sql.includes('DELETE FROM window_entries') && sql.includes("status = 'reserved'")) {
        const key = `${params[0]}::${params[1]}`;
        const entry = windowEntries.get(key);
        if (entry && entry.status === 'reserved') {
          windowEntries.delete(key);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (sql.includes('DELETE FROM window_entries')) {
        const key = `${params[0]}::${params[1]}`;
        if (windowEntries.has(key)) {
          windowEntries.delete(key);
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (sql.includes('INSERT INTO window_entries')) {
        const windowId = params[0];
        const strategyId = params[1];
        const key = `${windowId}::${strategyId}`;
        if (windowEntries.has(key)) {
          if (sql.includes('DO NOTHING')) {
            return { changes: 0 };
          }
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
      if (sql.includes('window_entries') && sql.includes('window_id')) {
        if (sql.includes('COUNT')) {
          let count = 0;
          for (const entry of windowEntries.values()) {
            if (sql.includes('confirmed') && entry.status === 'confirmed') count++;
            else if (sql.includes('reserved') && entry.status === 'reserved') count++;
          }
          return { count };
        }
        if (params && params.length >= 2) {
          const key = `${params[0]}::${params[1]}`;
          return windowEntries.get(key) || null;
        }
        return null;
      }
      if (sql.includes('confirmed_at') && sql.includes('ORDER BY')) {
        return null;
      }
      return null;
    }),
    all: vi.fn().mockResolvedValue([]),
  },
}));

import { ExecutionLoop } from '../../src/modules/orchestrator/execution-loop.js';
import * as safeguards from '../../src/modules/position-manager/safeguards.js';

// =============================================================================
// Test Fixtures - Realistic data structures matching production
// =============================================================================

// Realistic spot prices for different cryptos (approximate current values)
const SPOT_PRICES = {
  btc: { price: 78438.50, timestamp: Date.now(), source: 'binance', staleness: 0 },
  eth: { price: 2400.00, timestamp: Date.now(), source: 'binance', staleness: 0 },
  sol: { price: 100.00, timestamp: Date.now(), source: 'binance', staleness: 0 },
  xrp: { price: 1.60, timestamp: Date.now(), source: 'binance', staleness: 0 },
};

// Window structure expected by execution-loop (matches window-manager output)
const createWindow = (crypto, windowNum = 1) => ({
  id: `${crypto}-15m-${Date.now()}-${windowNum}`,
  crypto: crypto,  // CRITICAL: Used for spot price lookup
  market_id: `market-${crypto}-${windowNum}`,
  token_id: `token-${crypto}-${windowNum}`,
  expiry: Date.now() + 900000, // 15 minutes from now
  strike: 0.50,
  direction: 'up',
});

// Signal structure expected by safeguards and execution-loop
const createSignal = (window, spotPrice, strategyId = 'oracle-edge') => ({
  window_id: window.id,
  token_id: window.token_id,
  market_id: window.market_id,
  direction: 'long',
  confidence: 0.85,
  price: 0.55,
  market_price: 0.55,
  expected_price: 0.55,
  symbol: window.crypto.toUpperCase(), // CRITICAL: uppercase for safeguards
  strategy_id: strategyId,
  spot_price: spotPrice,
});

// =============================================================================
// Mock Module Factories
// =============================================================================

const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

/**
 * Create mock modules with call tracking
 * Uses spies to verify data contracts between modules
 */
const createMockModules = (safeguardsModule, overrides = {}) => ({
  // Spot client - returns per-crypto prices
  spot: {
    getCurrentPrice: vi.fn((crypto) => {
      const normalizedCrypto = (crypto || '').toLowerCase();
      return SPOT_PRICES[normalizedCrypto] || null;
    }),
  },

  // Window manager - returns windows with crypto field
  'window-manager': {
    getActiveWindows: vi.fn().mockResolvedValue([]),
  },

  // Strategy evaluator - generates signals from market state
  'strategy-evaluator': {
    evaluateEntryConditions: vi.fn().mockReturnValue([]),
  },

  // Position sizer
  'position-sizer': {
    calculateSize: vi.fn().mockResolvedValue({
      success: true,
      window_id: 'test-window',
      requested_size: 10,
      actual_size: 10,
      adjustment_reason: 'none',
    }),
  },

  // Order manager
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

  // Position manager
  'position-manager': {
    getPositions: vi.fn().mockReturnValue([]),
    getCurrentExposure: vi.fn().mockReturnValue(0),
    openPosition: vi.fn().mockReturnValue({ id: 'pos-123' }),
  },

  // Safeguards - use real module or mock
  safeguards: safeguardsModule,

  // Safety (drawdown)
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

// =============================================================================
// AC1: Data Contract Tests
// =============================================================================

describe('AC1: Data Contract Tests', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();

    // Initialize real safeguards module
    windowEntries.clear();
    nextEntryId = 1;
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0,
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) loop.stop();
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('execution-loop passes correct structure to strategy-evaluator', async () => {
    const btcWindow = createWindow('btc');

    mockModules = createMockModules(safeguards);
    mockModules['window-manager'].getActiveWindows.mockResolvedValue([btcWindow]);

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify strategy-evaluator was called with correct marketState structure
    expect(mockModules['strategy-evaluator'].evaluateEntryConditions).toHaveBeenCalled();

    const [marketState] = mockModules['strategy-evaluator'].evaluateEntryConditions.mock.calls[0];

    // Data contract: marketState must include spotPrices map and windows array
    expect(marketState).toHaveProperty('spotPrices');
    expect(marketState).toHaveProperty('windows');
    expect(marketState).toHaveProperty('spot_price'); // Backward compat

    // spotPrices must be keyed by crypto symbol
    expect(marketState.spotPrices).toHaveProperty('btc');
    expect(marketState.spotPrices.btc).toHaveProperty('price');
    expect(marketState.spotPrices.btc.price).toBe(78438.50);

    // windows must be passed through
    expect(marketState.windows).toHaveLength(1);
    expect(marketState.windows[0]).toBe(btcWindow);
  });

  it('spot client returns correct structure consumed by execution-loop', async () => {
    const btcWindow = createWindow('btc');

    mockModules = createMockModules(safeguards);
    mockModules['window-manager'].getActiveWindows.mockResolvedValue([btcWindow]);

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify spot client was called with correct crypto
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('btc');

    // Verify the structure returned by spot client
    const spotResult = mockModules.spot.getCurrentPrice('btc');
    expect(spotResult).toHaveProperty('price');
    expect(spotResult).toHaveProperty('timestamp');
    expect(spotResult).toHaveProperty('source');
    expect(typeof spotResult.price).toBe('number');
  });

  it('signal structure matches what safeguards expects', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards);
    mockModules['window-manager'].getActiveWindows.mockResolvedValue([btcWindow]);
    mockModules['strategy-evaluator'].evaluateEntryConditions.mockReturnValue([signal]);

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify signal has all required fields for safeguards
    expect(signal).toHaveProperty('window_id');
    expect(signal).toHaveProperty('strategy_id');
    expect(signal).toHaveProperty('symbol');
    expect(signal.symbol).toBe('BTC'); // Must be uppercase

    // Verify safeguards actually received the signal
    expect(await safeguards.hasEnteredWindow(btcWindow.id, 'oracle-edge')).toBe(true);
  });

  it('window structure includes required crypto field', async () => {
    const btcWindow = createWindow('btc');
    const ethWindow = createWindow('eth');

    mockModules = createMockModules(safeguards);
    mockModules['window-manager'].getActiveWindows.mockResolvedValue([btcWindow, ethWindow]);

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify windows have crypto field
    expect(btcWindow).toHaveProperty('crypto', 'btc');
    expect(ethWindow).toHaveProperty('crypto', 'eth');

    // Verify spot client was called for each crypto
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('btc');
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('eth');
  });

  it('marketState structure includes spotPrices map', async () => {
    const btcWindow = createWindow('btc');
    const ethWindow = createWindow('eth');

    mockModules = createMockModules(safeguards);
    mockModules['window-manager'].getActiveWindows.mockResolvedValue([btcWindow, ethWindow]);

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    const [marketState] = mockModules['strategy-evaluator'].evaluateEntryConditions.mock.calls[0];

    // spotPrices map must have entries for all active cryptos
    expect(Object.keys(marketState.spotPrices)).toContain('btc');
    expect(Object.keys(marketState.spotPrices)).toContain('eth');

    // Each entry must have correct structure
    expect(marketState.spotPrices.btc.price).toBe(78438.50);
    expect(marketState.spotPrices.eth.price).toBe(2400.00);
  });
});

// =============================================================================
// AC2: Flow Tests
// =============================================================================

describe('AC2: Flow Tests', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;
  let callOrder;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();
    callOrder = [];

    windowEntries.clear();
    nextEntryId = 1;
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0,
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) loop.stop();
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('Full tick flow from window fetch through signal generation', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    // Create modules that track call order
    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn(async () => {
          callOrder.push('window-manager');
          return [btcWindow];
        }),
      },
      spot: {
        getCurrentPrice: vi.fn((crypto) => {
          callOrder.push(`spot:${crypto}`);
          return SPOT_PRICES[crypto];
        }),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          callOrder.push('strategy-evaluator');
          return [signal];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify flow order: windows → spot prices → strategy evaluation
    expect(callOrder[0]).toBe('window-manager');
    expect(callOrder).toContain('spot:btc');
    expect(callOrder).toContain('strategy-evaluator');

    // Spot must come after windows, strategy must come after spot
    const windowIdx = callOrder.indexOf('window-manager');
    const spotIdx = callOrder.indexOf('spot:btc');
    const strategyIdx = callOrder.indexOf('strategy-evaluator');

    expect(spotIdx).toBeGreaterThan(windowIdx);
    expect(strategyIdx).toBeGreaterThan(spotIdx);
  });

  it('Module call order verification (windows → spot → strategy → safeguards → order)', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn(async () => {
          callOrder.push('windows');
          return [btcWindow];
        }),
      },
      spot: {
        getCurrentPrice: vi.fn((crypto) => {
          callOrder.push('spot');
          return SPOT_PRICES[crypto];
        }),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn(() => {
          callOrder.push('strategy');
          return [signal];
        }),
      },
      'position-sizer': {
        calculateSize: vi.fn(async () => {
          callOrder.push('sizer');
          return { success: true, actual_size: 10 };
        }),
      },
      'order-manager': {
        placeOrder: vi.fn(async () => {
          callOrder.push('order');
          return { orderId: 'test', status: 'filled', latencyMs: 50 };
        }),
      },
    });

    // Wrap safeguards to track calls
    const originalCanEnter = safeguards.canEnterPosition;
    vi.spyOn(safeguards, 'canEnterPosition').mockImplementation((...args) => {
      callOrder.push('safeguards');
      return originalCanEnter.apply(safeguards, args);
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify order: windows → spot → strategy → safeguards → sizer → order
    const expectedOrder = ['windows', 'spot', 'strategy', 'safeguards', 'sizer', 'order'];
    expect(callOrder).toEqual(expect.arrayContaining(expectedOrder));

    // Verify relative ordering
    for (let i = 0; i < expectedOrder.length - 1; i++) {
      const currentIdx = callOrder.indexOf(expectedOrder[i]);
      const nextIdx = callOrder.indexOf(expectedOrder[i + 1]);
      expect(nextIdx).toBeGreaterThan(currentIdx);
    }
  });

  it('Data transformation at each step is correct', async () => {
    const btcWindow = createWindow('btc');

    let capturedMarketState = null;
    let capturedSignal = null;

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          capturedMarketState = marketState;
          // Generate signal using actual marketState
          const signal = createSignal(btcWindow, marketState.spotPrices?.btc?.price || 0);
          return [signal];
        }),
      },
      'position-sizer': {
        calculateSize: vi.fn((signal) => {
          capturedSignal = signal;
          return Promise.resolve({
            success: true,
            window_id: signal.window_id,
            actual_size: 10,
          });
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify marketState passed to strategy includes window data
    expect(capturedMarketState.windows).toContain(btcWindow);
    expect(capturedMarketState.spotPrices.btc.price).toBe(78438.50);

    // Verify signal passed to position-sizer has correct data
    expect(capturedSignal.window_id).toBe(btcWindow.id);
    expect(capturedSignal.symbol).toBe('BTC');
  });

  it('Error in one module properly propagates/handles', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
      'position-sizer': {
        calculateSize: vi.fn().mockRejectedValue(new Error('Sizing failed')),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Error should be logged, not propagated to crash
    const errorLogs = mockLogger.error.mock.calls.filter(
      (call) => call[0] === 'position_sizing_error'
    );
    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0][1].error).toBe('Sizing failed');
  });
});

// =============================================================================
// AC3: Multi-Crypto Tests (CRITICAL - This is the bug that caused ~$90 loss)
// =============================================================================

describe('AC3: Multi-Crypto Tests', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();

    windowEntries.clear();
    nextEntryId = 1;
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0,
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) loop.stop();
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('BTC window receives BTC spot price', async () => {
    const btcWindow = createWindow('btc');

    let capturedMarketState = null;

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          capturedMarketState = marketState;
          return [];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // CRITICAL: BTC window must receive BTC price (~$78,438)
    expect(capturedMarketState.spotPrices.btc.price).toBe(78438.50);
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('btc');
  });

  it('ETH window receives ETH spot price', async () => {
    const ethWindow = createWindow('eth');

    let capturedMarketState = null;

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([ethWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          capturedMarketState = marketState;
          return [];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // CRITICAL: ETH window must receive ETH price (~$2,400), NOT BTC price
    expect(capturedMarketState.spotPrices.eth.price).toBe(2400.00);
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('eth');

    // Must NOT have called with 'btc' when only ETH window exists
    expect(mockModules.spot.getCurrentPrice).not.toHaveBeenCalledWith('btc');
  });

  it('SOL window receives SOL spot price', async () => {
    const solWindow = createWindow('sol');

    let capturedMarketState = null;

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([solWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          capturedMarketState = marketState;
          return [];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // CRITICAL: SOL window must receive SOL price (~$100), NOT BTC price
    expect(capturedMarketState.spotPrices.sol.price).toBe(100.00);
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('sol');
  });

  it('XRP window receives XRP spot price', async () => {
    const xrpWindow = createWindow('xrp');

    let capturedMarketState = null;

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([xrpWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          capturedMarketState = marketState;
          return [];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // CRITICAL: XRP window must receive XRP price (~$1.60), NOT BTC price
    expect(capturedMarketState.spotPrices.xrp.price).toBe(1.60);
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('xrp');
  });

  it('Mixed windows each receive correct crypto price', async () => {
    const btcWindow = createWindow('btc', 1);
    const ethWindow = createWindow('eth', 2);
    const solWindow = createWindow('sol', 3);
    const xrpWindow = createWindow('xrp', 4);

    let capturedMarketState = null;

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow, ethWindow, solWindow, xrpWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          capturedMarketState = marketState;
          return [];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Each crypto must have its own price in spotPrices map
    expect(capturedMarketState.spotPrices.btc.price).toBe(78438.50);
    expect(capturedMarketState.spotPrices.eth.price).toBe(2400.00);
    expect(capturedMarketState.spotPrices.sol.price).toBe(100.00);
    expect(capturedMarketState.spotPrices.xrp.price).toBe(1.60);

    // Verify correct calls to spot client
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('btc');
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('eth');
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('sol');
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('xrp');
  });

  it('spotPrices map keyed by crypto symbol is correct', async () => {
    const btcWindow = createWindow('btc');
    const ethWindow = createWindow('eth');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow, ethWindow]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify tick_complete log includes per-crypto spotPrices
    const tickCompleteLogs = mockLogger.info.mock.calls.filter(
      (call) => call[0] === 'tick_complete'
    );
    expect(tickCompleteLogs.length).toBeGreaterThanOrEqual(1);

    const logData = tickCompleteLogs[0][1];
    expect(logData.spotPrices).toEqual({
      btc: 78438.50,
      eth: 2400.00,
    });
  });

  it('No crypto receives another crypto price (prevents the $90 bug)', async () => {
    const ethWindow = createWindow('eth');

    // Track all calls to getCurrentPrice
    const priceCalls = [];

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([ethWindow]),
      },
      spot: {
        getCurrentPrice: vi.fn((crypto) => {
          priceCalls.push(crypto);
          return SPOT_PRICES[crypto];
        }),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn((marketState) => {
          // This is where the bug manifested - strategy received wrong price
          const ethPrice = marketState.spotPrices?.eth?.price;

          // THE BUG: If this ever equals BTC price for ETH window, we have the bug
          if (ethPrice === 78438.50) {
            throw new Error('ETH received BTC price! This is the ~$90 bug!');
          }

          return [];
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Only ETH price should be fetched for ETH window
    expect(priceCalls).toEqual(['eth']);
    expect(priceCalls).not.toContain('btc');
  });
});

// =============================================================================
// AC4: Safeguard Invocation Tests
// =============================================================================

describe('AC4: Safeguard Invocation Tests', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();

    windowEntries.clear();
    nextEntryId = 1;
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0,
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) loop.stop();
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('canEnterPosition called with actual signal data', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    const canEnterSpy = vi.spyOn(safeguards, 'canEnterPosition');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Verify canEnterPosition was called with actual signal
    expect(canEnterSpy).toHaveBeenCalled();
    const [signalArg] = canEnterSpy.mock.calls[0];
    expect(signalArg.window_id).toBe(signal.window_id);
    expect(signalArg.strategy_id).toBe('oracle-edge');
    expect(signalArg.symbol).toBe('BTC');
  });

  it('reserveEntry blocks concurrent duplicate signals', async () => {
    const btcWindow = createWindow('btc');
    const signal1 = createSignal(btcWindow, SPOT_PRICES.btc.price, 'oracle-edge');
    const signal2 = createSignal(btcWindow, SPOT_PRICES.btc.price, 'oracle-edge'); // Same window+strategy

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal1, signal2]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Only ONE order should be placed (duplicate blocked)
    expect(mockModules['order-manager'].placeOrder).toHaveBeenCalledTimes(1);

    // Entry should be confirmed for the window
    expect(await safeguards.hasEnteredWindow(btcWindow.id, 'oracle-edge')).toBe(true);
  });

  it('confirmEntry called after successful order', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    const confirmSpy = vi.spyOn(safeguards, 'confirmEntry');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // confirmEntry should be called after successful order
    expect(confirmSpy).toHaveBeenCalledWith(btcWindow.id, 'oracle-edge', 'BTC');
  });

  it('releaseEntry called on order failure', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    const releaseSpy = vi.spyOn(safeguards, 'releaseEntry');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
      'order-manager': {
        placeOrder: vi.fn().mockRejectedValue(new Error('Order failed')),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // releaseEntry should be called after order failure
    expect(releaseSpy).toHaveBeenCalledWith(btcWindow.id, 'oracle-edge');

    // Entry should NOT be confirmed (it was released)
    expect(await safeguards.hasEnteredWindow(btcWindow.id, 'oracle-edge')).toBe(false);
  });

  it('Strategy-aware tracking works correctly (same window, different strategies allowed)', async () => {
    const btcWindow = createWindow('btc');
    const signal1 = createSignal(btcWindow, SPOT_PRICES.btc.price, 'oracle-edge');
    const signal2 = createSignal(btcWindow, SPOT_PRICES.btc.price, 'simple-threshold');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal1, signal2]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // BOTH orders should be placed (different strategies)
    expect(mockModules['order-manager'].placeOrder).toHaveBeenCalledTimes(2);

    // Both entries should be confirmed
    expect(await safeguards.hasEnteredWindow(btcWindow.id, 'oracle-edge')).toBe(true);
    expect(await safeguards.hasEnteredWindow(btcWindow.id, 'simple-threshold')).toBe(true);
  });

  it('Duplicate entries to same {window_id, strategy_id} are blocked', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price, 'oracle-edge');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    // First tick - should enter
    loop.start();
    await vi.advanceTimersByTimeAsync(50);

    // Reset call count but keep safeguards state
    mockModules['order-manager'].placeOrder.mockClear();

    // Second tick - should be blocked
    await vi.advanceTimersByTimeAsync(100);
    loop.stop();

    // Second order should NOT be placed (blocked by safeguards)
    expect(mockModules['order-manager'].placeOrder).toHaveBeenCalledTimes(0);

    // Should log blocking
    const blockedLogs = mockLogger.info.mock.calls.filter(
      (call) => call[0] === 'entry_blocked_by_safeguards' &&
                call[1]?.reason === 'duplicate_window_entry'
    );
    expect(blockedLogs.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// AC5: Mode Tests
// =============================================================================

describe('AC5: Mode Tests', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();

    windowEntries.clear();
    nextEntryId = 1;
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0,
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) loop.stop();
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('PAPER mode does not call order-manager.placeOrder', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // NO order should be placed in PAPER mode
    expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();
  });

  it('PAPER mode calls safeguards.confirmEntry', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    const confirmSpy = vi.spyOn(safeguards, 'confirmEntry');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // confirmEntry SHOULD be called in PAPER mode (to prevent duplicates)
    expect(confirmSpy).toHaveBeenCalledWith(btcWindow.id, 'oracle-edge', 'BTC');
  });

  it('LIVE mode calls order-manager.placeOrder', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Order SHOULD be placed in LIVE mode
    expect(mockModules['order-manager'].placeOrder).toHaveBeenCalled();
  });

  it('trading_mode appears in paper_mode_signal logs', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    const paperModeLogs = mockLogger.info.mock.calls.filter(
      (call) => call[0] === 'paper_mode_signal'
    );
    expect(paperModeLogs.length).toBeGreaterThanOrEqual(1);
    expect(paperModeLogs[0][1].trading_mode).toBe('PAPER');
  });

  it('trading_mode appears in order_placed logs', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'LIVE' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    const orderPlacedLogs = mockLogger.info.mock.calls.filter(
      (call) => call[0] === 'order_placed'
    );
    expect(orderPlacedLogs.length).toBeGreaterThanOrEqual(1);
    expect(orderPlacedLogs[0][1].trading_mode).toBe('LIVE');
  });

  it('undefined tradingMode defaults to PAPER', async () => {
    const btcWindow = createWindow('btc');
    const signal = createSignal(btcWindow, SPOT_PRICES.btc.price);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      'strategy-evaluator': {
        evaluateEntryConditions: vi.fn().mockReturnValue([signal]),
      },
    });

    // No tradingMode specified
    const config = { tickIntervalMs: 100 };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Should NOT place order (defaults to PAPER)
    expect(mockModules['order-manager'].placeOrder).not.toHaveBeenCalled();

    // Should log paper_mode_signal
    const paperModeLogs = mockLogger.info.mock.calls.filter(
      (call) => call[0] === 'paper_mode_signal'
    );
    expect(paperModeLogs.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Edge Cases and Regression Tests
// =============================================================================

describe('Edge Cases and Regression Tests', () => {
  let loop;
  let mockLogger;
  let mockModules;
  let mockOnError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = createMockLogger();
    mockOnError = vi.fn();

    windowEntries.clear();
    nextEntryId = 1;
    safeguards.init({
      safeguards: {
        max_concurrent_positions: 8,
        min_entry_interval_ms: 0,
        max_entries_per_tick: 10,
        duplicate_window_prevention: true,
        reservation_timeout_ms: 30000,
      },
    });
  });

  afterEach(() => {
    if (loop) loop.stop();
    safeguards.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('handles empty windows gracefully', async () => {
    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Should complete without errors
    expect(mockOnError).not.toHaveBeenCalled();
    expect(mockModules.spot.getCurrentPrice).not.toHaveBeenCalled(); // No cryptos to fetch
  });

  it('handles spot price fetch failure gracefully', async () => {
    const btcWindow = createWindow('btc');

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow]),
      },
      spot: {
        getCurrentPrice: vi.fn(() => {
          throw new Error('API unavailable');
        }),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Should log warning but not crash
    const warnLogs = mockLogger.warn.mock.calls.filter(
      (call) => call[0] === 'spot_price_fetch_failed'
    );
    expect(warnLogs.length).toBe(1);
    expect(warnLogs[0][1].crypto).toBe('btc');
  });

  it('handles windows without crypto field gracefully', async () => {
    const windowWithoutCrypto = { id: 'test-window', market_id: 'market-1' };

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([windowWithoutCrypto]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Should complete without errors
    expect(mockOnError).not.toHaveBeenCalled();
    // Should not call spot for undefined crypto
    expect(mockModules.spot.getCurrentPrice).not.toHaveBeenCalled();
  });

  it('handles duplicate cryptos in windows correctly', async () => {
    const btcWindow1 = createWindow('btc', 1);
    const btcWindow2 = createWindow('btc', 2);

    mockModules = createMockModules(safeguards, {
      'window-manager': {
        getActiveWindows: vi.fn().mockResolvedValue([btcWindow1, btcWindow2]),
      },
    });

    const config = { tickIntervalMs: 100, tradingMode: 'PAPER' };

    loop = new ExecutionLoop({
      config,
      modules: mockModules,
      log: mockLogger,
      onError: mockOnError,
    });

    loop.start();
    await vi.advanceTimersByTimeAsync(50);
    loop.stop();

    // Should only call getCurrentPrice once for BTC (deduped by Set)
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledTimes(1);
    expect(mockModules.spot.getCurrentPrice).toHaveBeenCalledWith('btc');
  });
});
