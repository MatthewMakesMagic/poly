/**
 * Take-Profit Logic
 *
 * Core take-profit evaluation functions.
 *
 * Key difference from stop-loss:
 * - Long positions: take-profit triggers when price RISES ABOVE threshold
 * - Short positions: take-profit triggers when price DROPS BELOW threshold
 * - Uses 'limit' closeMethod for better fills (not emergency exit like stop-loss)
 *
 * Trailing Take-Profit:
 * - Tracks high-water mark (best price since entry)
 * - Activates when profit exceeds activation threshold
 * - Triggers exit when price drops X% from high-water mark
 * - Enforces minimum profit floor
 */

import { TriggerReason, createTakeProfitResult, TakeProfitError, TakeProfitErrorCodes } from './types.js';
import {
  incrementEvaluations,
  incrementTriggered,
  incrementSafe,
  incrementTrailingTrigger,
  getHighWaterMark,
  updateHighWaterMark,
  activateTrailing,
} from './state.js';

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
 * Evaluate trailing take-profit for a single position
 *
 * Trailing stop works as follows:
 * 1. Track the high-water mark (best price since entry)
 * 2. When profit exceeds activation threshold, trailing is activated
 * 3. Exit when price drops pullbackPct from the high-water mark
 * 4. Never exit below the minimum profit floor
 *
 * @param {Object} position - Position to evaluate
 * @param {number} position.id - Position ID
 * @param {string} position.window_id - Window identifier
 * @param {string} position.side - 'long' or 'short'
 * @param {number} position.size - Position size
 * @param {number} position.entry_price - Entry price
 * @param {number} currentPrice - Current market price
 * @param {Object} options - Evaluation options
 * @param {number} [options.trailingActivationPct=0.15] - Profit % to activate trailing (e.g., 0.15 = 15%)
 * @param {number} [options.trailingPullbackPct=0.10] - Pullback % from HWM to trigger (e.g., 0.10 = 10%)
 * @param {number} [options.minProfitFloorPct=0.05] - Minimum profit % to lock in (e.g., 0.05 = 5%)
 * @param {Object} [options.log] - Logger instance
 * @returns {Object} TakeProfitResult with trailing-specific fields
 * @throws {TakeProfitError} If price is invalid
 */
