/**
 * Fill Simulator
 *
 * Pure function that walks the ask side of an L2 order book to simulate
 * filling a dollar-denominated order against real book depth.
 *
 * No state, no side effects — just math.
 *
 * @module modules/paper-trader/fill-simulator
 */

/**
 * Simulate filling a buy order against the ask side of an L2 book
 *
 * Walks ask levels ascending (best price first). At each level, takes
 * min(remaining dollars, level dollar value). Computes effective fill
 * price as VWAP across consumed levels.
 *
 * @param {Object} book - Order book from CLOB WS client
 * @param {Array} book.asks - Ask levels [[price, size], ...] sorted ascending
 * @param {number} book.bestAsk - Best ask price
 * @param {number} dollars - Dollar amount to fill
 * @param {Object} [options={}] - Options
 * @param {number} [options.feeRate=0.0] - Fee rate (0.0 = no fees)
 * @returns {Object} Fill simulation result
 */
export function simulateFill(book, dollars, options = {}) {
  const { feeRate = 0.0 } = options;

  if (!book || !book.asks || book.asks.length === 0 || !book.bestAsk) {
    return {
      success: false,
      vwapPrice: null,
      bestAsk: null,
      slippage: null,
      totalShares: 0,
      totalCost: 0,
      fees: 0,
      netCost: 0,
      levelsConsumed: 0,
      unfilled: dollars,
      partialFill: false,
      marketImpact: null,
      fills: [],
    };
  }

  const bestAsk = book.bestAsk;
  let remainingDollars = dollars;
  let totalShares = 0;
  let totalCost = 0;
  let levelsConsumed = 0;
  const fills = [];

  // Walk ask levels ascending (already sorted by getBook)
  for (const [price, size] of book.asks) {
    if (remainingDollars <= 0) break;

    // Dollar value available at this level
    // In Polymarket, shares cost `price` each, so dollar value = price * size
    const levelDollars = price * size;
    const takeDollars = Math.min(remainingDollars, levelDollars);
    const takeShares = takeDollars / price;

    fills.push({
      price,
      size: takeShares,
      dollars: takeDollars,
    });

    totalShares += takeShares;
    totalCost += takeDollars;
    remainingDollars -= takeDollars;
    levelsConsumed++;
  }

  if (totalCost <= 0 || totalShares <= 0) {
    return {
      success: false,
      vwapPrice: null,
      bestAsk,
      slippage: null,
      totalShares: 0,
      totalCost: 0,
      fees: 0,
      netCost: 0,
      levelsConsumed: 0,
      unfilled: dollars,
      partialFill: false,
      marketImpact: null,
      fills: [],
    };
  }

  const vwapPrice = totalCost / totalShares;
  const slippage = vwapPrice - bestAsk;
  const marketImpact = bestAsk > 0 ? slippage / bestAsk : 0;
  const fees = totalCost * feeRate;
  const netCost = totalCost + fees;
  const partialFill = remainingDollars > 0.01; // > 1 cent unfilled

  return {
    success: true,
    vwapPrice,
    bestAsk,
    slippage,
    totalShares,
    totalCost,
    fees,
    netCost,
    levelsConsumed,
    unfilled: remainingDollars,
    partialFill,
    marketImpact,
    fills,
  };
}
