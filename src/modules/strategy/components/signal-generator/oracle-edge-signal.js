/**
 * Oracle Edge Signal Component Adapter
 *
 * Wraps the oracle-edge-signal module as a strategy component for the Epic 6 composition framework.
 * Generates trading signals based on UI/Oracle divergence and staleness.
 *
 * @module modules/strategy/components/signal-generator/oracle-edge-signal
 */

import * as oracleEdgeSignal from '../../../../modules/oracle-edge-signal/index.js';

/**
 * Component metadata - REQUIRED
 */
export const metadata = {
  name: 'oracle-edge-signal',
  version: 1,
  type: 'signal-generator',
  description: 'Generates signals based on UI/Oracle divergence with stale oracle detection',
  author: 'BMAD',
  createdAt: '2026-02-01',
};

/**
 * Evaluate signal generation (standard component interface)
 *
 * Evaluates a window for oracle edge signals.
 *
 * @param {Object} context - Execution context
 * @param {Object} context.window - Window data object from window-manager
 * @param {string} context.symbol - Cryptocurrency symbol
 * @param {Object} config - Component configuration
 * @returns {Object} Evaluation result with signal data
 */
export function evaluate(context, config) {
  const { window, symbol } = context;

  // Get signal generator state
  const generatorState = oracleEdgeSignal.getState();

  // If no window provided, return no-signal state
  if (!window) {
    return {
      has_signal: false,
      direction: null,
      confidence: null,
      inputs: null,
      stats: generatorState.stats,
      symbol,
    };
  }

  // Evaluate the window
  let signal = null;
  try {
    signal = oracleEdgeSignal.evaluateWindow(window);
  } catch {
    // Evaluation failed - return no signal
    return {
      has_signal: false,
      direction: null,
      confidence: null,
      inputs: null,
      error: 'evaluation_failed',
      stats: generatorState.stats,
      symbol,
    };
  }

  // No signal generated
  if (!signal) {
    return {
      has_signal: false,
      direction: null,
      confidence: null,
      inputs: null,
      stats: generatorState.stats,
      symbol,
    };
  }

  // Signal generated
  return {
    has_signal: true,
    direction: signal.direction,
    confidence: signal.confidence,
    token_id: signal.token_id,
    side: signal.side,
    inputs: signal.inputs,
    window_id: signal.window_id,
    generated_at: signal.generated_at,
    stats: generatorState.stats,
    symbol,
  };
}

/**
 * Evaluate multiple windows for signals
 *
 * Batch evaluation helper that evaluates all provided windows.
 *
 * @param {Object} context - Execution context
 * @param {Object[]} context.windows - Array of window data objects
 * @param {Object} config - Component configuration
 * @returns {Object} Evaluation result with array of signals
 */
export function evaluateBatch(context, config) {
  const { windows } = context;

  if (!windows || !Array.isArray(windows)) {
    return {
      signals: [],
      count: 0,
    };
  }

  try {
    const signals = oracleEdgeSignal.evaluateAllWindows(windows);
    return {
      signals,
      count: signals.length,
    };
  } catch {
    return {
      signals: [],
      count: 0,
      error: 'batch_evaluation_failed',
    };
  }
}

/**
 * Validate component configuration
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateConfig(config) {
  const errors = [];

  if (config?.maxTimeThresholdMs !== undefined) {
    if (typeof config.maxTimeThresholdMs !== 'number' || config.maxTimeThresholdMs <= 0) {
      errors.push('maxTimeThresholdMs must be a positive number');
    }
  }

  if (config?.minStalenessMs !== undefined) {
    if (typeof config.minStalenessMs !== 'number' || config.minStalenessMs <= 0) {
      errors.push('minStalenessMs must be a positive number');
    }
  }

  if (config?.confidenceThreshold !== undefined) {
    if (typeof config.confidenceThreshold !== 'number' || config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
      errors.push('confidenceThreshold must be a number between 0 and 1');
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
  evaluateBatch,
  validateConfig,
};
