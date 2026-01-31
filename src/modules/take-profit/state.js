/**
 * Take-Profit Module State
 *
 * Manages evaluation state and metrics tracking.
 * Includes high-water mark tracking for trailing stop functionality.
 */

/**
 * Module state
 */
let state = createInitialState();

/**
 * High-water mark tracking per position
 * Key: position_id, Value: { highWaterMark, highWaterMarkTime, trailingActive, trailingActivatedAt }
 */
let highWaterMarks = {};

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
    trailingActivationCount: 0,
    trailingTriggerCount: 0,
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
    trailing_activation_count: state.trailingActivationCount,
    trailing_trigger_count: state.trailingTriggerCount,
    active_trailing_positions: Object.keys(highWaterMarks).filter(
      (k) => highWaterMarks[k]?.trailingActive
    ).length,
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
 * Increment trailing activation counter
 */
export function incrementTrailingActivation() {
  state.trailingActivationCount++;
}

/**
 * Increment trailing trigger counter
 */
export function incrementTrailingTrigger() {
  state.trailingTriggerCount++;
}

/**
 * Get high-water mark data for a position
 *
 * @param {number|string} positionId - Position ID
 * @returns {Object|null} High-water mark data or null if not tracked
 */
export function getHighWaterMark(positionId) {
  return highWaterMarks[positionId] || null;
}

/**
 * Update high-water mark for a position
 *
 * @param {number|string} positionId - Position ID
 * @param {number} price - Current price
 * @param {string} side - 'long' or 'short'
 * @returns {Object} Updated high-water mark data
 */
export function updateHighWaterMark(positionId, price, side) {
  const existing = highWaterMarks[positionId];

  // For long positions: track highest price
  // For short positions: track lowest price
  const isNewHighWater = !existing ||
    (side === 'long' && price > existing.highWaterMark) ||
    (side === 'short' && price < existing.highWaterMark);

  if (isNewHighWater) {
    highWaterMarks[positionId] = {
      ...existing,
      highWaterMark: price,
      highWaterMarkTime: new Date().toISOString(),
      trailingActive: existing?.trailingActive || false,
      trailingActivatedAt: existing?.trailingActivatedAt || null,
    };
  }

  return highWaterMarks[positionId];
}

/**
 * Activate trailing stop for a position
 *
 * @param {number|string} positionId - Position ID
 * @param {number} activationPrice - Price at which trailing was activated
 */
export function activateTrailing(positionId, activationPrice) {
  if (!highWaterMarks[positionId]) {
    highWaterMarks[positionId] = {
      highWaterMark: activationPrice,
      highWaterMarkTime: new Date().toISOString(),
    };
  }
  highWaterMarks[positionId].trailingActive = true;
  highWaterMarks[positionId].trailingActivatedAt = activationPrice;
  incrementTrailingActivation();
}

/**
 * Remove high-water mark tracking for a position (after exit)
 *
 * @param {number|string} positionId - Position ID
 */
export function removeHighWaterMark(positionId) {
  delete highWaterMarks[positionId];
}

/**
 * Reset state to initial values
 */
export function resetState() {
  state = createInitialState();
  highWaterMarks = {};
}
