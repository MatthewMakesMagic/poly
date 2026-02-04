/**
 * Entry Logic
 *
 * Simple entry strategy: enter when token price > 70%.
 * One entry per window maximum.
 */

import {
  Direction,
  NoSignalReason,
  createEntrySignal,
  createEvaluationResult,
} from './types.js';


// Entry threshold: 70%
const ENTRY_THRESHOLD = 0.70;

/**
 * Evaluate entry conditions for a single window
 *
 * Simple strategy:
 * - Enter when market_price > 70%
 * - Only 1 entry per window
 *
 * @param {Object} params - Evaluation parameters
 * @param {string} params.window_id - Window identifier
 * @param {string} params.market_id - Market identifier
 * @param {number} params.spot_price - Current spot price (not used in simple strategy)
 * @param {number} params.market_price - Current market/token price (0-1)
 * @param {number} params.time_remaining_ms - Time until window expiry
 * @param {Object} params.thresholds - Entry thresholds from config
 * @param {number} params.thresholds.entryThresholdPct - Price threshold (default 0.70)
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
  token_id_up,
  token_id_down,
  thresholds,
  log = null,
}) {
  const { minTimeRemainingMs } = thresholds;
  const entryThreshold = thresholds.entryThresholdPct ?? ENTRY_THRESHOLD;

  // Build base result for logging
  const baseResult = {
    window_id,
    spot_price,
    market_price,
    threshold_pct: entryThreshold,
    time_remaining_ms,
  };

  // Check time remaining
  if (time_remaining_ms < minTimeRemainingMs) {
    const result = createEvaluationResult({
      ...baseResult,
      signal_generated: false,
      reason: NoSignalReason.INSUFFICIENT_TIME,
    });

    logEvaluation(log, result, thresholds);

    return { signal: null, result };
  }

  // Check if price exceeds threshold (>70%, not >=)
  if (market_price <= entryThreshold) {
    const result = createEvaluationResult({
      ...baseResult,
      signal_generated: false,
      reason: NoSignalReason.BELOW_THRESHOLD,
    });

    logEvaluation(log, result, thresholds);

    return { signal: null, result };
  }

  // Price > 70% - generate entry signal!
  // Direction: LONG on this token (we're buying the token showing conviction)
  const direction = Direction.LONG;
  const confidence = calculateConfidence(market_price, entryThreshold);

  // Select token based on direction (LONG = UP token, market_price is UP price)
  const token_id = direction === Direction.LONG ? token_id_up : token_id_down;

  // Create entry signal
  const signal = createEntrySignal({
    window_id,
    market_id,
    direction,
    confidence,
    spot_price,
    market_price,
    spot_lag: 0, // Not used in simple strategy
    spot_lag_pct: 0,
    time_remaining_ms,
    token_id,
    token_id_up,
    token_id_down,
  });

  const result = createEvaluationResult({
    ...baseResult,
    signal_generated: true,
    reason: NoSignalReason.CONDITIONS_MET,
  });

  logEvaluation(log, result, thresholds, confidence, signal);

  return { signal, result };
}

/**
 * Calculate confidence based on how far above threshold the price is
 * Higher price = higher confidence (up to 1.0)
 *
 * @param {number} price - Token price
 * @param {number} threshold - Entry threshold
 * @returns {number} Confidence value between 0 and 1
 */
export function calculateConfidence(price, threshold) {
  // At threshold (70%): confidence = 0.7
  // At 85%: confidence = 0.85
  // At 95%+: confidence = 0.95 (cap)
  return Math.min(0.95, price);
}

/**
 * Log evaluation with expected vs actual format
 *
 * @param {Object|null} log - Logger instance
 * @param {Object} result - Evaluation result
 * @param {Object} thresholds - Threshold configuration
 * @param {number} [confidence] - Calculated confidence
 * @param {Object} [signal] - Generated signal (if any)
 * @private
 */
function logEvaluation(log, result, thresholds, confidence = null, signal = null) {
  if (!log) {
    return;
  }

  const logData = {
    window_id: result.window_id,
    expected: {
      entry_threshold_pct: thresholds.entryThresholdPct ?? ENTRY_THRESHOLD,
      min_time_remaining_ms: thresholds.minTimeRemainingMs,
    },
    actual: {
      market_price: result.market_price,
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
      market_price: signal.market_price,
    };
  }

  // Use debug for non-signal evaluations, info for signals
  if (signal) {
    log.info('entry_signal_generated', logData);
  } else {
    log.debug('entry_evaluated', logData);
  }
}
