/**
 * Take-Profit Module State
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
    triggeredCount: 0,
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
    triggered_count: state.triggeredCount,
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
 * Increment triggered counter
 */
export function incrementTriggered() {
  state.triggeredCount++;
}

/**
 * Increment safe counter (evaluated but not triggered)
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
