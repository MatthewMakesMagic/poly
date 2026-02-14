/**
 * VWAP Strategy
 *
 * Encapsulates the backtested VWAP edge strategy logic:
 * When 21-exchange composite VWAP disagrees with CLOB direction at T-60s
 * and VWAP delta > threshold, the backtest shows strong win rates.
 *
 * Two-phase evaluation:
 * 1. evaluateMarketState() — compute raw VWAP vs CLOB data (called once per window)
 * 2. shouldFire() — check if a specific threshold is met (called per variation)
 *
 * @module modules/paper-trader/vwap-strategy
 */

import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';

/**
 * Evaluate the raw market state for VWAP edge signal
 *
 * Computes VWAP delta, directions, and whether they disagree.
 * Does NOT apply a threshold — that's done per-variation by shouldFire().
 *
 * @param {Object} windowState - Window state from paper trader
 * @param {Object} clobBook - Current CLOB book for UP token
 * @returns {Object|null} Market state, or null if data unavailable
 */
export function evaluateMarketState(windowState, clobBook) {
  const { crypto, vwapAtOpen, market } = windowState;

  // 1. Get current composite VWAP
  const composite = exchangeTradeCollector.getCompositeVWAP(crypto);
  if (!composite) return null;

  const currentVwap = composite.vwap;

  // 2. Compute VWAP delta and direction
  if (vwapAtOpen == null || vwapAtOpen <= 0) return null;

  const vwapDelta = currentVwap - vwapAtOpen;
  const vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  const absVwapDelta = Math.abs(vwapDelta);

  // 3. Get CLOB direction from UP token mid price
  if (!clobBook || clobBook.mid == null) return null;

  const clobUpPrice = clobBook.mid;
  const clobDirection = clobUpPrice >= 0.5 ? 'up' : 'down';

  // 4. CLOB mid not extreme (market hasn't already decided)
  if (clobUpPrice < 0.05 || clobUpPrice > 0.95) return null;

  // 5. Determine if VWAP and CLOB disagree
  const directionsDisagree = vwapDirection !== clobDirection;

  // Get Chainlink price for reference
  let chainlinkPrice = null;
  try {
    const clData = rtdsClient.getCurrentPrice(crypto, TOPICS.CRYPTO_PRICES_CHAINLINK);
    if (clData) chainlinkPrice = clData.price;
  } catch {
    // RTDS may not be available
  }

  // Entry side = VWAP direction (buy the token that VWAP predicts will win)
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
 * Check if a specific variation's threshold is met
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
