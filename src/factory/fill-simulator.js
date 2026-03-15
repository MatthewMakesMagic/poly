/**
 * Factory Fill Simulator — L2 Book-Walking for Realistic Fills
 *
 * Ported from src/modules/paper-trader/fill-simulator.js and adapted
 * for the factory backtester. Walks L2 order book levels to compute
 * VWAP fill prices with slippage and market impact.
 *
 * When L2 data is unavailable, falls back to bestAsk + spread buffer
 * with a warning flag in the result.
 *
 * @module factory/fill-simulator
 */

import { calculateTakerFee, estimateMakerRebate, FeeMode } from './fee-model.js';

/**
 * Simulate a market buy order by walking the L2 ask side.
 *
 * Walks ask levels ascending (best price first). At each level,
 * takes min(remaining dollars, level dollar value). Computes effective
 * fill price as VWAP across consumed levels.
 *
 * @param {Object} book - Order book state from MarketState (clobUp or clobDown)
 * @param {number} dollars - Dollar amount to fill
 * @param {Object} [options]
 * @param {string} [options.feeMode='taker'] - FeeMode value
 * @param {number} [options.spreadBuffer=0.005] - Fallback spread buffer when no L2
 * @param {number} [options.marketShareEstimate=0.01] - For maker rebate
 * @returns {Object} Fill simulation result
 */
export function simulateMarketFill(book, dollars, options = {}) {
  const {
    feeMode = FeeMode.TAKER_ONLY,
    spreadBuffer = 0.005,
    marketShareEstimate = 0.01,
  } = options;

  // No book data at all — reject
  if (!book || !book.bestAsk) {
    return {
      success: false,
      reason: 'no_book_data: L2 order book not available for this tick. Strategy fired at a moment with no CLOB data.',
      vwapPrice: null,
      bestAsk: null,
      slippage: null,
      totalShares: 0,
      totalCost: 0,
      feeDollars: 0,
      netCost: 0,
      levelsConsumed: 0,
      unfilled: dollars,
      partialFill: false,
      marketImpact: null,
      fills: [],
      usedL2: false,
      feeMode,
    };
  }

  const bestAsk = book.bestAsk;
  const levels = book.levels;

  // If L2 levels are available, walk the book
  if (levels && levels.asks && levels.asks.length > 0) {
    return _walkAskLevels(levels.asks, bestAsk, dollars, feeMode, marketShareEstimate);
  }

  // Fallback: no L2 levels, use bestAsk + buffer
  return _fallbackFill(book, dollars, spreadBuffer, feeMode, marketShareEstimate);
}

/**
 * Walk ask levels to compute VWAP fill.
 *
 * @param {Array} asks - [[price, size], ...] sorted ascending by price
 * @param {number} bestAsk - Best ask price
 * @param {number} dollars - Dollar amount to fill
 * @param {string} feeMode - Fee mode
 * @param {number} marketShareEstimate - For maker rebate
 * @returns {Object} Fill result
 */
