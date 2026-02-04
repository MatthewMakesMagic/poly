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

vi.mock('../../window-manager/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
  getActiveWindows: vi.fn().mockReturnValue([]),
}));

vi.mock('../../position-manager/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
  getPositions: vi.fn().mockReturnValue([]),  // Story 8-9: For safeguards init
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

// V3 Stage 4: Safeguards module mock (async DB-backed operations)
vi.mock('../../position-manager/safeguards.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ initialized: true, config: {}, stats: { entries_confirmed: 0, entries_reserved: 0, tick_entry_count: 0 } }),
  canEnterPosition: vi.fn().mockResolvedValue({ allowed: true }),
  recordEntry: vi.fn().mockResolvedValue(undefined),
  reserveEntry: vi.fn().mockResolvedValue(true),
  confirmEntry: vi.fn().mockResolvedValue(true),
  releaseEntry: vi.fn().mockResolvedValue(true),
  removeEntry: vi.fn().mockResolvedValue(true),
  resetTickEntries: vi.fn(),
  resetState: vi.fn().mockResolvedValue(undefined),
  hasEnteredWindow: vi.fn().mockResolvedValue(false),
  getTimeSinceLastEntry: vi.fn().mockResolvedValue(null),
  getTickEntryCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../../launch-config/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({
    initialized: true,
    manifest: {
      strategies: ['simple-threshold'],
      position_size_dollars: 10,
      max_exposure_dollars: 500,
      symbols: ['BTC', 'ETH'],
      kill_switch_enabled: true,
    },
  }),
  loadManifest: vi.fn().mockReturnValue({
    strategies: ['simple-threshold'],
    position_size_dollars: 10,
    max_exposure_dollars: 500,
    symbols: ['BTC', 'ETH'],
    kill_switch_enabled: true,
  }),
  updateManifest: vi.fn().mockReturnValue({
    strategies: ['simple-threshold'],
    position_size_dollars: 10,
    max_exposure_dollars: 500,
    symbols: ['BTC', 'ETH'],
    kill_switch_enabled: true,
  }),
  listAvailableStrategies: vi.fn().mockReturnValue([
    { name: 'simple-threshold', description: '70% threshold', dependencies: ['Epic 3'] },
    { name: 'oracle-edge', description: 'Staleness fade', dependencies: ['Epic 7'] },
  ]),
}));

vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Strategy modules (from MODULE_INIT_ORDER)
vi.mock('../../strategy-evaluator/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
  evaluateStrategy: vi.fn().mockReturnValue({ signals: [] }),
}));

vi.mock('../../position-sizer/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
  calculateSize: vi.fn().mockReturnValue({ size: 10 }),
}));

vi.mock('../../stop-loss/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../take-profit/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../window-expiry/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../trade-event/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

// Virtual position manager (PAPER mode position tracking)
vi.mock('../../virtual-position-manager/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({
    initialized: true,
    stats: { total_positions: 0, open_positions: 0, closed_positions: 0 },
  }),
  createVirtualPosition: vi.fn().mockReturnValue({ id: 'vp-1', status: 'open' }),
  getPositions: vi.fn().mockReturnValue([]),
  getPosition: vi.fn().mockReturnValue(null),
  updatePrice: vi.fn(),
  closePosition: vi.fn(),
}));

// Strategy composition modules (Story 7-12)
vi.mock('../../strategy/loader.js', () => ({
  loadAllStrategies: vi.fn().mockResolvedValue([]),
  getLoadedStrategy: vi.fn().mockReturnValue(null),
  setActiveStrategy: vi.fn(),
  getActiveStrategy: vi.fn().mockReturnValue(null),
  getActiveStrategyName: vi.fn().mockReturnValue(null),
  listLoadedStrategies: vi.fn().mockReturnValue([]),
}));

vi.mock('../../strategy/logic.js', () => ({
  discoverComponents: vi.fn().mockResolvedValue({ strategies: [], composites: [] }),
}));

vi.mock('../../strategy/state.js', () => ({
  setCatalog: vi.fn(),
  getCatalog: vi.fn().mockReturnValue(null),
}));

// V3 Phase 5: Data capture module mocks
vi.mock('../../tick-logger/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../oracle-tracker/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../divergence-tracker/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../lag-tracker/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../signal-outcome-logger/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../quality-gate/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../window-close-event-recorder/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../partition-manager/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../order-book-collector/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

// Stale order evaluator mock
vi.mock('../../stale-order-evaluator/index.js', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({ initialized: true }),
}));

vi.mock('../../../../kill-switch/state-snapshot.js', () => ({
  writeSnapshot: vi.fn().mockResolvedValue(undefined),
  buildSnapshot: vi.fn().mockReturnValue({
    version: 1,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    forced_kill: false,
    stale_warning: false,
    positions: [],
    orders: [],
    summary: { open_positions: 0, open_orders: 0, total_exposure: 0 },
  }),
}));

