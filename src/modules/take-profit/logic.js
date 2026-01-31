/**
 * Take-Profit Logic
 *
 * Core take-profit evaluation functions.
 *
 * Key difference from stop-loss:
 * - Long positions: take-profit triggers when price RISES ABOVE threshold
 * - Short positions: take-profit triggers when price DROPS BELOW threshold
 * - Uses 'limit' closeMethod for better fills (not emergency exit like stop-loss)
 */

import { TriggerReason, createTakeProfitResult, TakeProfitError, TakeProfitErrorCodes } from './types.js';
import { incrementEvaluations, incrementTriggered, incrementSafe } from './state.js';

/**
 * Calculate take-profit threshold for a position
 *
 * For long positions: threshold = entry_price * (1 + takeProfitPct)
 *   Price rising ABOVE this threshold triggers take-profit
 *
 * For short positions: threshold = entry_price * (1 - takeProfitPct)
 *   Price dropping BELOW this threshold triggers take-profit
 *
 * @param {Object} position - Position with entry_price, side
 * @param {number} takeProfitPct - Take-profit percentage (e.g., 0.10 = 10%)
 * @returns {Object} { threshold, entry_price, side, take_profit_pct }
 * @throws {TakeProfitError} If position or percentage is invalid
 */
export function calculateTakeProfitThreshold(position, takeProfitPct) {
  const { entry_price, side } = position;

  // Validate entry price
  if (typeof entry_price !== 'number' || entry_price <= 0) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_POSITION,
      'Position has invalid entry_price',
      { position_id: position.id, entry_price }
    );
  }

  // Validate take-profit percentage
  if (typeof takeProfitPct !== 'number' || takeProfitPct < 0 || takeProfitPct > 1) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.CONFIG_INVALID,
      'Take-profit percentage must be a number between 0 and 1',
      { take_profit_pct: takeProfitPct }
    );
  }

  let threshold;
  if (side === 'long') {
    // Long position: take-profit triggers when price rises above threshold
    threshold = entry_price * (1 + takeProfitPct);
  } else if (side === 'short') {
    // Short position: take-profit triggers when price drops below threshold
    threshold = entry_price * (1 - takeProfitPct);
  } else {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_POSITION,
      'Position has invalid side',
      { position_id: position.id, side }
    );
  }

  return {
    threshold,
    entry_price,
    side,
    take_profit_pct: takeProfitPct,
  };
}

/**
 * Evaluate take-profit condition for a single position
 *
 * @param {Object} position - Position to evaluate
 * @param {number} position.id - Position ID
 * @param {string} position.window_id - Window identifier
 * @param {string} position.side - 'long' or 'short'
 * @param {number} position.size - Position size
 * @param {number} position.entry_price - Entry price
 * @param {number} [position.take_profit_pct] - Per-position take-profit override
 * @param {number} currentPrice - Current market price
 * @param {Object} options - Evaluation options
 * @param {number} [options.takeProfitPct=0.10] - Default take-profit percentage
 * @param {Object} [options.log] - Logger instance
 * @returns {Object} TakeProfitResult
 * @throws {TakeProfitError} If price is invalid
 */
export function evaluate(position, currentPrice, options = {}) {
  const { takeProfitPct = 0.10, log } = options;

  // Validate current price
  if (typeof currentPrice !== 'number' || currentPrice <= 0) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_PRICE,
      'Invalid current price for take-profit evaluation',
      { position_id: position.id, current_price: currentPrice }
    );
  }

  // Use per-position override if available
  const effectiveTakeProfitPct = position.take_profit_pct ?? takeProfitPct;

  // Calculate threshold
  const { threshold, entry_price, side } = calculateTakeProfitThreshold(position, effectiveTakeProfitPct);

  // Track evaluation count
  incrementEvaluations();

  // Check if triggered
  // Note: OPPOSITE of stop-loss direction
  // - Long: triggered when price RISES above threshold
  // - Short: triggered when price DROPS below threshold
  let triggered = false;
  let reason = TriggerReason.NOT_TRIGGERED;

  if (side === 'long' && currentPrice >= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_ABOVE_THRESHOLD;
  } else if (side === 'short' && currentPrice <= threshold) {
    triggered = true;
    reason = TriggerReason.PRICE_BELOW_THRESHOLD;
  }

  // Calculate profit amount
  // For long: profit when price rises (current - entry)
  // For short: profit when price drops (entry - current)
  const priceMove = side === 'long'
    ? currentPrice - entry_price
    : entry_price - currentPrice;
  const profit_amount = position.size * priceMove;
  const profit_pct = priceMove / entry_price;

  const result = createTakeProfitResult({
    triggered,
    position_id: position.id,
    window_id: position.window_id,
    side,
    entry_price,
    current_price: currentPrice,
    take_profit_threshold: threshold,
    take_profit_pct: effectiveTakeProfitPct,
    reason,
    action: triggered ? 'close' : null,
    closeMethod: triggered ? 'limit' : null,  // Use limit order for better fills
    profit_amount: triggered ? profit_amount : 0,
    profit_pct: triggered ? profit_pct : 0,
  });

  // Log appropriately
  if (triggered) {
    incrementTriggered();
    if (log) {
      log.info('take_profit_triggered', {
        position_id: position.id,
        window_id: position.window_id,
        side,
        entry_price,
        current_price: currentPrice,
        take_profit_threshold: threshold,
        profit_amount,
        profit_pct,
        expected: { take_profit_pct: effectiveTakeProfitPct },
        actual: { current_price: currentPrice, threshold_reached: true },
      });
    }
  } else {
    incrementSafe();
    if (log) {
      log.debug('take_profit_evaluated', {
        position_id: position.id,
        current_price: currentPrice,
        threshold,
        distance_to_threshold: side === 'long' ? threshold - currentPrice : currentPrice - threshold,
      });
    }
  }

  return result;
}

/**
 * Evaluate take-profit for all positions
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} options - Evaluation options
 * @param {number} [options.takeProfitPct=0.10] - Default take-profit percentage
 * @param {Object} [options.log] - Logger instance
 * @returns {Object} { triggered: TakeProfitResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  const { takeProfitPct = 0.10, log } = options;
  const triggered = [];
  let evaluatedCount = 0;
  let safeCount = 0;

  for (const position of positions) {
    try {
      // Get current price for this position
      const currentPrice = getCurrentPrice(position);
      if (!currentPrice) {
        if (log) {
          log.warn('take_profit_skip_no_price', { position_id: position.id });
        }
        continue;
      }

      const result = evaluate(position, currentPrice, {
        takeProfitPct,
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
        log.error('take_profit_evaluation_error', {
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
    log.info('take_profit_evaluation_complete', {
      total_positions: positions.length,
      ...summary,
    });
  }

  return { triggered, summary };
}
