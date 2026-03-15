/**
 * Unit tests for useFactoryData hooks.
 * Uses the setupMockApi() fetch interceptor with fixture data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { setupMockApi, teardownMockApi } from '../mocks/setup-mock-api.js';
import {
  useFactoryRuns,
  useLeaderboard,
  useStrategyLineage,
  useFactoryResults,
  useDataCoverage,
  useCompare,
} from '../../../hooks/useFactoryData.js';

describe('useFactoryData hooks', () => {
  beforeEach(() => setupMockApi());
  afterEach(() => teardownMockApi());

  describe('useFactoryRuns', () => {
    it('returns runs array after loading', async () => {
      const { result } = renderHook(() => useFactoryRuns());
      expect(result.current.loading).toBe(true);

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.runs.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('useLeaderboard', () => {
    it('returns strategies sorted by Sharpe', async () => {
      const { result } = renderHook(() => useLeaderboard());

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.strategies.length).toBeGreaterThan(0);

      // Verify sorted desc
      const sharpes = result.current.strategies.map(s => s.metrics.sharpe);
      for (let i = 1; i < sharpes.length; i++) {
        expect(sharpes[i]).toBeLessThanOrEqual(sharpes[i - 1]);
      }
    });
  });

  describe('useStrategyLineage', () => {
    it('returns lineage chain for a known strategy', async () => {
      const { result } = renderHook(() => useStrategyLineage('deficit-asymmetry-v1'));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.lineage.length).toBeGreaterThanOrEqual(3);
      expect(result.current.lineage[0].strategy_name).toBe('deficit-asymmetry-v1');
    });

    it('does not fetch when name is null', async () => {
      const { result } = renderHook(() => useStrategyLineage(null));
      // Should stay in loading state since no fetch happens
      expect(result.current.lineage).toEqual([]);
    });
  });

  describe('useFactoryResults', () => {
    it('returns results for a given run', async () => {
      const { result } = renderHook(() => useFactoryResults(1));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.results.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('useDataCoverage', () => {
    it('returns coverage data per symbol', async () => {
      const { result } = renderHook(() => useDataCoverage());

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.coverage.length).toBeGreaterThan(0);
      expect(result.current.coverage[0]).toHaveProperty('symbol');
      expect(result.current.coverage[0]).toHaveProperty('totalResults');
    });
  });

  describe('useCompare', () => {
    it('returns comparison rows and warnings for mismatched sample sizes', async () => {
      const { result } = renderHook(() => useCompare([1, 5]));

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeNull();
      expect(result.current.comparison.length).toBe(2);
      expect(result.current.warnings.length).toBeGreaterThan(0);
    });
  });
});
