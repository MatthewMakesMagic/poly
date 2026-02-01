/**
 * Orchestrator State Error Tracking Tests
 *
 * Tests for the error timestamp tracking functions used by the health endpoint.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordError,
  getErrorCount1m,
  clearErrorTimestamps,
} from '../state.js';

describe('Error Tracking', () => {
  beforeEach(() => {
    // Clear error timestamps before each test
    clearErrorTimestamps();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recordError()', () => {
    it('should record error timestamp', () => {
      recordError();

      expect(getErrorCount1m()).toBe(1);
    });

    it('should record multiple errors', () => {
      recordError();
      recordError();
      recordError();

      expect(getErrorCount1m()).toBe(3);
    });
  });

  describe('getErrorCount1m()', () => {
    it('should return 0 when no errors recorded', () => {
      expect(getErrorCount1m()).toBe(0);
    });

    it('should count only errors in last 60 seconds', () => {
      // Record 3 errors now
      recordError();
      recordError();
      recordError();

      expect(getErrorCount1m()).toBe(3);

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30 * 1000);

      // Still 3 errors
      expect(getErrorCount1m()).toBe(3);

      // Advance time by 31 more seconds (total 61 seconds)
      vi.advanceTimersByTime(31 * 1000);

      // All errors now older than 1 minute
      expect(getErrorCount1m()).toBe(0);
    });

    it('should correctly count mixed old and new errors', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Record error at t=0
      recordError();

      // Advance 30 seconds and record another
      vi.advanceTimersByTime(30 * 1000);
      recordError();

      // Advance 31 more seconds (first error is now 61s old, second is 31s old)
      vi.advanceTimersByTime(31 * 1000);

      // Only the second error should be counted
      expect(getErrorCount1m()).toBe(1);
    });
  });

  describe('error timestamp pruning', () => {
    it('should prune timestamps older than 5 minutes on recordError', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Record an error
      recordError();

      // Advance 6 minutes
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Record another error - this should trigger pruning
      recordError();

      // The 1-minute count should only show the new error
      expect(getErrorCount1m()).toBe(1);
    });

    it('should enforce hard cap of 1000 timestamps to prevent memory exhaustion', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Record more errors than the cap (simulate error storm)
      for (let i = 0; i < 1500; i++) {
        recordError();
      }

      // Despite recording 1500 errors, should be capped
      // We can't directly check array length, but we can verify
      // that getErrorCount1m still works and returns a reasonable count
      const count = getErrorCount1m();

      // All 1500 errors happened "now", so all should be within 1 minute
      // But due to the cap, we should have at most 1000
      expect(count).toBeLessThanOrEqual(1000);
      expect(count).toBeGreaterThan(0);
    });
  });
});
