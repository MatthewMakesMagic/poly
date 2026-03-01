/**
 * Contested Window Contrarian Strategy + L2 Order Book
 *
 * Enhanced version of contested-contrarian that also uses L2 order book
 * data (bid/ask depth, spread, imbalance) as additional confirmation signals.
 *
 * L2 features:
 * - Bid/ask depth imbalance (more depth on bid side => UP pressure)
 * - Spread (tighter spread = more confidence in current price)
 * - CLOB depth ratio (bid_size / ask_size from CLOB snapshots)
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'contested-contrarian-l2';

export const defaults = {
  maxClobBias: 0.65,
  minClobBias: 0.35,
  exchangeThreshold: 15,
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  positionSize: 1,
  // L2 params
  minDepthImbalance: 0.0,     // Min bid/ask depth ratio to confirm (0 = no L2 filter)
  useL2Confirmation: true,    // Whether to require L2 confirmation
};

export const sweepGrid = {
  exchangeThreshold: [10, 15, 20, 30],
  maxEntryPrice: [0.55, 0.60, 0.65],
  minDepthImbalance: [0.0, 0.2, 0.5, 1.0],
};

let hasBought = false;

export function onWindowOpen(state, config) {
  hasBought = false;
}

export function evaluate(state, config) {
  const {
    maxClobBias = defaults.maxClobBias,
    minClobBias = defaults.minClobBias,
    exchangeThreshold = defaults.exchangeThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    positionSize = defaults.positionSize,
    minDepthImbalance = defaults.minDepthImbalance,
    useL2Confirmation = defaults.useL2Confirmation,
  } = config;

  const { strike, clobUp, clobDown, window: win } = state;
  if (hasBought) return [];
  if (!win || strike == null || !clobUp || !clobDown) return [];

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  // Contested check
  const upMid = clobUp.mid;
  const downMid = clobDown.mid;
  if (upMid > maxClobBias || downMid > maxClobBias) return [];
  if (upMid < minClobBias || downMid < minClobBias) return [];

  // Exchange median direction
  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];
  const exchangeDiff = exchangeMedian - strike;

  // L2 confirmation: use CLOB bid/ask sizes as proxy for L2 depth
  // When available, bidSize/askSize from CLOB snapshots reflect market depth
  let l2ConfirmsUp = true;
  let l2ConfirmsDown = true;

  if (useL2Confirmation && minDepthImbalance > 0) {
    // For UP direction: want more bid depth (buyers) on UP token
    const upBidAskRatio = clobUp.bidSize > 0 && clobUp.askSize > 0
      ? (clobUp.bidSize - clobUp.askSize) / (clobUp.bidSize + clobUp.askSize)
      : 0;
    // For DOWN direction: want more bid depth on DOWN token
    const downBidAskRatio = clobDown.bidSize > 0 && clobDown.askSize > 0
      ? (clobDown.bidSize - clobDown.askSize) / (clobDown.bidSize + clobDown.askSize)
      : 0;

    l2ConfirmsUp = upBidAskRatio >= minDepthImbalance;
    l2ConfirmsDown = downBidAskRatio >= minDepthImbalance;
  }

  if (exchangeDiff > exchangeThreshold && clobUp.bestAsk <= maxEntryPrice && l2ConfirmsUp) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-up`,
      size: positionSize,
      reason: `contested_l2: exch $${exchangeDiff.toFixed(0)} above, UP=${upMid.toFixed(3)}, L2_ok`,
      confidence: Math.min(Math.abs(exchangeDiff) / 50, 1),
    }];
  }

  if (exchangeDiff < -exchangeThreshold && clobDown.bestAsk <= maxEntryPrice && l2ConfirmsDown) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-down`,
      size: positionSize,
      reason: `contested_l2: exch $${exchangeDiff.toFixed(0)} below, DOWN=${downMid.toFixed(3)}, L2_ok`,
      confidence: Math.min(Math.abs(exchangeDiff) / 50, 1),
    }];
  }

  return [];
}
