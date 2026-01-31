/**
 * Stop-Loss Logic
 *
 * Core stop-loss evaluation functions.
 */

import { TriggerReason, createStopLossResult, StopLossError, StopLossErrorCodes } from './types.js';
import { incrementEvaluations, incrementTriggered, incrementSafe } from './state.js';

/**
 * Calculate stop-loss threshold for a position
 *
 * For long positions: threshold = entry_price * (1 - stopLossPct)
 *   Price dropping BELOW this threshold triggers stop-loss
 *
 * For short positions: threshold = entry_price * (1 + stopLossPct)
 *   Price rising ABOVE this threshold triggers stop-loss
 *
 * @param {Object} position - Position with entry_price, side
 * @param {number} stopLossPct - Stop-loss percentage (e.g., 0.05 = 5%)
 * @returns {Object} { threshold, entry_price, side, stop_loss_pct }
 * @throws {StopLossError} If position or percentage is invalid
 */
export function calculateStopLossThreshold(position, stopLossPct) {
  const { entry_price, side } = position;

  // Validate entry price
  if (typeof entry_price !== 'number' || entry_price <= 0) {
    throw new StopLossError(
      StopLossErrorCodes.INVALID_POSITION,
      'Position has invalid entry_price',
      { position_id: position.id, entry_price }
    );
  }

  // Validate stop-loss percentage
  if (typeof stopLossPct !== 'number' || stopLossPct < 0 || stopLossPct > 1) {
    throw new StopLossError(
      StopLossErrorCodes.CONFIG_INVALID,
      'Stop-loss percentage must be a number between 0 and 1',
      { stop_loss_pct: stopLossPct }
    );
  }

  let threshold;
  if (side === 'long') {
    // Long position: stop-loss triggers when price drops below threshold
    threshold = entry_price * (1 - stopLossPct);
  } else if (side === 'short') {
    // Short position: stop-loss triggers when price rises above threshold
    threshold = entry_price * (1 + stopLossPct);
  } else {
    throw new StopLossError(
      StopLossErrorCodes.INVALID_POSITION,
      'Position has invalid side',
      { position_id: position.id, side }
    );
  }

  return {
    threshold,
    entry_price,
    side,
    stop_loss_pct: stopLossPct,
  };
}

/**
 * Evaluate stop-loss condition for a single position
 *
 * @param {Object} position - Position to evaluate
 * @param {number} position.id - Position ID
 * @param {string} position.window_id - Window identifier
 * @param {string} position.side - 'long' or 'short'
 * @param {number} position.size - Position size
 * @param {number} position.entry_price - Entry price
 * @param {number} [position.stop_loss_pct] - Per-position stop-loss override
 * @param {number} currentPrice - Current market price
 * @param {Object} options - Evaluation options
 * @param {number} [options.stopLossPct=0.05] - Default stop-loss percentage
 * @param {Object} [options.log] - Logger instance
 * @returns {Object} StopLossResult
 * @throws {StopLossError} If price is invalid
 */
export function evaluate(position, currentPrice, options = {}) {
  const { stopLossPct = 0.05, log } = options;

  // Validate current price
  if (typeof currentPrice !== 'number' || currentPrice <= 0) {
    throw new StopLossError(
      StopLossErrorCodes.INVALID_PRICE,
      'Invalid current price for stop-loss evaluation',
      { position_id: position.id, current_price: currentPrice }
    );
  }

  // Use per-position override if available
  const effectiveStopLossPct = position.stop_loss_pct ?? stopLossPct;

  // Calculate threshold
  const { threshold, entry_price, side } = calculateStopLossThreshold(position, effectiveStopLossPct);

  // Track evaluation count
  incrementEvaluations();

  // Check if triggered
  let triggered = false;
  let reason = TriggerReason.NOT_TRIGGERED;

  if (side === 'long' && currentPrice <= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_BELOW_THRESHOLD;
  } else if (side === 'short' && currentPrice >= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_ABOVE_THRESHOLD;
  }

  // Calculate loss amount
  // For long: loss when price drops (entry - current)
  // For short: loss when price rises (current - entry)
  const priceMove = side === 'long'
    ? entry_price - currentPrice
    : currentPrice - entry_price;
  const loss_amount = position.size * priceMove;
  const loss_pct = priceMove / entry_price;

  const result = createStopLossResult({
    triggered,
    position_id: position.id,
    window_id: position.window_id,
    side,
    entry_price,
    current_price: currentPrice,
    stop_loss_threshold: threshold,
    stop_loss_pct: effectiveStopLossPct,
    reason,
    action: triggered ? 'close' : null,
    closeMethod: triggered ? 'market' : null,
    loss_amount: triggered ? loss_amount : 0,
    loss_pct: triggered ? loss_pct : 0,
  });

  // Log appropriately
  if (triggered) {
    incrementTriggered();
    if (log) {
      log.info('stop_loss_triggered', {
        position_id: position.id,
        window_id: position.window_id,
        side,
        entry_price,
        current_price: currentPrice,
        stop_loss_threshold: threshold,
        loss_amount,
        loss_pct,
        expected: { stop_loss_pct: effectiveStopLossPct },
        actual: { current_price: currentPrice, threshold_breached: true },
      });
    }
  } else {
    incrementSafe();
    if (log) {
      log.debug('stop_loss_evaluated', {
        position_id: position.id,
        current_price: currentPrice,
        threshold,
        distance_to_threshold: side === 'long' ? currentPrice - threshold : threshold - currentPrice,
      });
    }
  }

  return result;
}

/**
 * Evaluate stop-loss for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} options - Evaluation options
 * @param {number} [options.stopLossPct=0.05] - Default stop-loss percentage
 * @param {Object} [options.log] - Logger instance
 * @returns {Object} { triggered: StopLossResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  const { stopLossPct = 0.05, log } = options;
  const triggered = [];
  let evaluatedCount = 0;
  let safeCount = 0;

  for (const position of positions) {
    try {
      // Get current price for this position
      const currentPrice = getCurrentPrice(position);
      if (!currentPrice) {
        if (log) {
          log.warn('stop_loss_skip_no_price', { position_id: position.id });
        }
        continue;
      }

      const result = evaluate(position, currentPrice, {
        stopLossPct,
        log,
      });

      evaluatedCount++;

      if (result.triggered) {
        triggered.push(result);
      } else {
        safeCount++;
      }
    } catch (err) {
      if (log) {
        log.error('stop_loss_evaluation_error', {
          position_id: position.id,
          error: err.message,
          code: err.code,
        });
      }
    }
  }

  const summary = {
    evaluated: evaluatedCount,
    triggered: triggered.length,
    safe: safeCount,
  };

  if (log && evaluatedCount > 0) {
    log.info('stop_loss_evaluation_complete', {
      total_positions: positions.length,
      ...summary,
    });
  }

  return { triggered, summary };
}
