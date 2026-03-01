/**
 * Exchange Consensus Strategy
 *
 * Follows the consensus direction of multiple exchanges.
 * If 3+ exchanges agree on direction relative to strike, bet that direction.
 * More conservative than single-exchange: requires multi-exchange agreement.
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'exchange-consensus';

export const defaults = {
  minExchangesAgreeing: 3,   // At least N exchanges must agree
  exchangeThreshold: 20,     // Each exchange must be this far from strike
  entryWindowMs: 120000,     // Last 2 min
  maxEntryPrice: 0.75,
  positionSize: 1,
};

export const sweepGrid = {
  minExchangesAgreeing: [2, 3, 4],
  exchangeThreshold: [10, 20, 30, 50],
  entryWindowMs: [60000, 90000, 120000, 180000],
  maxEntryPrice: [0.65, 0.70, 0.75, 0.80],
};

let hasBought = false;

export function onWindowOpen(state, config) {
  hasBought = false;
}

export function evaluate(state, config) {
  const {
    minExchangesAgreeing = defaults.minExchangesAgreeing,
    exchangeThreshold = defaults.exchangeThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    positionSize = defaults.positionSize,
  } = config;

  const { strike, clobUp, clobDown, window: win } = state;
  if (hasBought) return [];
  if (!win || strike == null) return [];

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  const exchanges = state.getAllExchanges();
  if (exchanges.length < minExchangesAgreeing) return [];

  // Count how many exchanges are above/below strike
  let aboveCount = 0;
  let belowCount = 0;
  for (const ex of exchanges) {
    if (ex.price == null) continue;
    const diff = ex.price - strike;
    if (diff > exchangeThreshold) aboveCount++;
    else if (diff < -exchangeThreshold) belowCount++;
  }

  // Strong UP consensus
  if (aboveCount >= minExchangesAgreeing && clobUp && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-up`,
      size: positionSize,
      reason: `exch_consensus: ${aboveCount}/${exchanges.length} above strike by $${exchangeThreshold}+`,
      confidence: Math.min(aboveCount / exchanges.length, 1),
    }];
  }

  // Strong DOWN consensus
  if (belowCount >= minExchangesAgreeing && clobDown && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-down`,
      size: positionSize,
      reason: `exch_consensus: ${belowCount}/${exchanges.length} below strike by $${exchangeThreshold}+`,
      confidence: Math.min(belowCount / exchanges.length, 1),
    }];
  }

  return [];
}
