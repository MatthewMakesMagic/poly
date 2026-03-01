/**
 * Canary Entry Component
 *
 * Phase 1.1 test strategy: At T-60s before window close, buy whichever
 * side the CLOB favors (price > $0.50). This is a correctness test,
 * not an edge strategy. Expected ~50% win rate.
 *
 * @module modules/strategy/components/entry/canary
 */

export const metadata = {
  name: 'canary',
  version: 1,
  type: 'entry',
  description: 'Always-trade canary: buys CLOB-favored side at T-60s for lifecycle verification',
  author: 'system',
  createdAt: '2026-03-01',
};

/**
 * Evaluate entry condition for the canary strategy.
 *
 * @param {Object} context - Evaluation context
 * @param {Object} context.window - Window state
 * @param {number} context.window.time_remaining_ms - Time remaining in window
 * @param {number} context.window.market_price - YES token mid price (0-1)
 * @param {string} context.window.token_id_up - UP/YES token ID
 * @param {string} context.window.token_id_down - DOWN/NO token ID
 * @param {string} context.window.window_id - Window identifier
 * @param {string} context.window.market_id - Market identifier
 * @param {Object} config - Strategy configuration
 * @param {number} [config.entryWindowMs=60000] - Entry window before close (ms)
 * @param {number} [config.minClobConviction=0.01] - Min distance from 0.50
 * @returns {Object} Result with signal or null
 */
export function evaluate(context, config = {}) {
  const { window: w } = context;
  if (!w) return { signal: null, reason: 'no_window' };

  const entryWindowMs = config.entryWindowMs ?? 60000;
  const minClobConviction = config.minClobConviction ?? 0.01;
  const timeRemaining = w.time_remaining_ms ?? Infinity;
  const marketPrice = w.market_price ?? 0.50;

  // Only enter in the last entryWindowMs of the window
  if (timeRemaining > entryWindowMs) {
    return { signal: null, reason: 'too_early' };
  }

  // Must have at least 5s remaining
  if (timeRemaining < 5000) {
    return { signal: null, reason: 'too_late' };
  }

  // Determine which side CLOB favors
  const upConviction = marketPrice - 0.50;
  const absConviction = Math.abs(upConviction);

  // Must have minimum conviction (not exactly 50/50)
  if (absConviction < minClobConviction) {
    return { signal: null, reason: 'insufficient_conviction' };
  }

  // Buy whichever side has price > 0.50
  const side = upConviction > 0 ? 'UP' : 'DOWN';
  const tokenId = side === 'UP' ? w.token_id_up : w.token_id_down;

  return {
    signal: {
      window_id: w.window_id,
      market_id: w.market_id,
      token_id: tokenId,
      direction: 'long',
      side,
      strategy_id: 'always-trade-canary',
      confidence: absConviction,
      price: marketPrice,
      symbol: (w.crypto || w.symbol || 'btc').toLowerCase(),
    },
    reason: 'canary_entry',
    conviction: absConviction,
  };
}

/**
 * Validate canary strategy configuration.
 *
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid, errors }
 */
export function validateConfig(config = {}) {
  const errors = [];

  if (config.entryWindowMs !== undefined) {
    if (typeof config.entryWindowMs !== 'number' || config.entryWindowMs <= 0) {
      errors.push('entryWindowMs must be a positive number');
    }
  }

  if (config.minClobConviction !== undefined) {
    if (typeof config.minClobConviction !== 'number' || config.minClobConviction < 0 || config.minClobConviction > 0.5) {
      errors.push('minClobConviction must be between 0 and 0.5');
    }
  }

  return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
}
