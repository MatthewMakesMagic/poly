/**
 * Contested Window Contrarian Strategy
 *
 * Specifically targets contested windows (CLOB near 50/50) where CL and
 * exchanges disagree. In these close windows, bets with the exchange
 * direction since exchanges lead CL by ~5s.
 *
 * Filters for windows where neither UP nor DOWN is above 0.65 on CLOB,
 * then uses exchange median to determine direction.
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'contested-contrarian';

export const defaults = {
  maxClobBias: 0.65,         // Max CLOB price for either side (must be contested)
  minClobBias: 0.35,         // Min CLOB price for either side
  exchangeThreshold: 15,     // Exchange must lean this far from strike
  entryWindowMs: 90000,      // Last 90s
  maxEntryPrice: 0.60,       // Max token price (contested windows should be near 0.50)
  positionSize: 1,
};

export const sweepGrid = {
  maxClobBias: [0.60, 0.65, 0.70],
  exchangeThreshold: [10, 15, 20, 30, 50],
  entryWindowMs: [60000, 90000, 120000],
  maxEntryPrice: [0.55, 0.60, 0.65],
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
  } = config;

  const { strike, clobUp, clobDown, window: win } = state;
  if (hasBought) return [];
  if (!win || strike == null || !clobUp || !clobDown) return [];

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  // Check if window is contested (both sides between min and max)
  const upMid = clobUp.mid;
  const downMid = clobDown.mid;
  if (upMid > maxClobBias || downMid > maxClobBias) return [];
  if (upMid < minClobBias || downMid < minClobBias) return [];

  // Use exchange median to pick direction
  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];

  const exchangeDiff = exchangeMedian - strike;

  if (exchangeDiff > exchangeThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-up`,
      size: positionSize,
      reason: `contested_contra: exch $${exchangeDiff.toFixed(0)} above, CLOB UP=${upMid.toFixed(3)}`,
      confidence: Math.min(Math.abs(exchangeDiff) / 50, 1),
    }];
  }

  if (exchangeDiff < -exchangeThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-down`,
      size: positionSize,
      reason: `contested_contra: exch $${exchangeDiff.toFixed(0)} below, CLOB DOWN=${downMid.toFixed(3)}`,
      confidence: Math.min(Math.abs(exchangeDiff) / 50, 1),
    }];
  }

  return [];
}
