/**
 * Window-Expiry Module State
 *
 * Manages evaluation state and metrics tracking.
 */

/**
 * Module state
 */
let state = createInitialState();

/**
 * Create initial state object
 *
 * @returns {Object} Initial state
 */
function createInitialState() {
  return {
    evaluationCount: 0,
    expiringCount: 0,
    resolvedCount: 0,
    safeCount: 0,
    lastEvaluationAt: null,
  };
}

/**
 * Get current evaluation statistics
 *
 * @returns {Object} Evaluation stats
 */
export function getStats() {
  return {
    evaluation_count: state.evaluationCount,
    expiring_count: state.expiringCount,
    resolved_count: state.resolvedCount,
    safe_count: state.safeCount,
    last_evaluation_at: state.lastEvaluationAt,
  };
}

/**
 * Increment evaluation counter
 */
export function incrementEvaluations() {
  state.evaluationCount++;
  state.lastEvaluationAt = new Date().toISOString();
}

/**
 * Increment expiring counter (warning zone)
 */
export function incrementExpiring() {
  state.expiringCount++;
}

/**
 * Increment resolved counter
 */
export function incrementResolved() {
  state.resolvedCount++;
}

/**
 * Increment safe counter (evaluated but not expiring or resolved)
 */
export function incrementSafe() {
  state.safeCount++;
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = createInitialState();
}
