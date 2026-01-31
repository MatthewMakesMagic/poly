/**
 * Orchestrator Module Tests
 *
 * Tests the public interface of the orchestrator module.
 * Uses vitest with mocked dependencies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue({ initialized: true, connected: true }),
  },
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true, connected: true }),
}));

vi.mock('../../../clients/polymarket/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true, ready: true }),
}));

vi.mock('../../../clients/spot/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true, connected: true }),
  getCurrentPrice: vi.fn().mockReturnValue({ price: 50000, timestamp: Date.now() }),
}));

vi.mock('../../position-manager/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../order-manager/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../safety/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true, autoStopped: false }),
  setOrderManager: vi.fn(),
  checkDrawdownLimit: vi.fn().mockReturnValue({ breached: false, current: 0, limit: 0.05, autoStopped: false }),
  isAutoStopped: vi.fn().mockReturnValue(false),
}));

vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks
import * as orchestrator from '../index.js';
import persistence from '../../../persistence/index.js';
import * as polymarket from '../../../clients/polymarket/index.js';
import * as spot from '../../../clients/spot/index.js';
import * as positionManager from '../../position-manager/index.js';
import * as orderManager from '../../order-manager/index.js';
import { OrchestratorErrorCodes, OrchestratorState } from '../types.js';

// Test configuration
const mockConfig = {
  database: { path: ':memory:' },
  polymarket: { apiKey: 'test-key' },
  spot: { hermesUrl: 'test-url' },
  orchestrator: {
    tickIntervalMs: 100,
    moduleInitTimeoutMs: 1000,
    moduleShutdownTimeoutMs: 1000,
  },
};

describe('Orchestrator Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module state
    await orchestrator.shutdown();
  });

  afterEach(async () => {
    await orchestrator.shutdown();
  });

  describe('init()', () => {
    it('initializes all modules in correct order', async () => {
      const initOrder = [];

      persistence.init.mockImplementation(() => {
        initOrder.push('persistence');
        return Promise.resolve();
      });
      polymarket.init.mockImplementation(() => {
        initOrder.push('polymarket');
        return Promise.resolve();
      });
      spot.init.mockImplementation(() => {
        initOrder.push('spot');
        return Promise.resolve();
      });
      positionManager.init.mockImplementation(() => {
        initOrder.push('position-manager');
        return Promise.resolve();
      });
      orderManager.init.mockImplementation(() => {
        initOrder.push('order-manager');
        return Promise.resolve();
      });

      await orchestrator.init(mockConfig);

      expect(initOrder).toEqual([
        'persistence',
        'polymarket',
        'spot',
        'position-manager',
        'order-manager',
      ]);
    });

    it('passes correct config slice to each module', async () => {
      await orchestrator.init(mockConfig);

      // Persistence receives database config
      expect(persistence.init).toHaveBeenCalledWith(
        expect.objectContaining({
          database: mockConfig.database,
        })
      );

      // Polymarket receives polymarket config
      expect(polymarket.init).toHaveBeenCalledWith(
        expect.objectContaining({
          polymarket: mockConfig.polymarket,
        })
      );

      // Spot receives spot config
      expect(spot.init).toHaveBeenCalledWith(
        expect.objectContaining({
          spot: mockConfig.spot,
        })
      );
    });

    it('handles module initialization failure', async () => {
      persistence.init.mockRejectedValueOnce(new Error('DB init failed'));

      await expect(orchestrator.init(mockConfig)).rejects.toThrow(
        'Failed to initialize module: persistence'
      );

      const state = orchestrator.getState();
      expect(state.state).toBe(OrchestratorState.ERROR);
    });

    it('throws if already initialized', async () => {
      await orchestrator.init(mockConfig);

      await expect(orchestrator.init(mockConfig)).rejects.toThrow(
        'Orchestrator already initialized'
      );
    });

    it('updates state to initialized on success', async () => {
      const stateBefore = orchestrator.getState();
      expect(stateBefore.initialized).toBe(false);

      await orchestrator.init(mockConfig);

      const stateAfter = orchestrator.getState();
      expect(stateAfter.initialized).toBe(true);
      expect(stateAfter.state).toBe(OrchestratorState.INITIALIZED);
    });

    it('handles initialization timeout', async () => {
      const slowConfig = {
        ...mockConfig,
        orchestrator: { ...mockConfig.orchestrator, moduleInitTimeoutMs: 10 },
      };

      persistence.init.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      // Should throw with wrapped error containing 'timeout' message
      await expect(orchestrator.init(slowConfig)).rejects.toThrow('Failed to initialize module');
    });
  });

  describe('start()', () => {
    beforeEach(async () => {
      await orchestrator.init(mockConfig);
    });

    it('starts the execution loop', () => {
      orchestrator.start();

      const state = orchestrator.getState();
      expect(state.running).toBe(true);
      expect(state.state).toBe(OrchestratorState.RUNNING);
    });

    it('throws if not initialized', async () => {
      await orchestrator.shutdown();

      expect(() => orchestrator.start()).toThrow('Orchestrator not initialized');
    });

    it('is idempotent - multiple calls do not error', () => {
      orchestrator.start();
      orchestrator.start(); // Should not throw

      expect(orchestrator.getState().running).toBe(true);
    });
  });

  describe('stop()', () => {
    beforeEach(async () => {
      await orchestrator.init(mockConfig);
      orchestrator.start();
    });

    it('stops the execution loop', () => {
      expect(orchestrator.getState().running).toBe(true);

      orchestrator.stop();

      expect(orchestrator.getState().running).toBe(false);
    });

    it('changes state from running to initialized', () => {
      expect(orchestrator.getState().state).toBe(OrchestratorState.RUNNING);

      orchestrator.stop();

      expect(orchestrator.getState().state).toBe(OrchestratorState.INITIALIZED);
    });
  });

  describe('pause()', () => {
    beforeEach(async () => {
      await orchestrator.init(mockConfig);
      orchestrator.start();
    });

    it('pauses the execution loop without stopping', () => {
      orchestrator.pause();

      const state = orchestrator.getState();
      expect(state.paused).toBe(true);
      expect(state.state).toBe(OrchestratorState.PAUSED);
    });

    it('throws if not initialized', async () => {
      await orchestrator.shutdown();

      expect(() => orchestrator.pause()).toThrow('Orchestrator not initialized');
    });
  });

  describe('resume()', () => {
    beforeEach(async () => {
      await orchestrator.init(mockConfig);
      orchestrator.start();
      orchestrator.pause();
    });

    it('resumes a paused execution loop', () => {
      expect(orchestrator.getState().paused).toBe(true);

      orchestrator.resume();

      expect(orchestrator.getState().running).toBe(true);
      expect(orchestrator.getState().paused).toBe(false);
    });

    it('throws if not initialized', async () => {
      await orchestrator.shutdown();

      expect(() => orchestrator.resume()).toThrow('Orchestrator not initialized');
    });
  });

  describe('getState()', () => {
    it('returns initialized=false before init', () => {
      const state = orchestrator.getState();
      expect(state.initialized).toBe(false);
      expect(state.state).toBe(OrchestratorState.STOPPED);
    });

    it('returns complete state after init', async () => {
      await orchestrator.init(mockConfig);

      const state = orchestrator.getState();

      expect(state.initialized).toBe(true);
      expect(state.state).toBe(OrchestratorState.INITIALIZED);
      expect(state.modules).toBeDefined();
      expect(state.errorCount).toBe(0);
      expect(state.startedAt).toBeDefined();
    });

    it('aggregates module states', async () => {
      await orchestrator.init(mockConfig);

      const state = orchestrator.getState();

      expect(state.modules.persistence).toBeDefined();
      expect(state.modules.polymarket).toBeDefined();
      expect(state.modules.spot).toBeDefined();
      expect(state.modules['position-manager']).toBeDefined();
      expect(state.modules['order-manager']).toBeDefined();
    });

    it('includes loop metrics when running', async () => {
      await orchestrator.init(mockConfig);
      orchestrator.start();

      // Wait for at least one tick
      await new Promise((resolve) => setTimeout(resolve, 150));

      const state = orchestrator.getState();

      expect(state.loop).toBeDefined();
      expect(state.loop.tickCount).toBeGreaterThanOrEqual(1);
      expect(state.loop.lastTickAt).toBeDefined();
    });

    it('includes error metrics', async () => {
      await orchestrator.init(mockConfig);

      const state = orchestrator.getState();

      expect(state.errorCount).toBe(0);
      expect(state.recoveryCount).toBe(0);
      expect(state.lastError).toBeNull();
    });
  });

  describe('shutdown()', () => {
    beforeEach(async () => {
      await orchestrator.init(mockConfig);
    });

    it('shuts down modules in reverse initialization order', async () => {
      const shutdownOrder = [];

      persistence.shutdown.mockImplementation(() => {
        shutdownOrder.push('persistence');
        return Promise.resolve();
      });
      polymarket.shutdown.mockImplementation(() => {
        shutdownOrder.push('polymarket');
        return Promise.resolve();
      });
      spot.shutdown.mockImplementation(() => {
        shutdownOrder.push('spot');
        return Promise.resolve();
      });
      positionManager.shutdown.mockImplementation(() => {
        shutdownOrder.push('position-manager');
        return Promise.resolve();
      });
      orderManager.shutdown.mockImplementation(() => {
        shutdownOrder.push('order-manager');
        return Promise.resolve();
      });

      await orchestrator.shutdown();

      expect(shutdownOrder).toEqual([
        'order-manager',
        'position-manager',
        'spot',
        'polymarket',
        'persistence',
      ]);
    });

    it('stops execution loop before module shutdown', async () => {
      orchestrator.start();
      expect(orchestrator.getState().running).toBe(true);

      await orchestrator.shutdown();

      expect(orchestrator.getState().running).toBe(false);
    });

    it('handles module shutdown timeout gracefully', async () => {
      const slowConfig = {
        ...mockConfig,
        orchestrator: { ...mockConfig.orchestrator, moduleShutdownTimeoutMs: 10 },
      };

      await orchestrator.shutdown();
      await orchestrator.init(slowConfig);

      orderManager.shutdown.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      // Should complete without throwing
      await orchestrator.shutdown();

      // State should be reset
      expect(orchestrator.getState().initialized).toBe(false);
    });

    it('is idempotent - can be called multiple times', async () => {
      await orchestrator.shutdown();
      await orchestrator.shutdown();

      expect(orchestrator.getState().initialized).toBe(false);
    });

    it('clears all module references', async () => {
      expect(orchestrator.getState().modules.persistence).toBeDefined();

      await orchestrator.shutdown();

      expect(orchestrator.getState().modules).toEqual({});
    });
  });
});
