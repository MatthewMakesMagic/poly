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
 *
 * @returns {Object} Initial state
 */
function createInitialState() {
  return {
    evaluationCount: 0,
    signalsGenerated: 0,
    lastEvaluationAt: null,
    lastSignalAt: null,
    windowsEntered: new Set(), // Track windows we've already entered
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
 * Check if we've already entered a window
 *
 * @param {string} windowId - Window identifier
 * @returns {boolean} True if already entered
 */
export function hasEnteredWindow(windowId) {
  return state.windowsEntered.has(windowId);
}

/**
 * Mark a window as entered
 *
 * @param {string} windowId - Window identifier
 */
export function markWindowEntered(windowId) {
  state.windowsEntered.add(windowId);
}

/**
 * Clear old windows from tracking (housekeeping)
 * Call this periodically to prevent memory growth
 *
 * @param {Set<string>} activeWindowIds - Set of currently active window IDs
 */
export function pruneInactiveWindows(activeWindowIds) {
  for (const windowId of state.windowsEntered) {
    if (!activeWindowIds.has(windowId)) {
      state.windowsEntered.delete(windowId);
    }
  }
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = createInitialState();
}
