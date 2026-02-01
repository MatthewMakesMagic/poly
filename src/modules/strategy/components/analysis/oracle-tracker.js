/**
 * Oracle Tracker Component Adapter
 *
 * Wraps the oracle-tracker module as a strategy component for the Epic 6 composition framework.
 * Provides oracle update pattern analysis and staleness detection.
 *
 * @module modules/strategy/components/analysis/oracle-tracker
 */

import * as oracleTracker from '../../../../modules/oracle-tracker/index.js';

/**
 * Component metadata - REQUIRED
 */
export const metadata = {
  name: 'oracle-tracker',
  version: 1,
  type: 'analysis',
  description: 'Tracks oracle update patterns and staleness for trading edge detection',
  author: 'BMAD',
  createdAt: '2026-02-01',
};

/**
 * Evaluate oracle analysis (standard component interface)
 *
 * Returns staleness information and pattern statistics for the given symbol.
 *
 * @param {Object} context - Execution context
 * @param {string} context.symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {Object} config - Component configuration
 * @returns {Object} Evaluation result with staleness and pattern data
 */
export function evaluate(context, config) {
  const { symbol } = context;

  // Get oracle tracker state
  const trackerState = oracleTracker.getState();

  // Get stats for symbol
  let stats = null;
  let avgFrequency = null;
  let deviationThreshold = null;

  try {
    stats = oracleTracker.getStats(symbol);
    avgFrequency = oracleTracker.getAverageUpdateFrequency(symbol);
    deviationThreshold = oracleTracker.getDeviationThreshold(symbol);
  } catch {
    // Stats unavailable
  }

  // Extract tracking state for this symbol
  const trackingState = trackerState.tracking?.[symbol] || null;
  const lastUpdate = trackingState?.last_price_timestamp || null;

  // Calculate staleness
  let stalenessMs = null;
  let isStale = false;
  if (lastUpdate) {
    stalenessMs = Date.now() - new Date(lastUpdate).getTime();
    // Consider stale if no update in 15 seconds (configurable)
    const staleThresholdMs = config?.staleThresholdMs || 15000;
    isStale = stalenessMs > staleThresholdMs;
  }

  return {
    staleness_ms: stalenessMs,
    is_stale: isStale,
    last_update: lastUpdate,
    pattern: {
      update_count: stats?.update_count || 0,
      avg_frequency_ms: avgFrequency?.avg_ms || null,
      updates_per_minute: avgFrequency?.updates_per_minute || null,
      deviation_threshold: deviationThreshold,
    },
    volatility_buckets: stats?.update_frequency_by_volatility || null,
    symbol,
  };
}

/**
 * Validate component configuration
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateConfig(config) {
  const errors = [];

  if (config?.staleThresholdMs !== undefined) {
    if (typeof config.staleThresholdMs !== 'number' || config.staleThresholdMs <= 0) {
      errors.push('staleThresholdMs must be a positive number');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export default {
  metadata,
  evaluate,
  validateConfig,
};
