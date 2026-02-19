/**
 * Contrarian Book Depth Strategy
 *
 * Thesis: When CLOB is strongly decided (>0.75 or <0.25) but the contrarian
 * token still has real ask depth, MMs are quoting the "losing" side with
 * real money — they likely know something. Bet with them (contrarian).
 *
 * Observed: 83-91% win rate on crossover trades where contrarian depth existed.
 * 5/7 crossover windows had real depth ($2-$64 available).
 *
 * Applies to: ETH, XRP (where crossovers observed)
 * Entry side: Contrarian (against CLOB direction)
 *
 * @module modules/paper-trader/contrarian-depth-strategy
 */

/**
 * Compute total dollar depth on the ask side of a book
 * @param {Object} book - Order book with asks [[price, size], ...]
 * @returns {number} Total dollars available to buy
 */
function computeAskDepth(book) {
  if (!book || !book.asks || book.asks.length === 0) return 0;
  let totalDollars = 0;
  for (const [price, size] of book.asks) {
    totalDollars += price * size;
  }
  return totalDollars;
}

/**
 * Evaluate market state for contrarian depth signal
 *
 * @param {Object} ctx - Strategy context (must include downBook)
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook, downBook, vwapSources, openPrices } = ctx;
  const { market } = windowState;

  if (!upBook || upBook.mid == null) return null;

  const clobUpPrice = upBook.mid;
  const conviction = Math.abs(clobUpPrice - 0.50);

  // Only fire when CLOB is decided
  if (conviction < 0.20) return null;

  // Skip extremes where no contrarian book exists
  if (clobUpPrice < 0.03 || clobUpPrice > 0.97) return null;

  // Determine contrarian side and get its book
  const clobDirection = clobUpPrice >= 0.50 ? 'up' : 'down';
  const contrarianSide = clobDirection === 'up' ? 'down' : 'up';

  let contrarianBook;
  if (contrarianSide === 'down') {
    contrarianBook = downBook;
  } else {
    contrarianBook = upBook; // If CLOB says DOWN, UP token is contrarian
  }

  if (!contrarianBook || !contrarianBook.asks || contrarianBook.asks.length === 0) return null;

  const contrarianDepthDollars = computeAskDepth(contrarianBook);
  const contrarianBestAsk = contrarianBook.bestAsk || null;
  const contrarianSpread = contrarianBook.spread || null;
  const contrarianAskLevels = contrarianBook.asks.length;

  // Get VWAP direction for metadata (not required for signal)
  let vwapDirection = null;
  if (vwapSources.composite && openPrices.composite > 0) {
    const vwapDelta = vwapSources.composite.vwap - openPrices.composite;
    vwapDirection = vwapDelta >= 0 ? 'up' : 'down';
  }

  // Entry = contrarian side
  const entrySide = contrarianSide;
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    clobDirection,
    clobUpPrice,
    conviction,
    contrarianDepthDollars,
    contrarianBestAsk,
    contrarianSpread,
    contrarianAskLevels,
    vwapDirection,
    chainlinkPrice: ctx.chainlinkPrice,
    exchangeCount: vwapSources.composite?.exchangeCount ?? null,
    totalVolume: vwapSources.composite?.totalVolume ?? null,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { minConviction, minDepthDollars, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;

  const minConviction = variation.minConviction ?? 0.25;
  const minDepth = variation.minDepthDollars ?? 5;

  return state.conviction >= minConviction && state.contrarianDepthDollars >= minDepth;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  // ETH and XRP — where crossovers were observed
  return crypto === 'eth' || crypto === 'xrp';
}
