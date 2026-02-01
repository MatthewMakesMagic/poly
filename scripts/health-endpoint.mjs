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
      rtds: modules.rtds?.connected ? 'connected' : (modules.rtds ? 'disconnected' : 'unknown'),
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
      lastTick = modules.rtds?.stats?.last_tick_at || null;
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
