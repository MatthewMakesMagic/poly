/**
 * Canary Signal Generator Component
 *
 * Test strategy: at T-60s before window close, buys whichever side
 * CLOB favors (price > $0.50). This is a lifecycle validation strategy,
 * NOT an edge strategy. Expected ~50% win rate, small losses to spread.
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
  description: 'Always-trade canary: buys CLOB-favored side at T-60s for lifecycle testing',
  author: 'poly-system',
  createdAt: '2026-03-01',
};

/**
 * Default configuration
 */
const DEFAULTS = {
  entryWindowSeconds: 60,
  minPositionSize: 2,
  maxPositionSize: 2,
};

/**
 * Evaluate whether to generate a canary signal.
 *
 * Logic:
 * 1. Wait until T-60s before window close
 * 2. Check CLOB prices for YES and NO tokens
 * 3. Buy whichever side has price > $0.50 (i.e., the favored side)
 * 4. No stop-loss, run to settlement
 *
 * @param {Object} context - Execution context
 * @param {Object} context.window - Active window object
 * @param {number} context.window.closeTimestamp - Window close time (epoch seconds)
 * @param {Object} context.window.clobPrices - { yes: number, no: number }
 * @param {string} context.window.tokenIds - { yes: string, no: string }
 * @param {Object} context.prevResults - Results from previous pipeline stages
 * @param {Object} config - Strategy configuration
 * @returns {Object} Signal result
 */
export function evaluate(context, config) {
  const mergedConfig = { ...DEFAULTS, ...config };
  const { window } = context;

  // No window available
  if (!window) {
    return {
      has_signal: false,
      direction: null,
      reason: 'no_window',
    };
  }

  // Check timing: only signal within entry window
  const nowSec = Date.now() / 1000;
  const closeTime = window.closeTimestamp || window.close_timestamp || window.expiresAt;
  if (!closeTime) {
    return {
      has_signal: false,
      direction: null,
      reason: 'no_close_timestamp',
    };
  }

  const secondsToClose = closeTime - nowSec;
  if (secondsToClose > mergedConfig.entryWindowSeconds || secondsToClose < 5) {
    return {
      has_signal: false,
      direction: null,
      reason: secondsToClose > mergedConfig.entryWindowSeconds
        ? 'too_early'
        : 'too_late',
      secondsToClose,
    };
  }

  // Get CLOB prices
  const yesPrice = window.clobPrices?.yes
    ?? window.clob_prices?.yes
    ?? window.yesPrice
    ?? window.yes_price;
  const noPrice = window.clobPrices?.no
    ?? window.clob_prices?.no
    ?? window.noPrice
    ?? window.no_price;

  if (yesPrice == null && noPrice == null) {
    return {
      has_signal: false,
      direction: null,
      reason: 'no_clob_prices',
    };
  }

  // Determine favored side (price > 0.50)
  const yesPriceNum = Number(yesPrice) || 0;
  const noPriceNum = Number(noPrice) || 0;

  let direction;
  let tokenId;
  let price;

  if (yesPriceNum >= noPriceNum && yesPriceNum > 0) {
    direction = 'yes';
    price = yesPriceNum;
    tokenId = window.tokenIds?.yes
      ?? window.token_ids?.yes
      ?? window.yesTokenId
      ?? window.yes_token_id;
  } else if (noPriceNum > 0) {
    direction = 'no';
    price = noPriceNum;
    tokenId = window.tokenIds?.no
      ?? window.token_ids?.no
      ?? window.noTokenId
      ?? window.no_token_id;
  } else {
    return {
      has_signal: false,
      direction: null,
      reason: 'prices_zero',
    };
  }

  return {
    has_signal: true,
    direction,
    side: direction === 'yes' ? 'buy' : 'buy',
    token_id: tokenId,
    price,
    size: mergedConfig.minPositionSize,
    shouldEnter: true,
    confidence: price,
    stopLoss: null,
    strategy: 'always-trade-canary',
    reason: `canary_${direction}_favored`,
    secondsToClose,
    window_id: window.id || window.windowId || window.condition_id,
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

  if (config?.entryWindowSeconds !== undefined) {
    if (typeof config.entryWindowSeconds !== 'number' || config.entryWindowSeconds <= 0) {
      errors.push('entryWindowSeconds must be a positive number');
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