function _walkAskLevels(asks, bestAsk, dollars, feeMode, marketShareEstimate) {
  let remainingDollars = dollars;
  let totalShares = 0;
  let totalCost = 0;
  let levelsConsumed = 0;
  const fills = [];

  for (const [price, size] of asks) {
    if (remainingDollars <= 0) break;
    if (price <= 0 || price >= 1) continue; // skip invalid prices

    // Dollar value at this level: shares cost `price` each
    const levelDollars = price * size;
    const takeDollars = Math.min(remainingDollars, levelDollars);
    const takeShares = takeDollars / price;

    fills.push({ price, size: takeShares, dollars: takeDollars });

    totalShares += takeShares;
    totalCost += takeDollars;
    remainingDollars -= takeDollars;
    levelsConsumed++;
  }

  if (totalCost <= 0 || totalShares <= 0) {
    return {
      success: false,
      reason: 'empty_book: L2 asks exist but all levels have invalid prices (outside 0-1 range). Book may be from a nearly-resolved window.',
      vwapPrice: null,
      bestAsk,
      slippage: null,
      totalShares: 0,
      totalCost: 0,
      feeDollars: 0,
      netCost: 0,
      levelsConsumed: 0,
      unfilled: dollars,
      partialFill: false,
      marketImpact: null,
      fills: [],
      usedL2: true,
      feeMode,
    };
  }

  const vwapPrice = totalCost / totalShares;
  const slippage = vwapPrice - bestAsk;
  const marketImpact = bestAsk > 0 ? slippage / bestAsk : 0;
  const partialFill = remainingDollars > 0.01;

  // Apply fees
  const { feeDollars, netCost } = _applyFees(
    vwapPrice, totalShares, totalCost, feeMode, marketShareEstimate
  );

  return {
    success: true,
    vwapPrice,
    bestAsk,
    slippage,
    totalShares,
    totalCost,
    feeDollars,
    netCost,
    levelsConsumed,
    unfilled: remainingDollars,
    partialFill,
    marketImpact,
    fills,
    usedL2: true,
    feeMode,
  };
}

/**
 * Fallback fill when L2 levels are not available.
 * Uses bestAsk + spread buffer as fill price.
 * Flags the result so downstream can track L2 coverage.
 *
 * @param {Object} book - Book state with bestAsk
 * @param {number} dollars - Dollar amount
 * @param {number} spreadBuffer - Buffer to add to bestAsk
 * @param {string} feeMode - Fee mode
 * @param {number} marketShareEstimate - For maker rebate
 * @returns {Object} Fill result with l2Fallback=true
 */
function _fallbackFill(book, dollars, spreadBuffer, feeMode, marketShareEstimate) {
  const fillPrice = Math.min(book.bestAsk + spreadBuffer, 0.99);

  if (fillPrice <= 0 || fillPrice >= 1) {
    return {
      success: false,
      reason: `invalid_fallback_price: bestAsk(${book.bestAsk}) + buffer(${spreadBuffer}) = ${fillPrice} is outside tradeable range. Token is likely at an extreme.`,
      vwapPrice: null,
      bestAsk: book.bestAsk,
      slippage: null,
      totalShares: 0,
      totalCost: 0,
      feeDollars: 0,
      netCost: 0,
      levelsConsumed: 0,
      unfilled: dollars,
      partialFill: false,
      marketImpact: null,
      fills: [],
      usedL2: false,
      feeMode,
    };
  }

  const totalShares = dollars / fillPrice;
  const totalCost = dollars;
  const slippage = spreadBuffer;
  const marketImpact = book.bestAsk > 0 ? spreadBuffer / book.bestAsk : 0;

  const { feeDollars, netCost } = _applyFees(
    fillPrice, totalShares, totalCost, feeMode, marketShareEstimate
  );

  return {
    success: true,
    vwapPrice: fillPrice,
    bestAsk: book.bestAsk,
    slippage,
    totalShares,
    totalCost,
    feeDollars,
    netCost,
    levelsConsumed: 1,
    unfilled: 0,
    partialFill: false,
    marketImpact,
    fills: [{ price: fillPrice, size: totalShares, dollars }],
    usedL2: false,
    l2Fallback: true,
    l2FallbackReason: 'no_l2_levels: L2 book depth data not available for this tick. Using bestAsk + spread buffer as fill price estimate. Fill quality metrics (slippage, market impact) are approximate.',
    feeMode,
  };
}

/**
 * Apply fee calculation based on fee mode.
 *
 * @param {number} price - VWAP fill price
 * @param {number} size - Total shares
 * @param {number} totalCost - Gross cost
 * @param {string} feeMode - Fee mode
 * @param {number} marketShareEstimate - For maker rebate
 * @returns {{ feeDollars: number, netCost: number }}
 */
