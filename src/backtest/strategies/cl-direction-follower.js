/**
 * Chainlink Direction Follower Strategy
 *
 * Simple but critical baseline: resolution is CL@close >= CL@open ? UP : DOWN.
 * If we can observe CL trending in one direction during the window, we
 * bet on that direction using CLOB.
 *
 * Compares latest CL price to strike_price (which approximates CL@open).
 * When CL is clearly above strike, buy UP. When clearly below, buy DOWN.
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'cl-direction-follower';

export const defaults = {
  clThreshold: 30,            // CL must be this many $ above/below strike to trigger
  entryWindowMs: 120000,      // Only enter in last 2 min
  maxEntryPrice: 0.85,        // Max price willing to pay (can buy expensive if CL signal strong)
  positionSize: 1,
  exitIfFlip: false,          // Sell if CL direction reverses before close
};

export const sweepGrid = {
  clThreshold: [10, 20, 30, 50, 75, 100],
  entryWindowMs: [60000, 90000, 120000, 180000],
  maxEntryPrice: [0.70, 0.75, 0.80, 0.85],
};

let hasBought = false;
let boughtDirection = null;

export function onWindowOpen(state, config) {
  hasBought = false;
  boughtDirection = null;
}

export function evaluate(state, config) {
  const {
    clThreshold = defaults.clThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    positionSize = defaults.positionSize,
  } = config;

  const { strike, chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !chainlink?.price || strike == null) return [];
  if (hasBought) return [];

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  const clAboveStrike = chainlink.price - strike;

  // CL clearly above strike => likely UP resolution
  if (clAboveStrike > clThreshold && clobUp && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    boughtDirection = 'up';
    return [{
      action: 'buy',
      token: `${win.symbol}-up`,
      size: positionSize,
      reason: `cl_follow: CL $${clAboveStrike.toFixed(0)} above strike`,
      confidence: Math.min(clAboveStrike / 100, 1),
    }];
  }

  // CL clearly below strike => likely DOWN resolution
  if (clAboveStrike < -clThreshold && clobDown && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    boughtDirection = 'down';
    return [{
      action: 'buy',
      token: `${win.symbol}-down`,
      size: positionSize,
      reason: `cl_follow: CL $${Math.abs(clAboveStrike).toFixed(0)} below strike`,
      confidence: Math.min(Math.abs(clAboveStrike) / 100, 1),
    }];
  }

  return [];
}