// Import after mocks
import * as orchestrator from '../index.js';
import persistence from '../../../persistence/index.js';
import * as polymarket from '../../../clients/polymarket/index.js';
import * as spot from '../../../clients/spot/index.js';
import * as positionManager from '../../position-manager/index.js';
import * as orderManager from '../../order-manager/index.js';
import * as launchConfig from '../../launch-config/index.js';
import { OrchestratorErrorCodes, OrchestratorState } from '../types.js';
import { writeSnapshot, buildSnapshot } from '../../../../kill-switch/state-snapshot.js';

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

  describe('Periodic State Updates', () => {
    it('starts periodic state updates after init', async () => {
      const configWithShortInterval = {
        ...mockConfig,
        killSwitch: { stateUpdateIntervalMs: 50 },
      };

      await orchestrator.init(configWithShortInterval);

      // Wait for at least 2 intervals
      await new Promise((resolve) => setTimeout(resolve, 120));

      // writeSnapshot should have been called at least once
      expect(writeSnapshot).toHaveBeenCalled();
    });

    it('stops periodic state updates on shutdown', async () => {
      const configWithShortInterval = {
        ...mockConfig,
        killSwitch: { stateUpdateIntervalMs: 50 },
      };

      await orchestrator.init(configWithShortInterval);

      // Wait for at least one update
      await new Promise((resolve) => setTimeout(resolve, 60));

      const callCountBeforeShutdown = writeSnapshot.mock.calls.length;

      await orchestrator.shutdown();

      // Wait to ensure no more updates
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not have more calls after shutdown (allow +1 for final snapshot)
      expect(writeSnapshot.mock.calls.length).toBeLessThanOrEqual(callCountBeforeShutdown + 1);
    });

    it('writes final state snapshot on graceful shutdown', async () => {
      await orchestrator.init(mockConfig);
      writeSnapshot.mockClear();

      await orchestrator.shutdown();

      // Final snapshot should be written
      expect(writeSnapshot).toHaveBeenCalled();
    });

    it('handles writeSnapshot failure without blocking', async () => {
      const configWithShortInterval = {
        ...mockConfig,
        killSwitch: { stateUpdateIntervalMs: 50 },
      };

      writeSnapshot.mockRejectedValueOnce(new Error('Write failed'));

      await orchestrator.init(configWithShortInterval);

      // Wait for the failed write
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Should still be running (not crashed)
      expect(orchestrator.getState().state).toBe(OrchestratorState.INITIALIZED);
    });
  });

  describe('Launch Manifest Integration (Story 8-1)', () => {
    it('initializes launch-config module first in order', async () => {
      const initOrder = [];

      launchConfig.init.mockImplementation(() => {
        initOrder.push('launch-config');
        return Promise.resolve();
      });
      persistence.init.mockImplementation(() => {
        initOrder.push('persistence');
        return Promise.resolve();
      });

      await orchestrator.init(mockConfig);

      // launch-config should be first
      expect(initOrder[0]).toBe('launch-config');
    });

    it('loads manifest after launch-config init', async () => {
      await orchestrator.init(mockConfig);

      // loadManifest should have been called
      expect(launchConfig.loadManifest).toHaveBeenCalled();
    });

    it('exposes manifest in orchestrator state', async () => {
      await orchestrator.init(mockConfig);

      const state = orchestrator.getState();
      expect(state.manifest).toBeDefined();
      expect(state.manifest.strategies).toContain('simple-threshold');
    });

    it('exposes loadedStrategies from manifest', async () => {
      await orchestrator.init(mockConfig);

      const state = orchestrator.getState();
      expect(state.loadedStrategies).toEqual(['simple-threshold']);
    });

    it('handles manifest load failure gracefully', async () => {
      launchConfig.loadManifest.mockImplementationOnce(() => {
        throw new Error('Manifest not found');
      });

      // Should not throw - graceful degradation
      await orchestrator.init(mockConfig);

      const state = orchestrator.getState();
      // Manifest will be null but system still works
      expect(state.state).toBe(OrchestratorState.INITIALIZED);
    });

    it('provides getAllowedStrategies() from manifest', async () => {
      await orchestrator.init(mockConfig);

      const allowed = orchestrator.getAllowedStrategies();
      expect(allowed).toEqual(['simple-threshold']);
    });

    it('getLoadedManifest returns cloned manifest', async () => {
      await orchestrator.init(mockConfig);

      const manifest = orchestrator.getLoadedManifest();
      expect(manifest.strategies).toEqual(['simple-threshold']);
      expect(manifest.position_size_dollars).toBe(10);
    });
  });
});
