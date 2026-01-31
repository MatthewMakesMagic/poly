/**
 * Position Sizer State
 *
 * Manages sizing state and metrics tracking.
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
    sizingCount: 0,
    successCount: 0,
    rejectionCount: 0,
    lastSizingAt: null,
    adjustmentCounts: {
      no_adjustment: 0,
      liquidity_limited: 0,
      exposure_capped: 0,
      position_limit_capped: 0,
      below_minimum: 0,
      rejected: 0,
    },
  };
}

/**
 * Get current sizing statistics
 *
 * @returns {Object} Sizing stats
 */
export function getStats() {
  return {
    sizing_count: state.sizingCount,
    success_count: state.successCount,
    rejection_count: state.rejectionCount,
    last_sizing_at: state.lastSizingAt,
    adjustment_counts: { ...state.adjustmentCounts },
  };
}

/**
 * Record a sizing calculation
 *
 * @param {boolean} success - Whether sizing was successful
 * @param {string} adjustmentReason - The adjustment reason applied
 */
export function recordSizing(success, adjustmentReason) {
  state.sizingCount++;
  state.lastSizingAt = new Date().toISOString();

  if (success) {
    state.successCount++;
  } else {
    state.rejectionCount++;
  }

  if (adjustmentReason && state.adjustmentCounts[adjustmentReason] !== undefined) {
    state.adjustmentCounts[adjustmentReason]++;
  }
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = createInitialState();
}
