/**
 * Spread Widening Strategy
 *
 * Thesis: Wide CLOB spread = MMs pulling liquidity/uncertain. If VWAP
 * has moved directionally, the book is stale — bet with VWAP direction.
 *
 * Applies to: SOL, XRP only (less efficient MM pricing)
 * Entry side: VWAP direction
 * No CLOB disagreement required — wide spread itself is the signal.
 *
 * @module modules/paper-trader/spread-widening-strategy
 */

/**
 * Evaluate market state for spread widening signal
 *
 * @param {Object} ctx - Strategy context
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook, vwapSources, openPrices } = ctx;
  const { market } = windowState;

  if (!upBook || upBook.mid == null || upBook.spread == null) return null;

  // Skip extreme CLOB prices
  if (upBook.mid < 0.05 || upBook.mid > 0.95) return null;

  const spread = upBook.spread;
  const clobUpPrice = upBook.mid;

  // Get VWAP direction (composite preferred, CG fallback)
  let currentPrice, openPrice, source;
  if (vwapSources.composite && openPrices.composite != null) {
    currentPrice = vwapSources.composite.vwap;
    openPrice = openPrices.composite;
    source = 'composite';
  } else if (vwapSources.coingecko && openPrices.coingecko != null) {
    currentPrice = vwapSources.coingecko.price;
    openPrice = openPrices.coingecko;
    source = 'coingecko';
  } else {
    return null;
  }

  if (openPrice <= 0) return null;

  const vwapDelta = currentPrice - openPrice;
  const vwapDeltaPct = (vwapDelta / openPrice) * 100;
  const vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  const absVwapDeltaPct = Math.abs(vwapDeltaPct);

  // Entry side = VWAP direction
  const entrySide = vwapDirection;
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    spread,
    vwapDirection,
    vwapDeltaPct,
    absVwapDeltaPct,
    clobUpPrice,
    vwapPrice: currentPrice,
    chainlinkPrice: ctx.chainlinkPrice,
    vwapSource: source,
    exchangeCount: vwapSources.composite?.exchangeCount ?? null,
    totalVolume: vwapSources.composite?.totalVolume ?? null,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { minSpread, minDeltaPct, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;

  const minSpread = variation.minSpread ?? 0.03;
  const minDelta = variation.minDeltaPct ?? 0.03;

  return state.spread >= minSpread && state.absVwapDeltaPct >= minDelta;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  // SOL and XRP only
  return crypto === 'sol' || crypto === 'xrp';
}
