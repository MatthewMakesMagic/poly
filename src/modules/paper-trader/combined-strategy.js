/**
 * Combined Strategy
 *
 * Multi-signal agreement: calls VWAP contrarian, CLOB staleness, and
 * book imbalance internally. When multiple signals agree on a direction,
 * the confidence is higher. Majority vote determines entry side.
 *
 * @module modules/paper-trader/combined-strategy
 */

import * as vwapContrarian from './vwap-contrarian-strategy.js';
import * as clobStaleness from './clob-staleness-strategy.js';
import * as bookImbalance from './book-imbalance-strategy.js';

/**
 * Evaluate market state with multiple signals
 *
 * @param {Object} ctx - Strategy context
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook } = ctx;
  const { market, crypto } = windowState;

  if (!upBook || upBook.mid == null) return null;
  if (upBook.mid < 0.05 || upBook.mid > 0.95) return null;

  const signals = [];

  // 1. VWAP contrarian (CoinGecko source)
  const vwapState = vwapContrarian.evaluateMarketState(ctx, 'coingecko');
  if (vwapState && vwapState.directionsDisagree) {
    signals.push({ name: 'vwap_cg', side: vwapState.entrySide });
  }

  // 2. CLOB staleness (requires >= 5s stale + some delta)
  const staleState = clobStaleness.evaluateMarketState(ctx);
  if (staleState && staleState.stalenessMs >= 5000 && staleState.absVwapDeltaPct >= 0.03) {
    signals.push({ name: 'clob_stale', side: staleState.entrySide });
  }

  // 3. Book imbalance (BTC only)
  if (crypto === 'btc') {
    const bookState = bookImbalance.evaluateMarketState(ctx);
    if (bookState && bookState.imbalanceRatio >= 0.60) {
      signals.push({ name: 'book_imbal', side: bookState.entrySide });
    }
  }

  if (signals.length === 0) return null;

  // Majority vote
  const upVotes = signals.filter(s => s.side === 'up').length;
  const downVotes = signals.filter(s => s.side === 'down').length;

  const entrySide = upVotes >= downVotes ? 'up' : 'down';
  const agreeingSignals = signals.filter(s => s.side === entrySide);

  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    agreeingSignals,
    totalSignals: signals.length,
    allSignals: signals,
    clobUpPrice: upBook.mid,
    chainlinkPrice: ctx.chainlinkPrice,
    exchangeCount: ctx.vwapSources?.composite?.exchangeCount ?? null,
    totalVolume: ctx.vwapSources?.composite?.totalVolume ?? null,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { minAgreement, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;
  const minAgree = variation.minAgreement ?? 2;
  return state.agreeingSignals.length >= minAgree;
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
