/**
 * VWAP Strategy (backward-compatible wrapper)
 *
 * Delegates to vwap-contrarian-strategy.js internally. This file exists
 * to maintain backward compatibility for any code that imports vwap-strategy.
 *
 * The new vwap-contrarian-strategy supports parameterized VWAP sources
 * (composite, coingecko, vwap20) and direction filters (both, down-only).
 *
 * @module modules/paper-trader/vwap-strategy
 */

import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';

/**
 * Evaluate the raw market state for VWAP edge signal (legacy interface)
 *
 * Keeps the original interface: takes windowState + clobBook directly,
 * computes using composite VWAP and absolute dollar thresholds.
 *
 * @param {Object} windowState - Window state from paper trader
 * @param {Object} clobBook - Current CLOB book for UP token
 * @returns {Object|null} Market state, or null if data unavailable
 */
export function evaluateMarketState(windowState, clobBook) {
  const { crypto, vwapAtOpen, market } = windowState;

  const composite = exchangeTradeCollector.getCompositeVWAP(crypto);
  if (!composite) return null;

  const currentVwap = composite.vwap;

  if (vwapAtOpen == null || vwapAtOpen <= 0) return null;

  const vwapDelta = currentVwap - vwapAtOpen;
  const vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  const absVwapDelta = Math.abs(vwapDelta);

  if (!clobBook || clobBook.mid == null) return null;

  const clobUpPrice = clobBook.mid;
  const clobDirection = clobUpPrice >= 0.5 ? 'up' : 'down';

  if (clobUpPrice < 0.05 || clobUpPrice > 0.95) return null;

  const directionsDisagree = vwapDirection !== clobDirection;

  let chainlinkPrice = null;
  try {
    const clData = rtdsClient.getCurrentPrice(crypto, TOPICS.CRYPTO_PRICES_CHAINLINK);
    if (clData) chainlinkPrice = clData.price;
  } catch {
    // RTDS may not be available
  }

  const entrySide = vwapDirection;
  const entryTokenId = entrySide === 'up'
    ? market.upTokenId
    : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    vwapDirection,
    clobDirection,
    directionsDisagree,
    vwapDelta,
    absVwapDelta,
    vwapPrice: currentVwap,
    vwapAtOpen,
    chainlinkPrice,
    clobUpPrice,
    exchangeCount: composite.exchangeCount,
    totalVolume: composite.totalVolume,
  };
}

/**
 * Check if a specific variation's threshold is met (legacy absolute dollar threshold)
 *
 * @param {Object} marketState - From evaluateMarketState()
 * @param {number} vwapDeltaThreshold - Minimum |vwapDelta| to fire
 * @returns {boolean} Whether this variation should fire a trade
 */
export function shouldFire(marketState, vwapDeltaThreshold) {
  if (!marketState) return false;
  if (!marketState.directionsDisagree) return false;
  return marketState.absVwapDelta >= vwapDeltaThreshold;
}

/**
 * Original single-config evaluate (kept for backwards compat)
 *
 * @param {Object} windowState
 * @param {Object} clobBook
 * @param {Object} config
 * @returns {Object|null}
 */
export function evaluate(windowState, clobBook, config) {
  const state = evaluateMarketState(windowState, clobBook);
  if (!state) return null;
  if (!shouldFire(state, config.vwapDeltaThreshold || 75)) return null;
  return state;
}
