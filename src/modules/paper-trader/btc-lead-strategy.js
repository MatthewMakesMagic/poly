/**
 * BTC Lead Strategy
 *
 * Thesis: BTC moves first, altcoins follow. When BTC VWAP has moved
 * directionally but this crypto's CLOB hasn't repriced, bet CLOB will
 * follow BTC's direction.
 *
 * Applies to: SOL, XRP, ETH (not BTC itself)
 * Entry side: BTC direction
 *
 * @module modules/paper-trader/btc-lead-strategy
 */

/**
 * Evaluate market state for BTC lead signal
 *
 * @param {Object} ctx - Strategy context (must include ctx.btcData)
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook, btcData } = ctx;
  const { market } = windowState;

  if (!btcData || btcData.currentVwap == null || btcData.openVwap == null) return null;
  if (btcData.openVwap <= 0) return null;
  if (!upBook || upBook.mid == null) return null;

  // Skip extreme CLOB prices
  if (upBook.mid < 0.05 || upBook.mid > 0.95) return null;

  // BTC delta
  const btcDelta = btcData.currentVwap - btcData.openVwap;
  const btcDeltaPct = (btcDelta / btcData.openVwap) * 100;
  const btcDirection = btcDelta >= 0 ? 'up' : 'down';
  const absBtcDeltaPct = Math.abs(btcDeltaPct);

  // CLOB direction for this crypto
  const clobUpPrice = upBook.mid;
  const clobDirection = clobUpPrice >= 0.5 ? 'up' : 'down';

  // Only fire when CLOB disagrees with BTC direction
  const directionsDisagree = btcDirection !== clobDirection;

  // Entry side = BTC direction (we bet the altcoin will follow BTC)
  const entrySide = btcDirection;
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    btcDirection,
    btcDeltaPct,
    absBtcDeltaPct,
    clobDirection,
    clobUpPrice,
    directionsDisagree,
    chainlinkPrice: ctx.chainlinkPrice,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { btcDeltaThresholdPct, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;
  if (!state.directionsDisagree) return false;

  const threshold = variation.btcDeltaThresholdPct ?? 0.03;
  return state.absBtcDeltaPct >= threshold;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  // Not BTC — only altcoins
  return crypto !== 'btc';
}
