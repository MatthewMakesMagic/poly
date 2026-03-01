/**
 * Canary Signal Generator Component
 *
 * Test strategy: buys whichever side CLOB favors (price > $0.50).
 * This is a lifecycle validation strategy, NOT an edge strategy.
 * Expected ~50% win rate, small losses to spread.
 *
 * Designed to work with the composed strategy executor's flat windowContext:
 *   { market_price, token_id_up, token_id_down, window_id, timeToExpiry, ... }
 *
 * @module modules/strategy/components/signal-generator/canary-signal
 */

/**
 * Component metadata - REQUIRED
 */
export const metadata = {
  name: 'canary-signal',
  version: 1,
  type: 'signal-generator',
  description: 'Always-trade canary: buys CLOB-favored side for lifecycle testing',
  author: 'poly-system',
  createdAt: '2026-03-01',
};

/**
 * Default configuration
 */
const DEFAULTS = {
  minTimeRemainingMs: 30000, // 30s minimum remaining
  minPositionSize: 2,
  maxPositionSize: 2,
};

/**
 * Evaluate whether to generate a canary signal.
 *
 * Works with the flat windowContext passed by the composed strategy executor:
 *   - context.market_price: YES token price (0-1)
 *   - context.token_id_up: token ID for YES/UP side
 *   - context.token_id_down: token ID for NO/DOWN side
 *   - context.window_id: window identifier
 *   - context.timeToExpiry: ms remaining in window
 *   - context.oracle_price: crypto dollar price
 *   - context.reference_price: strike price
 *   - context.symbol: crypto symbol
 *   - context.market_id: market identifier
 *
 * Logic:
 * 1. Check we have a valid window (window_id present)
 * 2. Ensure > 30s remaining (duplicate_window_entry guard prevents re-entry)
 * 3. Buy whichever side CLOB favors (market_price > 0.50 = YES, else NO)
 *
 * @param {Object} context - Flat windowContext from composed strategy executor
 * @param {Object} config - Strategy configuration
 * @returns {Object} Signal result
 */
export function evaluate(context, config) {
  const mergedConfig = { ...DEFAULTS, ...config };

  // No window context
  if (!context || !context.window_id) {
    return {
      has_signal: false,
      direction: null,
      reason: 'no_window',
    };
  }

  // Check timing: need at least 30s remaining
  const timeToExpiry = context.timeToExpiry || 0;
  if (timeToExpiry < mergedConfig.minTimeRemainingMs) {
    return {
      has_signal: false,
      direction: null,
      reason: 'too_late',
      timeToExpiry,
    };
  }

  // Get market price (YES token price, 0-1)
  const marketPrice = context.market_price;
  if (marketPrice == null) {
    return {
      has_signal: false,
      direction: null,
      reason: 'no_market_price',
    };
  }

  const marketPriceNum = Number(marketPrice);
  if (isNaN(marketPriceNum) || marketPriceNum <= 0 || marketPriceNum >= 1) {
    return {
      has_signal: false,
      direction: null,
      reason: 'invalid_market_price',
      market_price: marketPrice,
    };
  }

  // Determine favored side
  let direction;
  let tokenId;
  let price;

  if (marketPriceNum >= 0.50) {
    // YES side favored
    direction = 'yes';
    price = marketPriceNum;
    tokenId = context.token_id_up || context.token_id;
  } else {
    // NO side favored
    direction = 'no';
    price = 1 - marketPriceNum; // NO token price
    tokenId = context.token_id_down;
  }

  if (!tokenId) {
    return {
      has_signal: false,
      direction: null,
      reason: 'no_token_id',
      attempted_direction: direction,
    };
  }

  return {
    has_signal: true,
    direction,
    token_id: tokenId,
    price,
    size: mergedConfig.minPositionSize,
    confidence: price,
    strategy: 'always-trade-canary',
    reason: `canary_${direction}_favored`,
    window_id: context.window_id,
    market_id: context.market_id,
    oracle_price: context.oracle_price,
    reference_price: context.reference_price,
    symbol: context.symbol,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Validate component configuration
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid: boolean, errors?: string[] }
 */
export function validateConfig(config) {
  const errors = [];

  if (config?.minTimeRemainingMs !== undefined) {
    if (typeof config.minTimeRemainingMs !== 'number' || config.minTimeRemainingMs <= 0) {
      errors.push('minTimeRemainingMs must be a positive number');
    }
  }

  if (config?.minPositionSize !== undefined) {
    if (typeof config.minPositionSize !== 'number' || config.minPositionSize < 0) {
      errors.push('minPositionSize must be a non-negative number');
    }
  }

  if (config?.maxPositionSize !== undefined) {
    if (typeof config.maxPositionSize !== 'number' || config.maxPositionSize < 0) {
      errors.push('maxPositionSize must be a non-negative number');
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export default {
  metadata,
  evaluate,
  validateConfig,
};
