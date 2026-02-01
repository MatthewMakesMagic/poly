/**
 * Scout State Management Tests
 *
 * Story E.3: Tests for paper/live count tracking
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as state from '../state.js';

describe('Scout State', () => {
  beforeEach(() => {
    state.resetState();
  });

  describe('paper/live signal tracking (Story E.3)', () => {
    it('should initialize paper and live counts to zero', () => {
      const snapshot = state.getStateSnapshot();

      expect(snapshot.paperSignalCount).toBe(0);
      expect(snapshot.liveOrderCount).toBe(0);
    });

    it('should increment paper signal count', () => {
      state.incrementPaperSignal();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.paperSignalCount).toBe(1);
    });

    it('should increment live order count', () => {
      state.incrementLiveOrder();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.liveOrderCount).toBe(1);
    });

    it('should track multiple paper signals', () => {
      state.incrementPaperSignal();
      state.incrementPaperSignal();
      state.incrementPaperSignal();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.paperSignalCount).toBe(3);
    });

    it('should track multiple live orders', () => {
      state.incrementLiveOrder();
      state.incrementLiveOrder();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.liveOrderCount).toBe(2);
    });

    it('should track paper and live counts independently', () => {
      state.incrementPaperSignal();
      state.incrementPaperSignal();
      state.incrementLiveOrder();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.paperSignalCount).toBe(2);
      expect(snapshot.liveOrderCount).toBe(1);
    });

    it('should reset paper/live counts on state reset', () => {
      state.incrementPaperSignal();
      state.incrementLiveOrder();

      state.resetState();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.paperSignalCount).toBe(0);
      expect(snapshot.liveOrderCount).toBe(0);
    });

    it('should include paper/live counts in stats', () => {
      state.incrementPaperSignal();
      state.incrementLiveOrder();

      const stats = state.getStats();
      expect(stats.paperSignalCount).toBe(1);
      expect(stats.liveOrderCount).toBe(1);
    });
  });

  describe('trading mode tracking (Story E.3)', () => {
    it('should initialize trading mode to null', () => {
      const snapshot = state.getStateSnapshot();

      expect(snapshot.tradingMode).toBeNull();
    });

    it('should set trading mode to PAPER', () => {
      state.setTradingMode('PAPER');

      const snapshot = state.getStateSnapshot();
      expect(snapshot.tradingMode).toBe('PAPER');
    });

    it('should set trading mode to LIVE', () => {
      state.setTradingMode('LIVE');

      const snapshot = state.getStateSnapshot();
      expect(snapshot.tradingMode).toBe('LIVE');
    });

    it('should get current trading mode', () => {
      state.setTradingMode('PAPER');

      expect(state.getTradingMode()).toBe('PAPER');
    });

    it('should reset trading mode on state reset', () => {
      state.setTradingMode('LIVE');

      state.resetState();

      const snapshot = state.getStateSnapshot();
      expect(snapshot.tradingMode).toBeNull();
    });
  });
});
