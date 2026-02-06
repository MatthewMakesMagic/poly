/**
 * Health Endpoint Module
 *
 * Provides the health status functionality for the /api/live/status endpoint.
 * This module reads state from the orchestrator and module instances.
 *
 * @module scripts/health-endpoint
 */

import * as orchestrator from '../src/modules/orchestrator/index.js';

/**
 * Get connection status for all services
 *
 * Health endpoint should NEVER throw - returns 'unknown' on any error.
 *
 * @returns {Object} Connection status for database, rtds, and polymarket
 */
export function getConnectionStatus() {
  try {
    const state = orchestrator.getState();
    const modules = state.modules || {};

    return {
      database: modules.persistence?.initialized ? 'connected' : (modules.persistence ? 'disconnected' : 'unknown'),
      rtds: modules['rtds-client']?.connected ? 'connected' : (modules['rtds-client'] ? 'disconnected' : 'unknown'),
      polymarket: modules.polymarket?.authenticated ? 'authenticated' : (modules.polymarket ? 'disconnected' : 'unknown'),
    };
  } catch {
    // Health endpoint should never throw - return unknown state
    return {
      database: 'unknown',
      rtds: 'unknown',
      polymarket: 'unknown',
    };
  }
}

/**
 * Determine overall health status based on various factors
 *
 * @param {Object} connections - Connection status for services
 * @param {number} errorCount1m - Number of errors in last minute
 * @param {string|null} lastTick - ISO timestamp of last tick received
 * @returns {string} Health status: 'healthy', 'degraded', or 'unhealthy'
 */
export function determineHealthStatus(connections, errorCount1m, lastTick) {
  // Check if database is down - this is critical
  if (connections.database === 'disconnected') {
    return 'unhealthy';
  }

  // Check for high error rate
  if (errorCount1m >= 10) {
    return 'unhealthy';
  }

  // Check if we have no tick data at all with RTDS disconnected
  if (lastTick === null && connections.rtds === 'disconnected') {
    return 'unhealthy';
  }

  // Check if all connections are good (unknown counts as potential issue)
  const allConnected = Object.values(connections).every(
    (s) => s === 'connected' || s === 'authenticated'
  );

  // Check if any connection is unknown (not fully operational)
  const hasUnknown = Object.values(connections).some((s) => s === 'unknown');

  // Check for recent tick (within 30 seconds)
  const recentTick = lastTick && (Date.now() - new Date(lastTick).getTime()) < 30000;

  // Healthy: all connected, no errors, receiving ticks, no unknowns
  if (allConnected && errorCount1m === 0 && recentTick && !hasUnknown) {
    return 'healthy';
  }

  // Degraded: database connected but other issues (including unknown states)
  if ((connections.database === 'connected' || connections.database === 'unknown') && errorCount1m < 10) {
    return 'degraded';
  }

  return 'unhealthy';
}

/**
 * Build health check response for /health endpoint (V3 Stage 5)
 *
 * Returns 200 only when ALL checks pass:
 * - db_main: persistence connected + pool available
 * - db_cb: CB pool available
 * - circuit_breaker: state === 'CLOSED'
 * - price_feed: spot module has price with timestamp < 30s old
 *
 * @returns {{ healthy: boolean, checks: Object, statusCode: number }}
 */
export function buildHealthResponse() {
  try {
    const state = orchestrator.getState();
    const modules = state.modules || {};

    const checks = {};

    // db_main: persistence initialized
    checks.db_main = !!modules.persistence?.initialized;

    // db_cb: CB pool available (if CB module exists, its init succeeded with DB)
    checks.db_cb = !!modules['circuit-breaker']?.initialized;

    // circuit_breaker: state must be CLOSED
    const cbState = modules['circuit-breaker']?.state;
    checks.circuit_breaker = cbState === 'CLOSED';

    // price_feed: RTDS receiving recent ticks (< 30s)
    let priceFeedOk = false;
    try {
      const lastTickAt = modules['rtds-client']?.stats?.last_tick_at;
      if (lastTickAt) {
        const age = Date.now() - new Date(lastTickAt).getTime();
        priceFeedOk = age < 30000;
      }
    } catch {
      priceFeedOk = false;
    }
    checks.price_feed = priceFeedOk;

    const healthy = Object.values(checks).every(Boolean);

    return {
      healthy,
      checks,
      statusCode: healthy ? 200 : 503,
    };
  } catch {
    return {
      healthy: false,
      checks: {
        db_main: false,
        db_cb: false,
        circuit_breaker: false,
        price_feed: false,
      },
      statusCode: 503,
      error: 'state_unavailable',
    };
  }
}

/**
 * Build data capture health response for /health/data-capture endpoint
 *
 * Reports tick counts for all FINDTHEGOLD data sources in the last minute.
 * Returns staleness warnings for any source with zero recent data.
 *
 * @returns {{ healthy: boolean, sources: Object, statusCode: number }}
 */
