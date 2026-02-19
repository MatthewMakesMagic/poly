/**
 * Crossover Spread Strategy
 *
 * Thesis: When CLOB is strongly decided but the contrarian token's spread
 * is widening, MMs are pulling quotes = uncertainty about resolution.
 * This predicts crossovers (CLOB flipping from decided→opposite).
 *
 * Observed: eth-1771497000 DOWN spread went from $0.02 (T-90) to $0.36 (T-10)
 * before crossover. MMs pulling contrarian quotes = crossover incoming.
 *
 * Different from spread_widen: that strategy fires on any wide spread + VWAP delta.
 * This strategy specifically targets decided CLOB + wide contrarian spread.
 *
 * Applies to: ETH, XRP
 * Entry side: Contrarian (against CLOB direction)
 *
 * @module modules/paper-trader/crossover-spread-strategy
 */

/**
 * Evaluate market state for crossover spread signal
 *
 * @param {Object} ctx - Strategy context (must include downBook)
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook, downBook } = ctx;
  const { market } = windowState;

  if (!upBook || upBook.mid == null) return null;

  const clobUpPrice = upBook.mid;
  const conviction = Math.abs(clobUpPrice - 0.50);

  // Only fire when CLOB is decided
  if (conviction < 0.20) return null;

  // Skip extremes
  if (clobUpPrice < 0.03 || clobUpPrice > 0.97) return null;

  // Determine contrarian side and get its book
  const clobDirection = clobUpPrice >= 0.50 ? 'up' : 'down';
  const contrarianSide = clobDirection === 'up' ? 'down' : 'up';

  let contrarianBook;
  if (contrarianSide === 'down') {
    contrarianBook = downBook;
  } else {
    contrarianBook = upBook;
  }

  // Need contrarian book with spread data
  if (!contrarianBook || contrarianBook.spread == null) return null;

  const contrarianSpread = contrarianBook.spread;
  const contrarianMid = contrarianBook.mid;

  // Also capture UP token spread for comparison
  const upSpread = upBook.spread;

  // Entry = contrarian side
  const entrySide = contrarianSide;
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    clobDirection,
    clobUpPrice,
    conviction,
    contrarianSpread,
    contrarianMid,
    upSpread,
    chainlinkPrice: ctx.chainlinkPrice,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { minConviction, minContrarianSpread, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;

  const minConviction = variation.minConviction ?? 0.25;
  const minSpread = variation.minContrarianSpread ?? 0.10;

  return state.conviction >= minConviction && state.contrarianSpread >= minSpread;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  // ETH and XRP — where crossovers and spread patterns observed
  return crypto === 'eth' || crypto === 'xrp';
}
