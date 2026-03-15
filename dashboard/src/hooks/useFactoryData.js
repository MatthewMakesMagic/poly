/**
 * Custom data-fetching hooks for Factory API endpoints.
 * Follows the existing useState + useEffect + useCallback pattern
 * from BacktestReview.jsx — no external dependencies.
 *
 * @module hooks/useFactoryData
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.ok === false) throw new Error(json.error || 'Unknown API error');
  return json;
}

function buildQuery(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// useFactoryRuns
// ---------------------------------------------------------------------------

/**
 * Fetch paginated factory runs list.
 * Polls every 30s when any run has status 'running'.
 */
export function useFactoryRuns(filters = {}) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({});
  const pollRef = useRef(null);

  const fetchRuns = useCallback(async () => {
    try {
      setLoading(true);
      const qs = buildQuery(filters);
      const json = await apiFetch(`/api/factory/runs${qs}`);
      setRuns(json.data?.runs || []);
      setMeta(json.meta || {});
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(filters)]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // Polling: if any run is 'running', poll every 30s
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const hasRunning = runs.some(r => r.status === 'running');
    if (hasRunning) {
      pollRef.current = setInterval(fetchRuns, 30000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [runs, fetchRuns]);

  return { runs, loading, error, meta, refetch: fetchRuns };
}

// ---------------------------------------------------------------------------
// useFactoryResults
// ---------------------------------------------------------------------------

/**
 * Fetch results for a specific factory run.
 */
export function useFactoryResults(runId, params = {}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchResults = useCallback(async () => {
    if (!runId) return;
    try {
      setLoading(true);
      const qs = buildQuery(params);
      const json = await apiFetch(`/api/factory/runs/${runId}/results${qs}`);
      setResults(json.data?.results || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [runId, JSON.stringify(params)]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  return { results, loading, error, refetch: fetchResults };
}

// ---------------------------------------------------------------------------
// useLeaderboard
// ---------------------------------------------------------------------------

/**
 * Fetch the leaderboard (top strategies across all runs).
 */
export function useLeaderboard(options = {}) {
  const [strategies, setStrategies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchLeaderboard = useCallback(async () => {
    try {
      setLoading(true);
      const qs = buildQuery(options);
      const json = await apiFetch(`/api/factory/leaderboard${qs}`);
      setStrategies(json.data?.strategies || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [JSON.stringify(options)]);

  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  return { strategies, loading, error, refetch: fetchLeaderboard };
}

// ---------------------------------------------------------------------------
// useStrategyLineage
// ---------------------------------------------------------------------------

/**
 * Fetch lineage tree for a strategy.
 */
export function useStrategyLineage(name) {
  const [lineage, setLineage] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchLineage = useCallback(async () => {
    if (!name) return;
    try {
      setLoading(true);
      const json = await apiFetch(`/api/factory/strategies/${encodeURIComponent(name)}/lineage`);
      setLineage(json.data?.lineage || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    fetchLineage();
  }, [fetchLineage]);

  return { lineage, loading, error, refetch: fetchLineage };
}

// ---------------------------------------------------------------------------
// useStrategyResults
// ---------------------------------------------------------------------------

/**
 * Fetch all results for a specific strategy name across runs.
 */
export function useStrategyResults(name, params = {}) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchResults = useCallback(async () => {
    if (!name) return;
    try {
      setLoading(true);
      const qs = buildQuery(params);
      const json = await apiFetch(`/api/factory/strategies/${encodeURIComponent(name)}/results${qs}`);
      setResults(json.data?.results || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [name, JSON.stringify(params)]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  return { results, loading, error, refetch: fetchResults };
}

// ---------------------------------------------------------------------------
// useDataCoverage
// ---------------------------------------------------------------------------

/**
 * Fetch data coverage summary per symbol.
 */
export function useDataCoverage() {
  const [coverage, setCoverage] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchCoverage = useCallback(async () => {
    try {
      setLoading(true);
      const json = await apiFetch('/api/factory/coverage');
      setCoverage(json.data?.coverage || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCoverage();
  }, [fetchCoverage]);

  return { coverage, loading, error, refetch: fetchCoverage };
}

// ---------------------------------------------------------------------------
// useCompare
// ---------------------------------------------------------------------------

/**
 * Fetch side-by-side comparison of specific result IDs.
 */
export function useCompare(resultIds = []) {
  const [comparison, setComparison] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchCompare = useCallback(async () => {
    if (!resultIds.length) return;
    try {
      setLoading(true);
      const json = await apiFetch(`/api/factory/compare?ids=${resultIds.join(',')}`);
      setComparison(json.data?.comparison || []);
      setWarnings(json.data?.warnings || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [resultIds.join(',')]);

  useEffect(() => {
    fetchCompare();
  }, [fetchCompare]);

  return { comparison, warnings, loading, error, refetch: fetchCompare };
}