function _applyFees(price, size, totalCost, feeMode, marketShareEstimate) {
  if (feeMode === FeeMode.ZERO) {
    return { feeDollars: 0, netCost: totalCost };
  }

  if (feeMode === FeeMode.MAKER_REBATE) {
    const rebate = estimateMakerRebate(price, size, marketShareEstimate);
    return {
      feeDollars: -rebate.rebateDollars, // negative = income
      netCost: totalCost - rebate.rebateDollars,
    };
  }

  // TAKER_ONLY (default)
  const fee = calculateTakerFee(price, size);
  return {
    feeDollars: fee.feeDollars,
    netCost: totalCost + fee.feeDollars,
  };
}

/**
 * Simulate selling (exiting) shares against an L2 book.
 *
 * For UP positions: walks bids descending (best bid first)
 * For DOWN positions: walks asks ascending, converts to down-bid = 1 - upAskPrice
 *
 * @param {Object} book - Book state from MarketState
 * @param {number} shares - Number of shares to sell
 * @param {'up'|'down'} side - Which side the position is on
 * @param {Object} [options]
 * @param {string} [options.feeMode='taker'] - Fee mode
 * @param {number} [options.spreadBuffer=0.005] - Fallback buffer
 * @param {number} [options.marketShareEstimate=0.01]
 * @returns {Object} Exit simulation result
 */
export function simulateExit(book, shares, side, options = {}) {
  const {
    feeMode = FeeMode.TAKER_ONLY,
    spreadBuffer = 0.005,
    marketShareEstimate = 0.01,
  } = options;

  if (!book || shares <= 0) {
    return {
      success: false,
      reason: 'no_book_or_zero_shares: Cannot exit — either no book data or zero shares specified.',
      fillPrice: 0,
      proceeds: 0,
      feeDollars: 0,
      netProceeds: 0,
      filled: 0,
      unfilled: shares,
      usedL2: false,
      feeMode,
    };
  }

  const levels = book.levels;
  let remaining = shares;
  let proceeds = 0;
  let usedL2 = false;

  if (side === 'up') {
    // Walk bid levels if available
    if (levels && levels.bids && levels.bids.length > 0) {
      usedL2 = true;
      for (const [price, size] of levels.bids) {
        const fill = Math.min(remaining, size);
        proceeds += fill * price;
        remaining -= fill;
        if (remaining <= 0) break;
      }
    } else if (book.bestBid) {
      // Fallback: use bestBid - buffer
      const sellPrice = Math.max(book.bestBid - spreadBuffer, 0.01);
      proceeds = shares * sellPrice;
      remaining = 0;
    }
  } else {
    // DOWN: walk asks ascending, down-bid = 1 - upAskPrice
    if (levels && levels.asks && levels.asks.length > 0) {
      usedL2 = true;
      for (const [upAskPrice, size] of levels.asks) {
        const downBidPrice = 1.0 - upAskPrice;
        if (downBidPrice <= 0) continue;
        const fill = Math.min(remaining, size);
        proceeds += fill * downBidPrice;
        remaining -= fill;
        if (remaining <= 0) break;
      }
    } else if (book.bestBid) {
      const sellPrice = Math.max(book.bestBid - spreadBuffer, 0.01);
      proceeds = shares * sellPrice;
      remaining = 0;
    }
  }

  const filled = shares - remaining;
  if (filled <= 0) {
    return {
      success: false,
      reason: 'no_fills: Could not fill any shares against available book depth. Book may be empty or all levels exhausted.',
      fillPrice: 0,
      proceeds: 0,
      feeDollars: 0,
      netProceeds: 0,
      filled: 0,
      unfilled: shares,
      usedL2,
      feeMode,
    };
  }

  const fillPrice = proceeds / filled;

  // Apply exit fee
  const { feeDollars, netCost } = _applyFees(
    fillPrice, filled, proceeds, feeMode, marketShareEstimate
  );

  return {
    success: true,
    fillPrice,
    proceeds,
    feeDollars,
    netProceeds: proceeds - Math.abs(feeDollars), // fee reduces proceeds on exit
    filled,
    unfilled: remaining,
    usedL2,
    feeMode,
  };
}

