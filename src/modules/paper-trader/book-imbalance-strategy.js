/**
 * Book Imbalance Strategy
 *
 * Computes bid/ask depth ratio from the L2 order book within 5 cents
 * of the mid price. When one side has significantly more depth,
 * bet on that side (more depth = more conviction from MMs).
 *
 * BTC only — only instrument with L2 data.
 *
 * @module modules/paper-trader/book-imbalance-strategy
 */

/**
 * Compute dollar depth within a price range from the book
 *
 * @param {Array} levels - [[price, size], ...] sorted array
 * @param {number} refPrice - Reference price (mid)
 * @param {number} rangeCents - Range in cents (e.g., 0.05 = 5 cents)
 * @param {string} side - 'bid' or 'ask'
 * @returns {number} Total dollar depth within range
 */
function computeDepth(levels, refPrice, rangeCents, side) {
  let depth = 0;
  for (const [price, size] of levels) {
    if (side === 'bid' && price >= refPrice - rangeCents && price <= refPrice) {
      depth += price * size;
    } else if (side === 'ask' && price >= refPrice && price <= refPrice + rangeCents) {
      depth += price * size;
    }
  }
  return depth;
}

/**
 * Evaluate market state for book imbalance
 *
 * @param {Object} ctx - Strategy context
 * @returns {Object|null} Market state or null if data unavailable
 */
export function evaluateMarketState(ctx) {
  const { windowState, upBook } = ctx;
  const { market } = windowState;

  if (!upBook || upBook.mid == null) return null;
  if (!upBook.bids || !upBook.asks || upBook.bids.length === 0 || upBook.asks.length === 0) return null;

  // Skip extreme CLOB prices
  if (upBook.mid < 0.05 || upBook.mid > 0.95) return null;

  const mid = upBook.mid;
  const rangeCents = 0.05;

  const bidDepth = computeDepth(upBook.bids, mid, rangeCents, 'bid');
  const askDepth = computeDepth(upBook.asks, mid, rangeCents, 'ask');

  const totalDepth = bidDepth + askDepth;
  if (totalDepth <= 0) return null;

  // Imbalance ratio: fraction of depth on the dominant side
  const imbalanceRatio = Math.max(bidDepth, askDepth) / totalDepth;

  // Entry side: more bids = buyers want UP, more asks = sellers expect DOWN
  // Actually: more bids near mid = support for current price = UP
  // More asks near mid = resistance / selling pressure = DOWN side wins
  // In Polymarket UP token context: more bids = bullish on UP = entry UP
  const entrySide = bidDepth >= askDepth ? 'up' : 'down';
  const entryTokenId = entrySide === 'up' ? market.upTokenId : market.downTokenId;

  return {
    entrySide,
    entryTokenId,
    imbalanceRatio,
    bidDepth,
    askDepth,
    clobUpPrice: mid,
    chainlinkPrice: ctx.chainlinkPrice,
    exchangeCount: ctx.vwapSources?.composite?.exchangeCount ?? null,
    totalVolume: ctx.vwapSources?.composite?.totalVolume ?? null,
  };
}

/**
 * Check if a variation should fire
 *
 * @param {Object} state - From evaluateMarketState()
 * @param {Object} variation - { imbalanceThreshold, positionSizeDollars }
 * @returns {boolean}
 */
export function shouldFire(state, variation) {
  if (!state) return false;
  const threshold = variation.imbalanceThreshold ?? 0.60;
  return state.imbalanceRatio >= threshold;
}

/**
 * Check if this strategy applies
 *
 * @param {string} crypto
 * @param {number} signalOffsetSec
 * @returns {boolean}
 */
export function appliesTo(crypto, signalOffsetSec) {
  return crypto === 'btc'; // BTC only — only asset with L2 data
}
