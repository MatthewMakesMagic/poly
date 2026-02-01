/**
 * Oracle Edge Signal Integration Tests
 *
 * Tests for integration with staleness-detector and divergence-tracker:
 * - End-to-end signal generation
 * - Dependency failure handling
 * - Real-world scenario simulation
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { OracleEdgeSignalGenerator } from '../generator.js';
import { SignalDirection, DEFAULT_CONFIG } from '../types.js';

// Mock logger
const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

describe('Oracle Edge Signal Integration', () => {
  let mockLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe('End-to-end signal generation scenarios', () => {
    test('generates FADE_UP signal when UI shows UP and oracle is stale', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62, // UI shows UP (> 0.5 strike)
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).not.toBeNull();
      expect(signal.direction).toBe(SignalDirection.FADE_UP);
      expect(signal.token_id).toBe('0xDOWN'); // We buy DOWN to fade UP
      expect(signal.side).toBe('buy');
    });

    test('generates FADE_DOWN signal when UI shows DOWN and oracle is stale', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.38, // UI shows DOWN (< 0.5 strike)
          oracle_price: 0.42,
          pct: 0.002,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.22, // Low market price shows DOWN conviction
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).not.toBeNull();
      expect(signal.direction).toBe(SignalDirection.FADE_DOWN);
      expect(signal.token_id).toBe('0xUP'); // We buy UP to fade DOWN
    });

    test('no signal when oracle recently updated (not stale)', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: false,
          score: 0.3,
          inputs: { time_since_update_ms: 5000 }, // Only 5 seconds
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).toBeNull();
    });

    test('no signal when too far from expiry', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 60000, // 60 seconds - too far
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).toBeNull();
    });

    test('no signal when divergence too large (oracle might update)', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.008, // 0.8% > 0.5% threshold - oracle will likely update
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).toBeNull();
    });
  });

  describe('Dependency failure handling', () => {
    test('handles staleness detector throwing error', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => {
          throw new Error('Staleness detector not initialized');
        }),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('staleness_data_unavailable', expect.any(Object));
    });

    test('handles divergence tracker throwing error', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => {
          throw new Error('Divergence tracker not initialized');
        }),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith('divergence_data_unavailable', expect.any(Object));
    });

    test('handles both dependencies unavailable', () => {
      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector: null,
        divergenceTracker: null,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).toBeNull();
    });
  });

  describe('Multi-symbol support', () => {
    test('generates signals for different symbols', () => {
      const stalenessDetector = {
        getStaleness: vi.fn((symbol) => ({
          symbol,
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const windows = [
        { window_id: 'btc-15m-1', crypto: 'btc', time_remaining_ms: 20000, market_price: 0.75, token_id_up: 'UP1', token_id_down: 'DOWN1' },
        { window_id: 'eth-15m-1', crypto: 'eth', time_remaining_ms: 20000, market_price: 0.75, token_id_up: 'UP2', token_id_down: 'DOWN2' },
        { window_id: 'sol-15m-1', crypto: 'sol', time_remaining_ms: 20000, market_price: 0.75, token_id_up: 'UP3', token_id_down: 'DOWN3' },
        { window_id: 'xrp-15m-1', crypto: 'xrp', time_remaining_ms: 20000, market_price: 0.75, token_id_up: 'UP4', token_id_down: 'DOWN4' },
      ];

      const signals = generator.evaluateAllWindows(windows);

      expect(signals.length).toBe(4);
      expect(signals.map(s => s.symbol)).toEqual(['btc', 'eth', 'sol', 'xrp']);
    });
  });

  describe('Subscription callbacks in integration', () => {
    test('callbacks receive complete signal data', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const callback = vi.fn();
      generator.subscribe(callback);

      generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        window_id: 'btc-15m-1',
        symbol: 'btc',
        direction: SignalDirection.FADE_UP,
        confidence: expect.any(Number),
        token_id: '0xDOWN',
        side: 'buy',
        inputs: expect.objectContaining({
          time_remaining_ms: 20000,
          market_price: 0.75,
          ui_price: 0.62,
          oracle_price: 0.55,
        }),
        generated_at: expect.any(String),
      }));
    });

    test('multiple callbacks all triggered on signal', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const callbacks = [vi.fn(), vi.fn(), vi.fn()];
      callbacks.forEach(cb => generator.subscribe(cb));

      generator.evaluateWindow({
        window_id: 'btc-15m-1',
        crypto: 'btc',
        time_remaining_ms: 20000,
        market_price: 0.75,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      callbacks.forEach(cb => {
        expect(cb).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Real-world timing scenarios', () => {
    test('signal at 25 seconds before expiry with 20 second staleness', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.7,
          inputs: { time_since_update_ms: 20000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.58,
          oracle_price: 0.53,
          pct: 0.002,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-realistic',
        crypto: 'btc',
        time_remaining_ms: 25000,
        market_price: 0.70,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).not.toBeNull();
      expect(signal.confidence).toBeGreaterThan(0.3); // Reasonable confidence for moderate staleness/divergence
      expect(signal.inputs.time_remaining_ms).toBe(25000);
      expect(signal.inputs.oracle_staleness_ms).toBe(20000);
    });

    test('high confidence signal at 5 seconds before expiry with 45 second staleness', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.95,
          inputs: { time_since_update_ms: 45000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.65,
          oracle_price: 0.58,
          pct: 0.004,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      const signal = generator.evaluateWindow({
        window_id: 'btc-15m-high-conf',
        crypto: 'btc',
        time_remaining_ms: 5000,
        market_price: 0.80,
        token_id_up: '0xUP',
        token_id_down: '0xDOWN',
      });

      expect(signal).not.toBeNull();
      expect(signal.confidence).toBeGreaterThan(0.7); // High confidence
    });
  });

  describe('Statistics accumulation', () => {
    test('stats accumulate correctly across multiple evaluations', () => {
      const stalenessDetector = {
        getStaleness: vi.fn(() => ({
          symbol: 'btc',
          is_stale: true,
          score: 0.8,
          inputs: { time_since_update_ms: 25000 },
        })),
      };

      const divergenceTracker = {
        getSpread: vi.fn(() => ({
          ui_price: 0.62,
          oracle_price: 0.55,
          pct: 0.003,
        })),
      };

      const generator = new OracleEdgeSignalGenerator({
        config: DEFAULT_CONFIG,
        logger: mockLogger,
        stalenessDetector,
        divergenceTracker,
      });

      // Generate several signals
      for (let i = 0; i < 5; i++) {
        generator.evaluateWindow({
          window_id: `btc-15m-${i}`,
          crypto: 'btc',
          time_remaining_ms: 20000,
          market_price: 0.75,
          token_id_up: '0xUP',
          token_id_down: '0xDOWN',
        });
      }

      // Evaluate some that don't generate signals
      for (let i = 0; i < 3; i++) {
        generator.evaluateWindow({
          window_id: `btc-15m-nosignal-${i}`,
          crypto: 'btc',
          time_remaining_ms: 45000, // Too early
          market_price: 0.75,
          token_id_up: '0xUP',
          token_id_down: '0xDOWN',
        });
      }

      const stats = generator.getStats();

      expect(stats.signals_generated).toBe(5);
      expect(stats.evaluations_total).toBe(8);
      expect(stats.signals_by_direction.fade_up).toBe(5);
      expect(stats.signals_by_symbol.btc).toBe(5);
      expect(stats.avg_confidence).toBeGreaterThan(0);
    });
  });
});
