/**
 * CLOB Staleness Strategy
 *
 * Detects when the CLOB book hasn't updated recently while VWAP shows
 * a directional move. When the CLOB is "stale", it may be mispriced
 * relative to the oracle — bet on the VWAP direction.
 *
 * Uses CoinGecko as the VWAP source (broadest exchange coverage).
 *
 * @module modules/paper-trader/clob-staleness-strategy
 */

/**
 * Evaluate market state for CLOB staleness
 *
 * @param {Object} ctx - Strategy context
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook, vwapSources, openPrices } = ctx;
  const { market } = windowState;

  if (!upBook || upBook.mid == null || upBook.lastUpdateAt == null) return null;

  // Skip extreme CLOB prices
  if (upBook.mid < 0.05 || upBook.mid > 0.95) return null;

  // Compute staleness
  const nowMs = Date.now();
  const stalenessMs = nowMs - upBook.lastUpdateAt;

  // Get VWAP direction from CoinGecko (broadest coverage)
  const cgSource = vwapSources.coingecko;
  const cgOpen = openPrices.coingecko;

  // Fall back to composite if CG unavailable
  let currentPrice, openPrice, source;
  if (cgSource && cgOpen != null) {
    currentPrice = cgSource.price;
    openPrice = cgOpen;
    source = 'coingecko';
  } else if (vwapSources.composite && openPrices.composite != null) {
    currentPrice = vwapSources.composite.vwap;
    openPrice = openPrices.composite;
    source = 'composite';
  } else {
    return null;
  }

  if (openPrice <= 0) return null;

  const vwapDelta = currentPrice - openPrice;
  const vwapDeltaPct = (vwapDelta / openPrice) * 100;
  const vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  const absVwapDeltaPct = Math.abs(vwapDeltaPct);

  // Entry side = VWAP direction when CLOB is stale
  const entrySide = vwapDirection;
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    stalenessMs,
    vwapDirection,
    vwapDeltaPct,
    absVwapDeltaPct,
    clobUpPrice: upBook.mid,
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
 * @param {Object} variation - { minStalenessMs, minDeltaPct, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;

  const minStale = variation.minStalenessMs ?? 5000;
  const minDelta = variation.minDeltaPct ?? 0.03;

  return state.stalenessMs >= minStale && state.absVwapDeltaPct >= minDelta;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  return true; // All instruments, all timings
}
