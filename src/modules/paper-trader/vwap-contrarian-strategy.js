/**
 * VWAP Contrarian Strategy
 *
 * Enhanced VWAP strategy parameterized by VWAP source and direction filter.
 * When VWAP direction disagrees with CLOB direction, bet on the VWAP side.
 *
 * Supports three VWAP sources:
 * - composite: Our 21-exchange composite VWAP
 * - coingecko: CoinGecko's 1,700+ exchange aggregated price
 * - vwap20: Composite excluding LBank (20-exchange diversified)
 *
 * Uses percentage-based thresholds instead of absolute dollar deltas.
 *
 * @module modules/paper-trader/vwap-contrarian-strategy
 */

/**
 * Evaluate market state for a specific VWAP source
 *
 * @param {Object} ctx - Strategy context
 * @param {string} vwapSource - 'composite' | 'coingecko' | 'vwap20'
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx, vwapSource = 'composite') {
  const { windowState, upBook, vwapSources, openPrices } = ctx;
  const { market } = windowState;

  // Get current and open prices for the specified source
  let currentPrice, openPrice;

  if (vwapSource === 'composite') {
    if (!vwapSources.composite) return null;
    currentPrice = vwapSources.composite.vwap;
    openPrice = openPrices.composite;
  } else if (vwapSource === 'coingecko') {
    if (!vwapSources.coingecko) return null;
    currentPrice = vwapSources.coingecko.price;
    openPrice = openPrices.coingecko;
  } else if (vwapSource === 'vwap20') {
    if (!vwapSources.vwap20) return null;
    currentPrice = vwapSources.vwap20.vwap;
    openPrice = openPrices.vwap20;
  } else {
    return null;
  }

  if (currentPrice == null || openPrice == null || openPrice <= 0) return null;

  // Compute delta and direction
  const vwapDelta = currentPrice - openPrice;
  const vwapDeltaPct = (vwapDelta / openPrice) * 100;
  const vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  const absVwapDeltaPct = Math.abs(vwapDeltaPct);

  // Get CLOB direction from UP token mid price
  if (!upBook || upBook.mid == null) return null;
  const clobUpPrice = upBook.mid;
  const clobDirection = clobUpPrice >= 0.5 ? 'up' : 'down';

  // Skip if CLOB is already extreme (market has decided)
  if (clobUpPrice < 0.05 || clobUpPrice > 0.95) return null;

  const directionsDisagree = vwapDirection !== clobDirection;

  // Entry side = VWAP direction
  const entrySide = vwapDirection;
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  // Get volume/exchange info from composite source
  const exchangeCount = vwapSources.composite?.exchangeCount ?? null;
  const totalVolume = vwapSources.composite?.totalVolume ?? null;

  return {
    entrySide,
    entryTokenId,
    vwapDirection,
    clobDirection,
    directionsDisagree,
    vwapDelta,
    vwapDeltaPct,
    absVwapDeltaPct,
    vwapPrice: currentPrice,
    vwapAtOpen: openPrice,
    chainlinkPrice: ctx.chainlinkPrice,
    clobUpPrice,
    exchangeCount,
    totalVolume,
    vwapSource,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - Variation config with vwapDeltaThresholdPct and positionSizeDollars
 * @param {string|null} directionFilter - null (both) or 'down' (DOWN-only)
 * @returns {boolean}
 */
export function shouldFire(state, variation, directionFilter = null) {
  if (!state) return false;
  if (!state.directionsDisagree) return false;

  // Direction filter: if 'down', only fire on DOWN signals
  if (directionFilter === 'down' && state.vwapDirection !== 'down') return false;

  // Check percentage threshold
  const threshold = variation.vwapDeltaThresholdPct ?? 0.03;
  return state.absVwapDeltaPct >= threshold;
}

/**
 * Check if this strategy applies to a given crypto/timing
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  return true; // Applies to all instruments and timings
}
