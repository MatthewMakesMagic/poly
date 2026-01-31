/**
 * Entry Logic
 *
 * Core entry condition evaluation for the spot-lag strategy.
 * The strategy enters when:
 * 1. Spot price diverges from market price by more than threshold
 * 2. Sufficient time remains in the window (min 1 minute)
 * 3. Confidence threshold met based on lag magnitude
 */

import {
  Direction,
  NoSignalReason,
  createEntrySignal,
  createEvaluationResult,
} from './types.js';

/**
 * Evaluate entry conditions for a single window
 *
 * @param {Object} params - Evaluation parameters
 * @param {string} params.window_id - Window identifier
 * @param {string} params.market_id - Market identifier
 * @param {number} params.spot_price - Current spot price
 * @param {number} params.market_price - Current market price
 * @param {number} params.time_remaining_ms - Time until window expiry
 * @param {Object} params.thresholds - Entry thresholds from config
 * @param {number} params.thresholds.spotLagThresholdPct - Minimum lag percentage
 * @param {number} params.thresholds.minConfidence - Minimum confidence to enter
 * @param {number} params.thresholds.minTimeRemainingMs - Minimum time remaining
 * @param {Object} [log] - Logger instance for debug output
 * @returns {Object} { signal: EntrySignal|null, result: EvaluationResult }
 */
export function evaluateEntry({
  window_id,
  market_id,
  spot_price,
  market_price,
  time_remaining_ms,
  thresholds,
  log = null,
}) {
  const { spotLagThresholdPct, minConfidence, minTimeRemainingMs } = thresholds;

  // Calculate spot lag
  const spot_lag = spot_price - market_price;
  const spot_lag_pct = market_price > 0 ? Math.abs(spot_lag / market_price) : 0;

  // Build base result for logging
  const baseResult = {
    window_id,
    spot_price,
    market_price,
    threshold_pct: spotLagThresholdPct,
    time_remaining_ms,
  };

  // Check time remaining
  if (time_remaining_ms < minTimeRemainingMs) {
    const result = createEvaluationResult({
      ...baseResult,
      signal_generated: false,
      reason: NoSignalReason.INSUFFICIENT_TIME,
    });

    logEvaluation(log, result, thresholds, spot_lag_pct);

    return { signal: null, result };
  }

  // Check if lag exceeds threshold
  if (spot_lag_pct < spotLagThresholdPct) {
    const result = createEvaluationResult({
      ...baseResult,
      signal_generated: false,
      reason: NoSignalReason.INSUFFICIENT_LAG,
    });

    logEvaluation(log, result, thresholds, spot_lag_pct);

    return { signal: null, result };
  }

  // Calculate confidence based on lag magnitude
  const confidence = calculateConfidence(spot_lag_pct, spotLagThresholdPct);
  if (confidence < minConfidence) {
    const result = createEvaluationResult({
      ...baseResult,
      signal_generated: false,
      reason: NoSignalReason.LOW_CONFIDENCE,
    });

    logEvaluation(log, result, thresholds, spot_lag_pct, confidence);

    return { signal: null, result };
  }

  // Determine direction based on spot vs market
  const direction = spot_lag > 0 ? Direction.LONG : Direction.SHORT;

  // Create entry signal
  const signal = createEntrySignal({
    window_id,
    market_id,
    direction,
    confidence,
    spot_price,
    market_price,
    spot_lag,
    spot_lag_pct,
    time_remaining_ms,
  });

  const result = createEvaluationResult({
    ...baseResult,
    signal_generated: true,
    reason: NoSignalReason.CONDITIONS_MET,
  });

  logEvaluation(log, result, thresholds, spot_lag_pct, confidence, signal);

  return { signal, result };
}

/**
 * Calculate confidence based on lag magnitude
 * Higher lag = higher confidence (up to 1.0)
 *
 * @param {number} lagPct - Actual lag percentage
 * @param {number} thresholdPct - Threshold percentage
 * @returns {number} Confidence value between 0 and 1
 */
export function calculateConfidence(lagPct, thresholdPct) {
  // Confidence scales from threshold to 2x threshold
  // At threshold: confidence = 0.5
  // At 2x threshold: confidence = 1.0
  const ratio = lagPct / thresholdPct;
  return Math.min(1.0, 0.5 + (ratio - 1) * 0.5);
}

/**
 * Log evaluation with expected vs actual format
 *
 * @param {Object|null} log - Logger instance
 * @param {Object} result - Evaluation result
 * @param {Object} thresholds - Threshold configuration
 * @param {number} spot_lag_pct - Calculated spot lag percentage
 * @param {number} [confidence] - Calculated confidence
 * @param {Object} [signal] - Generated signal (if any)
 * @private
 */
function logEvaluation(log, result, thresholds, spot_lag_pct, confidence = null, signal = null) {
  if (!log) {
    return;
  }

  const logData = {
    window_id: result.window_id,
    expected: {
      spot_lag_threshold_pct: thresholds.spotLagThresholdPct,
      min_time_remaining_ms: thresholds.minTimeRemainingMs,
      min_confidence: thresholds.minConfidence,
    },
    actual: {
      spot_price: result.spot_price,
      market_price: result.market_price,
      spot_lag_pct,
      time_remaining_ms: result.time_remaining_ms,
    },
    signal_generated: result.signal_generated,
    reason: result.reason,
  };

  if (confidence !== null) {
    logData.actual.confidence = confidence;
  }

  if (signal) {
    logData.signal = {
      direction: signal.direction,
      confidence: signal.confidence,
      spot_lag: signal.spot_lag,
    };
  }

  // Use info level since logger doesn't support debug
  log.info('entry_evaluated', logData);
}
