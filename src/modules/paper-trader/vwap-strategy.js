/**
 * VWAP Strategy
 *
 * Encapsulates the backtested VWAP edge strategy logic:
 * When 21-exchange composite VWAP disagrees with CLOB direction at T-60s
 * and VWAP delta > $75, the backtest shows 9/9 wins (100%).
 *
 * @module modules/paper-trader/vwap-strategy
 */

import * as exchangeTradeCollector from '../exchange-trade-collector/index.js';
import * as rtdsClient from '../../clients/rtds/index.js';
import { TOPICS } from '../../clients/rtds/types.js';

/**
 * Evaluate the VWAP edge signal for a window
 *
 * All conditions must be true for a signal:
 * 1. Composite VWAP available with current price
 * 2. VWAP delta from window open exceeds threshold
 * 3. VWAP direction and CLOB direction disagree
 * 4. CLOB mid not extreme (between 0.05 and 0.95)
 *
 * @param {Object} windowState - Window state from paper trader
 * @param {string} windowState.crypto - Crypto symbol (e.g., 'btc')
 * @param {number} windowState.vwapAtOpen - VWAP price at window open
 * @param {Object} windowState.market - Market info from window manager
 * @param {Object} clobBook - Current CLOB book for UP token
 * @param {Object} config - Strategy config
 * @param {number} config.vwapDeltaThreshold - Min VWAP delta in dollars (default 75)
 * @returns {Object|null} Signal object or null
 */
export function evaluate(windowState, clobBook, config) {
  const { crypto, vwapAtOpen, market } = windowState;
  const vwapDeltaThreshold = config.vwapDeltaThreshold || 75;

  // 1. Get current composite VWAP
  const composite = exchangeTradeCollector.getCompositeVWAP(crypto);
  if (!composite) {
    return null;
  }

  const currentVwap = composite.vwap;

  // 2. Compute VWAP delta and direction
  if (vwapAtOpen == null || vwapAtOpen <= 0) {
    return null;
  }

  const vwapDelta = currentVwap - vwapAtOpen;
  const vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  const absVwapDelta = Math.abs(vwapDelta);

  // 3. Get CLOB direction from UP token mid price
  if (!clobBook || clobBook.mid == null) {
    return null;
  }

  const clobUpPrice = clobBook.mid;
  const clobDirection = clobUpPrice >= 0.5 ? 'up' : 'down';

  // 4. CLOB mid not extreme (market hasn't already decided)
  if (clobUpPrice < 0.05 || clobUpPrice > 0.95) {
    return null;
  }

  // 5. VWAP and CLOB directions must disagree
  if (vwapDirection === clobDirection) {
    return null;
  }

  // 6. VWAP delta must exceed threshold
  if (absVwapDelta < vwapDeltaThreshold) {
    return null;
  }

  // Get Chainlink price for reference
  let chainlinkPrice = null;
  try {
    const clData = rtdsClient.getCurrentPrice(crypto, TOPICS.CRYPTO_PRICES_CHAINLINK);
    if (clData) {
      chainlinkPrice = clData.price;
    }
  } catch {
    // RTDS may not be available
  }

  // Signal: VWAP says one direction, CLOB says the other
  // We trust VWAP (21 exchanges) over CLOB market price
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
