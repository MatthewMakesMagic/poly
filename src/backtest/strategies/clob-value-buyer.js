/**
 * CLOB Value Buyer Strategy (Contrarian)
 *
 * Buys whichever token is trading below "fair value" based on CL position.
 * If CL is above strike (suggesting UP), but UP tokens are cheap (<threshold),
 * buys UP — the market is mispricing the likely outcome.
 *
 * Core insight: CLOB prices reflect MM risk assessment, which sometimes
 * diverges from the actual oracle reading. Buy the underpriced token.
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'clob-value-buyer';

export const defaults = {
  maxPrice: 0.55,            // Max price for the "value" token (must be cheap)
  clSignalThreshold: 20,     // CL must suggest direction by this many $
  entryWindowMs: 180000,     // Enter in last 3 min
  positionSize: 1,
};

export const sweepGrid = {
  maxPrice: [0.40, 0.45, 0.50, 0.55, 0.60],
  clSignalThreshold: [10, 20, 30, 50],
  entryWindowMs: [120000, 180000, 240000],
};

let hasBought = false;

export function onWindowOpen(state, config) {
  hasBought = false;
}

export function evaluate(state, config) {
  const {
    maxPrice = defaults.maxPrice,
    clSignalThreshold = defaults.clSignalThreshold,
    entryWindowMs = defaults.entryWindowMs,
    positionSize = defaults.positionSize,
  } = config;

  const { strike, chainlink, clobUp, clobDown, window: win } = state;
  if (hasBought) return [];
  if (!win || !chainlink?.price || strike == null) return [];

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  const clAboveStrike = chainlink.price - strike;

  // CL says UP but UP tokens are cheap => value buy
  if (clAboveStrike > clSignalThreshold && clobUp && clobUp.bestAsk <= maxPrice) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-up`,
      size: positionSize,
      reason: `value_buy: CL $${clAboveStrike.toFixed(0)} above, UP ask=${clobUp.bestAsk.toFixed(3)}`,
      confidence: Math.min((1 - clobUp.bestAsk) * clAboveStrike / 50, 1),
    }];
  }

  // CL says DOWN but DOWN tokens are cheap => value buy
  if (clAboveStrike < -clSignalThreshold && clobDown && clobDown.bestAsk <= maxPrice) {
    hasBought = true;
    return [{
      action: 'buy',
      token: `${win.symbol}-down`,
      size: positionSize,
      reason: `value_buy: CL $${Math.abs(clAboveStrike).toFixed(0)} below, DOWN ask=${clobDown.bestAsk.toFixed(3)}`,
      confidence: Math.min((1 - clobDown.bestAsk) * Math.abs(clAboveStrike) / 50, 1),
    }];
  }

  return [];
}
