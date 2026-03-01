/**
 * Runtime Controls Module Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies
vi.mock('../../../persistence/index.js', () => ({
  default: {
    run: vi.fn().mockResolvedValue({ changes: 1 }),
    all: vi.fn().mockResolvedValue([
      { key: 'kill_switch', value: 'off' },
      { key: 'trading_mode', value: 'PAPER' },
      { key: 'max_position_usd', value: '5' },
      { key: 'max_session_loss', value: '20' },
      { key: 'allowed_instruments', value: '*' },
      { key: 'allowed_strategies', value: '*' },
    ]),
  },
}));

vi.mock('../../logger/index.js', () => ({
  child: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as runtimeControls from '../index.js';
import persistence from '../../../persistence/index.js';

describe('Runtime Controls Module', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await runtimeControls.shutdown();
    // Reset persistence mock
    persistence.all.mockResolvedValue([
      { key: 'kill_switch', value: 'off' },
      { key: 'trading_mode', value: 'PAPER' },
      { key: 'max_position_usd', value: '5' },
      { key: 'max_session_loss', value: '20' },
      { key: 'allowed_instruments', value: '*' },
      { key: 'allowed_strategies', value: '*' },
    ]);
  });

  describe('init()', () => {
    it('initializes and pre-warms cache', async () => {
      await runtimeControls.init({});
      expect(runtimeControls.getState().initialized).toBe(true);
      expect(runtimeControls.getState().cached).toBe(true);
      expect(persistence.all).toHaveBeenCalledOnce();
    });

    it('is idempotent', async () => {
      await runtimeControls.init({});
      await runtimeControls.init({});
      expect(runtimeControls.getState().initialized).toBe(true);
      // Should only query DB once (first init)
      expect(persistence.all).toHaveBeenCalledOnce();
    });
  });

  describe('getControl()', () => {
    it('returns a single control value', async () => {
      await runtimeControls.init({});
      const value = await runtimeControls.getControl('kill_switch');
      expect(value).toBe('off');
    });

    it('returns null for unknown key', async () => {
      await runtimeControls.init({});
      const value = await runtimeControls.getControl('nonexistent');
      expect(value).toBeNull();
    });
  });

  describe('getAllControls()', () => {
    it('returns all controls as a map', async () => {
      await runtimeControls.init({});
      const controls = await runtimeControls.getAllControls();
      expect(controls).toEqual({
        kill_switch: 'off',
        trading_mode: 'PAPER',
        max_position_usd: '5',
        max_session_loss: '20',
        allowed_instruments: '*',
        allowed_strategies: '*',
      });
    });

    it('uses cache within TTL', async () => {
      await runtimeControls.init({});
      // First call populates cache (during init)
      expect(persistence.all).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await runtimeControls.getAllControls();
      expect(persistence.all).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateControl()', () => {
    it('updates a control value in DB', async () => {
      await runtimeControls.init({});
      const result = await runtimeControls.updateControl('kill_switch', 'pause');
      expect(result.key).toBe('kill_switch');
      expect(result.value).toBe('pause');
      expect(persistence.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO runtime_controls'),
        ['kill_switch', 'pause']
      );
    });

    it('invalidates cache after update', async () => {
      await runtimeControls.init({});
      expect(runtimeControls.getState().cached).toBe(true);

      await runtimeControls.updateControl('kill_switch', 'pause');
      expect(runtimeControls.getState().cached).toBe(false);
    });

    it('rejects invalid kill_switch value', async () => {
      await runtimeControls.init({});
      await expect(
        runtimeControls.updateControl('kill_switch', 'invalid')
      ).rejects.toThrow('Invalid kill_switch value');
    });

    it('rejects invalid trading_mode value', async () => {
      await runtimeControls.init({});
      await expect(
        runtimeControls.updateControl('trading_mode', 'YOLO')
      ).rejects.toThrow('Invalid trading_mode value');
    });

    it('rejects non-string key', async () => {
      await runtimeControls.init({});
      await expect(
        runtimeControls.updateControl('', 'value')
      ).rejects.toThrow('key must be a non-empty string');
    });

    it('rejects non-string value', async () => {
      await runtimeControls.init({});
      await expect(
        runtimeControls.updateControl('key', 123)
      ).rejects.toThrow('value must be a string');
    });

    it('allows valid kill_switch levels', async () => {
      await runtimeControls.init({});
      for (const level of ['off', 'pause', 'flatten', 'emergency']) {
        const result = await runtimeControls.updateControl('kill_switch', level);
        expect(result.value).toBe(level);
      }
    });
  });

  describe('isKillSwitchActive()', () => {
    it('returns false when kill_switch is off', async () => {
      await runtimeControls.init({});
      expect(await runtimeControls.isKillSwitchActive()).toBe(false);
    });

    it('returns true when kill_switch is pause', async () => {
      persistence.all.mockResolvedValue([
        { key: 'kill_switch', value: 'pause' },
      ]);
      await runtimeControls.init({});
      expect(await runtimeControls.isKillSwitchActive()).toBe(true);
    });
  });

  describe('getKillSwitchLevel()', () => {
    it('returns current kill switch level', async () => {
      await runtimeControls.init({});
      expect(await runtimeControls.getKillSwitchLevel()).toBe('off');
    });
  });

  describe('getTradingMode()', () => {
    it('returns current trading mode', async () => {
      await runtimeControls.init({});
      expect(await runtimeControls.getTradingMode()).toBe('PAPER');
    });

    it('returns LIVE when set to LIVE', async () => {
      persistence.all.mockResolvedValue([
        { key: 'trading_mode', value: 'LIVE' },
      ]);
      await runtimeControls.init({});
      expect(await runtimeControls.getTradingMode()).toBe('LIVE');
    });
  });

  describe('getState()', () => {
    it('returns uninitialized state', () => {
      const state = runtimeControls.getState();
      expect(state.initialized).toBe(false);
      expect(state.cached).toBe(false);
    });

    it('returns initialized state with cache info', async () => {
      await runtimeControls.init({});
      const state = runtimeControls.getState();
      expect(state.initialized).toBe(true);
      expect(state.cached).toBe(true);
      expect(state.cacheAgeMs).toBeGreaterThanOrEqual(0);
      expect(state.controls.kill_switch).toBe('off');
    });
  });

  describe('shutdown()', () => {
    it('resets state', async () => {
      await runtimeControls.init({});
      expect(runtimeControls.getState().initialized).toBe(true);

      await runtimeControls.shutdown();
      expect(runtimeControls.getState().initialized).toBe(false);
      expect(runtimeControls.getState().cached).toBe(false);
    });
  });
});