export function buildDataCaptureHealthResponse() {
  try {
    const state = orchestrator.getState();
    const modules = state.modules || {};

    // Grace period: don't warn about missing data in first 60s after startup
    const startedAt = state.startedAt ? new Date(state.startedAt).getTime() : Date.now();
    const uptimeMs = Date.now() - startedAt;
    const inGracePeriod = uptimeMs < 60000;

    const sources = {};

    // Pyth ticks (via tick-logger stats)
    const tickLoggerStats = modules['tick-logger']?.stats;
    sources.pyth = {
      ticks_received: tickLoggerStats?.ticks_received ?? 0,
      ticks_inserted: tickLoggerStats?.ticks_inserted ?? 0,
      last_flush_at: tickLoggerStats?.last_flush_at ?? null,
    };

    // CLOB snapshots
    const clobStats = modules['clob-price-logger']?.stats;
    sources.clob = {
      snapshots_captured: clobStats?.snapshotsCaptured ?? 0,
      snapshots_inserted: clobStats?.snapshotsInserted ?? 0,
      active_tokens: modules['clob-price-logger']?.activeTokens ?? 0,
      ws_connected: modules['clob-price-logger']?.wsConnected ?? false,
      last_snapshot_at: clobStats?.lastSnapshotAt ?? null,
    };

    // L2 order book levels
    const obcStats = modules['order-book-collector']?.stats;
    sources.l2_order_book = {
      snapshots_taken: obcStats?.snapshotsTaken ?? 0,
      l2_levels_inserted: obcStats?.l2LevelsInserted ?? 0,
      active_tokens: modules['order-book-collector']?.activeTokens ?? 0,
      last_snapshot_at: obcStats?.lastSnapshotAt ?? null,
    };

    // Exchange ticks (via CCXT)
    const efcStats = modules['exchange-feed-collector']?.stats;
    sources.exchange_feeds = {
      ticks_captured: efcStats?.ticksCaptured ?? 0,
      ticks_inserted: efcStats?.ticksInserted ?? 0,
      poll_cycles: efcStats?.pollCycles ?? 0,
      last_poll_at: efcStats?.lastPollAt ?? null,
    };

    // Check staleness (any source with no data) — skip during startup grace period
    const warnings = [];
    if (!inGracePeriod) {
      if (!sources.clob.ws_connected) warnings.push('clob_ws_disconnected');
      if (sources.l2_order_book.active_tokens === 0) warnings.push('no_active_l2_tokens');
      if (sources.exchange_feeds.ticks_captured === 0) warnings.push('no_exchange_ticks');
    }

    const healthy = warnings.length === 0;

    return {
      healthy,
      sources,
      warnings,
      statusCode: healthy ? 200 : 503,
    };
  } catch {
    return {
      healthy: false,
      sources: {},
      warnings: ['state_unavailable'],
      statusCode: 503,
    };
  }
}

/**
 * Build the complete status response
 *
 * Health endpoint should NEVER throw - always returns valid JSON.
 * Individual module failures are isolated and don't crash the endpoint.
 *
 * @returns {Object} Status response matching expected schema
 */
export function buildStatusResponse() {
  try {
    const state = orchestrator.getState();
    const modules = state.modules || {};

    // Get connection status (has its own try-catch)
    const connections = getConnectionStatus();

    // Get error count from orchestrator state (exposed via getState())
    const errorCount1m = state.errorCount1m ?? 0;

    // Get last tick from RTDS - safely handle missing/invalid data
    let lastTick = null;
    try {
      lastTick = modules['rtds-client']?.stats?.last_tick_at || null;
    } catch {
      lastTick = null;
    }

    // Get active windows from window-manager - safely handle missing module
    let activeWindows = 0;
    try {
      activeWindows = modules['window-manager']?.activeWindows || 0;
    } catch {
      activeWindows = 0;
    }

    // Calculate uptime - ensure non-negative
    let uptimeSeconds = 0;
    if (state.startedAt) {
      const calculated = Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      uptimeSeconds = Math.max(0, calculated); // Prevent negative uptime from clock skew
    }

    // Determine overall status
    const status = determineHealthStatus(connections, errorCount1m, lastTick);

    return {
      status,
      uptime_seconds: uptimeSeconds,
      active_strategies: state.loadedStrategies || [],
      connections,
      last_tick: lastTick,
      active_windows: activeWindows,
      error_count_1m: errorCount1m,
    };
  } catch {
    // Ultimate fallback - return unhealthy status with error
    return {
      status: 'unhealthy',
      uptime_seconds: 0,
      active_strategies: [],
      connections: {
        database: 'unknown',
        rtds: 'unknown',
        polymarket: 'unknown',
      },
      last_tick: null,
      active_windows: 0,
      error_count_1m: 0,
      error: 'state_unavailable',
    };
  }
}
