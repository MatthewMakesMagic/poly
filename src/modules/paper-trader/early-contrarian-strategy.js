/**
 * Early Contrarian Strategy
 *
 * Bets against CLOB direction at early signal times (T-90s, T-120s).
 * When the CLOB has moderate conviction (not extreme), take the opposite
 * side. The thesis: early CLOB leans often revert as oracle data arrives.
 *
 * Only fires at T-90s and T-120s (early enough for mean-reversion).
 *
 * @module modules/paper-trader/early-contrarian-strategy
 */

/**
 * Evaluate market state for early contrarian
 *
 * @param {Object} ctx - Strategy context
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook } = ctx;
  const { market } = windowState;

  if (!upBook || upBook.mid == null) return null;

  const clobUpPrice = upBook.mid;

  // Skip extreme prices
  if (clobUpPrice < 0.05 || clobUpPrice > 0.95) return null;

  const clobDirection = clobUpPrice >= 0.5 ? 'up' : 'down';
  const clobConviction = Math.abs(clobUpPrice - 0.50);

  // Entry side = opposite of CLOB direction (contrarian)
  const entrySide = clobDirection === 'up' ? 'down' : 'up';
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    clobDirection,
    clobConviction,
    clobUpPrice,
    chainlinkPrice: ctx.chainlinkPrice,
    exchangeCount: ctx.vwapSources?.composite?.exchangeCount ?? null,
    totalVolume: ctx.vwapSources?.composite?.totalVolume ?? null,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { minConviction, maxConviction, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;

  const minConv = variation.minConviction ?? 0.05;
  const maxConv = variation.maxConviction ?? 0.20;

  return state.clobConviction >= minConv && state.clobConviction <= maxConv;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  // Only at T-90s and T-120s (early timings)
  return signalOffsetSec >= 90;
}
