/**
 * State Reconciler Logic Module
 *
 * Contains the core reconciliation logic.
 * Divergence detection has been separated to divergence.js per architecture specification.
 *
 * @see divergence.js for divergence detection functions
 */

// Re-export divergence functions for backward compatibility
export { detectDivergence, formatDivergenceForLog } from './divergence.js';

/**
 * Build reconciliation result object
 *
 * @param {Array<Object>} incompleteIntents - List of incomplete intents
 * @param {number} startTime - Start time in ms (from Date.now())
 * @returns {Object} ReconciliationResult object
 */
export function buildReconciliationResult(incompleteIntents, startTime) {
  const intents = incompleteIntents || [];
  const duration = Date.now() - startTime;

  return {
    clean: intents.length === 0,
    incompleteCount: intents.length,
    incompleteIntents: intents,
    timestamp: new Date().toISOString(),
    duration_ms: duration,
  };
}