/**
 * Check if a limit order would be filled against current book state.
 *
 * A limit buy fills when the best ask crosses below/at order price.
 * A limit sell fills when the best bid crosses above/at order price.
 *
 * Maker fills earn rebate instead of paying taker fee.
 *
 * @param {Object} order - { side: 'buy'|'sell', price, size, token }
 * @param {Object} book - Book state from MarketState
 * @param {Object} [options]
 * @param {string} [options.feeMode='maker'] - Fee mode (default maker for limit orders)
 * @param {number} [options.marketShareEstimate=0.01]
 * @returns {Object} Limit fill result
 */
export function checkLimitFill(order, book, options = {}) {
  const {
    feeMode = FeeMode.MAKER_REBATE,
    marketShareEstimate = 0.01,
  } = options;

  if (!book || !order) {
    return {
      filled: false,
      reason: 'no_book_data: Cannot check limit fill without book data.',
      price: order?.price || 0,
      feeMode,
    };
  }

  const isBuy = order.side === 'buy' || order.side === 'bid';

  if (isBuy) {
    // Limit buy fills when bestAsk <= order price
    if (!book.bestAsk || book.bestAsk > order.price) {
      return {
        filled: false,
        reason: `limit_not_crossed: bestAsk(${book.bestAsk}) > limitPrice(${order.price}). Order resting.`,
        price: order.price,
        feeMode,
      };
    }
  } else {
    // Limit sell fills when bestBid >= order price
    if (!book.bestBid || book.bestBid < order.price) {
      return {
        filled: false,
        reason: `limit_not_crossed: bestBid(${book.bestBid}) < limitPrice(${order.price}). Order resting.`,
        price: order.price,
        feeMode,
      };
    }
  }

  // Limit order filled at limit price (passive fill, no slippage)
  const fillPrice = order.price;
  const size = order.size;
  const grossValue = fillPrice * size;

  // Makers earn rebate
  let feeDollars = 0;
  let rebateDollars = 0;
  if (feeMode === FeeMode.MAKER_REBATE) {
    const rebate = estimateMakerRebate(fillPrice, size, marketShareEstimate);
    rebateDollars = rebate.rebateDollars;
    feeDollars = -rebateDollars; // negative = income
  } else if (feeMode === FeeMode.TAKER_ONLY) {
    const fee = calculateTakerFee(fillPrice, size);
    feeDollars = fee.feeDollars;
  }

  return {
    filled: true,
    price: fillPrice,
    size,
    grossValue,
    feeDollars,
    rebateDollars,
    netCost: isBuy ? grossValue + feeDollars : -(grossValue - Math.abs(feeDollars)),
    feeMode,
  };
}

/**
 * Aggregate fill quality metrics across multiple fills.
 *
 * @param {Object[]} fills - Array of fill results from simulateMarketFill
 * @returns {Object} Aggregated quality metrics
 */
export function aggregateFillMetrics(fills) {
  const successful = fills.filter(f => f.success);
  if (successful.length === 0) {
    return {
      count: 0,
      avgSlippage: 0,
      avgMarketImpact: 0,
      totalFees: 0,
      l2CoverageRate: 0,
      avgLevelsConsumed: 0,
      partialFillRate: 0,
    };
  }

  const totalSlippage = successful.reduce((s, f) => s + (f.slippage || 0), 0);
  const totalImpact = successful.reduce((s, f) => s + (f.marketImpact || 0), 0);
  const totalFees = successful.reduce((s, f) => s + (f.feeDollars || 0), 0);
  const l2Count = successful.filter(f => f.usedL2).length;
  const totalLevels = successful.reduce((s, f) => s + (f.levelsConsumed || 0), 0);
  const partialCount = successful.filter(f => f.partialFill).length;

  return {
    count: successful.length,
    avgSlippage: totalSlippage / successful.length,
    avgMarketImpact: totalImpact / successful.length,
    totalFees,
    l2CoverageRate: l2Count / successful.length,
    avgLevelsConsumed: totalLevels / successful.length,
    partialFillRate: partialCount / successful.length,
  };
}