export function evaluateTrailing(position, currentPrice, options = {}) {
  const {
    trailingActivationPct = 0.15,
    trailingPullbackPct = 0.10,
    minProfitFloorPct = 0.05,
    log,
  } = options;

  // Validate current price
  if (typeof currentPrice !== 'number' || currentPrice <= 0) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_PRICE,
      'Invalid current price for trailing take-profit evaluation',
      { position_id: position.id, current_price: currentPrice }
    );
  }

  const { entry_price, side, id: positionId } = position;

  // Validate position
  if (typeof entry_price !== 'number' || entry_price <= 0) {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_POSITION,
      'Position has invalid entry_price',
      { position_id: positionId, entry_price }
    );
  }

  if (side !== 'long' && side !== 'short') {
    throw new TakeProfitError(
      TakeProfitErrorCodes.INVALID_POSITION,
      'Position has invalid side',
      { position_id: positionId, side }
    );
  }

  // Track evaluation count
  incrementEvaluations();

  // Calculate current P&L
  // For long: profit when price rises (current - entry)
  // For short: profit when price drops (entry - current)
  const priceMove = side === 'long'
    ? currentPrice - entry_price
    : entry_price - currentPrice;
  const currentPnlPct = priceMove / entry_price;

  // Update high-water mark
  const hwmData = updateHighWaterMark(positionId, currentPrice, side);
  const highWaterMark = hwmData.highWaterMark;
  let trailingActive = hwmData.trailingActive;

  // Check if trailing should activate
  if (!trailingActive && currentPnlPct >= trailingActivationPct) {
    activateTrailing(positionId, currentPrice);
    trailingActive = true;
    if (log) {
      log.info('trailing_activated', {
        position_id: positionId,
        side,
        entry_price,
        current_price: currentPrice,
        pnl_pct: currentPnlPct,
        activation_threshold: trailingActivationPct,
      });
    }
  }

  // Calculate trailing stop price
  let trailingStopPrice = null;
  let triggered = false;
  let reason = TriggerReason.NOT_TRIGGERED;

  if (trailingActive) {
    // Calculate trailing stop price based on pullback from HWM
    // For long: stop is below HWM
    // For short: stop is above HWM (since HWM for short is lowest price)
    if (side === 'long') {
      trailingStopPrice = highWaterMark * (1 - trailingPullbackPct);
      // Enforce minimum profit floor
      const profitFloorPrice = entry_price * (1 + minProfitFloorPct);
      trailingStopPrice = Math.max(trailingStopPrice, profitFloorPrice);

      // Check if trailing stop hit
      if (currentPrice <= trailingStopPrice) {
        triggered = true;
        reason = TriggerReason.TRAILING_STOP_HIT;
      }
    } else {
      // For short: HWM is lowest price, stop is above it
      trailingStopPrice = highWaterMark * (1 + trailingPullbackPct);
      // Enforce minimum profit floor (for short, profit floor is below entry)
      const profitFloorPrice = entry_price * (1 - minProfitFloorPct);
      trailingStopPrice = Math.min(trailingStopPrice, profitFloorPrice);

      // Check if trailing stop hit
      if (currentPrice >= trailingStopPrice) {
        triggered = true;
        reason = TriggerReason.TRAILING_STOP_HIT;
      }
    }
  }

  // Calculate profit at exit
  const profit_amount = position.size * priceMove;
  const profit_pct = currentPnlPct;

  const result = createTakeProfitResult({
    triggered,
    position_id: positionId,
    window_id: position.window_id,
    side,
    entry_price,
    current_price: currentPrice,
    take_profit_threshold: trailingStopPrice,
    take_profit_pct: trailingPullbackPct,
    reason,
    action: triggered ? 'close' : null,
    closeMethod: triggered ? 'limit' : null,
    profit_amount: triggered ? profit_amount : 0,
    profit_pct: triggered ? profit_pct : 0,
    trailing_active: trailingActive,
    high_water_mark: highWaterMark,
    trailing_stop_price: trailingStopPrice,
  });

  // Log appropriately
  if (triggered) {
    incrementTriggered();
    incrementTrailingTrigger();
    if (log) {
      log.info('trailing_take_profit_triggered', {
        position_id: positionId,
        window_id: position.window_id,
        side,
        entry_price,
        high_water_mark: highWaterMark,
        trailing_stop_price: trailingStopPrice,
        current_price: currentPrice,
        profit_amount,
        profit_pct,
        pullback_from_hwm: side === 'long'
          ? (highWaterMark - currentPrice) / highWaterMark
          : (currentPrice - highWaterMark) / highWaterMark,
      });
    }
  } else {
    incrementSafe();
    if (log) {
      log.debug('trailing_take_profit_evaluated', {
        position_id: positionId,
        trailing_active: trailingActive,
        current_price: currentPrice,
        high_water_mark: highWaterMark,
        trailing_stop_price: trailingStopPrice,
        current_pnl_pct: currentPnlPct,
        activation_threshold: trailingActivationPct,
      });
    }
  }

  return result;
}

/**
 * Evaluate take-profit for all positions (supports both fixed and trailing modes)
 *
 * @param {Object[]} positions - Array of open positions
 * @param {Function} getCurrentPrice - Function to get current price for a position
 * @param {Object} options - Evaluation options
 * @param {number} [options.takeProfitPct=0.10] - Default take-profit percentage
 * @param {boolean} [options.trailingEnabled=false] - Use trailing stop mode
 * @param {number} [options.trailingActivationPct=0.15] - Profit % to activate trailing
 * @param {number} [options.trailingPullbackPct=0.10] - Pullback % from HWM to trigger
 * @param {number} [options.minProfitFloorPct=0.05] - Minimum profit % to lock in
 * @param {Object} [options.log] - Logger instance
 * @returns {Object} { triggered: TakeProfitResult[], summary: { evaluated, triggered, safe } }
 */
export function evaluateAll(positions, getCurrentPrice, options = {}) {
  const {
    takeProfitPct = 0.10,
    trailingEnabled = false,
    trailingActivationPct = 0.15,
    trailingPullbackPct = 0.10,
    minProfitFloorPct = 0.05,
    log,
  } = options;
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

      // Use trailing or fixed mode based on config
      const result = trailingEnabled
        ? evaluateTrailing(position, currentPrice, {
            trailingActivationPct,
            trailingPullbackPct,
            minProfitFloorPct,
            log,
          })
        : evaluate(position, currentPrice, {
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
      trailing_enabled: trailingEnabled,
      ...summary,
    });
  }

  return { triggered, summary };
}
