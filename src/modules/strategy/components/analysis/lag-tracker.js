/**
 * Lag Tracker Component Adapter
 *
 * Wraps the lag-tracker module as a strategy component for the Epic 6 composition framework.
 * Provides cross-correlation lag analysis between spot and oracle feeds.
 *
 * @module modules/strategy/components/analysis/lag-tracker
 */

import * as lagTracker from '../../../../modules/lag-tracker/index.js';

/**
 * Component metadata - REQUIRED
 */
export const metadata = {
  name: 'lag-tracker',
  version: 1,
  type: 'analysis',
  description: 'Cross-correlation lag analysis between spot and oracle price feeds',
  author: 'BMAD',
  createdAt: '2026-02-01',
};

/**
 * Evaluate lag analysis (standard component interface)
 *
 * Returns lag signal information including tau*, correlation, and stability.
 *
 * @param {Object} context - Execution context
 * @param {string} context.symbol - Cryptocurrency symbol (btc, eth, sol, xrp)
 * @param {Object} config - Component configuration
 * @returns {Object} Evaluation result with lag signal data
 */
export function evaluate(context, config) {
  const { symbol } = context;

  // Get lag tracker state
  const trackerState = lagTracker.getState();

  // Get lag signal for symbol
  let lagSignal = null;
  let analysis = null;
  let stability = null;
  let accuracy = null;

  try {
    lagSignal = lagTracker.getLagSignal(symbol);
    analysis = lagTracker.analyze(symbol);
    stability = lagTracker.getStability(symbol);
    accuracy = lagTracker.getAccuracyStats();
  } catch {
    // Data unavailable - likely not enough samples
  }

  // Extract buffer info for this symbol
  const bufferState = trackerState.buffers?.[symbol] || null;

  return {
    tau_star_ms: analysis?.tau_star_ms || null,
    correlation: analysis?.correlation || null,
    p_value: analysis?.p_value || null,
    significant: analysis?.significant || false,
    signal: {
      has_signal: lagSignal?.has_signal || false,
      direction: lagSignal?.direction || null,
      confidence: lagSignal?.confidence || null,
    },
    stability: {
      stable: stability?.stable || false,
      variance: stability?.variance || null,
      tau_history: stability?.tau_history || [],
    },
    accuracy: {
      total_signals: accuracy?.total_signals || 0,
      total_correct: accuracy?.total_correct || 0,
      accuracy_pct: accuracy?.accuracy || 0,
    },
    buffer: {
      spot_count: bufferState?.spot?.length || 0,
      oracle_count: bufferState?.oracle?.length || 0,
    },
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

  if (config?.minCorrelation !== undefined) {
    if (typeof config.minCorrelation !== 'number' || config.minCorrelation < 0 || config.minCorrelation > 1) {
      errors.push('minCorrelation must be a number between 0 and 1');
    }
  }

  if (config?.significanceThreshold !== undefined) {
    if (typeof config.significanceThreshold !== 'number' || config.significanceThreshold < 0 || config.significanceThreshold > 1) {
      errors.push('significanceThreshold must be a number between 0 and 1');
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
