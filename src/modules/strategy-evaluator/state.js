/**
 * Strategy Evaluator State
 *
 * Manages evaluation state and metrics tracking.
 */

/**
 * Module state
 */
let state = createInitialState();

/**
 * Create initial state object
 */
function createInitialState() {
  return {
    evaluationCount: 0,
    signalsGenerated: 0,
    lastEvaluationAt: null,
    lastSignalAt: null,
  };
}

/**
 * Get current evaluation statistics
 */
export function getStats() {
  return {
    evaluation_count: state.evaluationCount,
    signals_generated: state.signalsGenerated,
    last_evaluation_at: state.lastEvaluationAt,
    last_signal_at: state.lastSignalAt,
  };
}

/**
 * Record an evaluation occurred
 */
export function recordEvaluation() {
  state.evaluationCount++;
  state.lastEvaluationAt = new Date().toISOString();
}

/**
 * Record a signal was generated
 */
export function recordSignal() {
  state.signalsGenerated++;
  state.lastSignalAt = new Date().toISOString();
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = createInitialState();
}
