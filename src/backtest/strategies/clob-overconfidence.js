/**
 * CLOB Overconfidence — No Direction Filter
 *
 * When CLOB is 60-80% confident AND CL is in the Goldilocks zone
 * ($3-$10 from open), buy the cheap side regardless of CL direction.
 *
 * Theory: when CL has moved $3-$10 from open, it's not yet clear
 * which side wins. CLOB at 60-80% is overconfident.
 *
 * This variant does NOT require CL to disagree with CLOB — it just
 * buys the cheap side whenever CL is in the sweet spot and CLOB
 * is moderately confident.
 */

export const name = 'clob-overconfidence';
export const description = 'Buy cheap side when CLOB 60-80% and CL in Goldilocks $3-$10 zone. No direction filter.';

export const defaults = {
  minClobConfidence: 0.60,
  maxClobConfidence: 0.80,
  entryWindowMs: 15000,
  maxEntryPrice: 0.45,
  capitalPerTrade: 2,
  minClDelta: 3,
  maxClDelta: 10,
};

export const sweepGrid = {
  minClobConfidence: [0.55, 0.60, 0.65],
  maxClobConfidence: [0.75, 0.80, 0.85],
  entryWindowMs: [10000, 15000, 30000],
  minClDelta: [0, 3, 5],
  maxClDelta: [8, 10, 15],
};

let hasBought = false;

export function onWindowOpen() { hasBought = false; }

export function evaluate(state, config) {
  if (hasBought) return [];
  const {
    minClobConfidence = defaults.minClobConfidence,
    maxClobConfidence = defaults.maxClobConfidence,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
    minClDelta = defaults.minClDelta,
    maxClDelta = defaults.maxClDelta,
  } = config;

  const { chainlink, clobUp, clobDown, window: win, oraclePriceAtOpen } = state;
  if (!win || !chainlink?.price || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  const clOpen = oraclePriceAtOpen || state.strike;
  if (clOpen == null) return [];

  // CL delta range — Goldilocks zone
  const clDelta = Math.abs(chainlink.price - clOpen);
  if (clDelta < minClDelta || clDelta > maxClDelta) return [];

  // CLOB overconfident
  const clobConfidence = Math.max(clobUp.mid, clobDown.mid);
  if (clobConfidence < minClobConfidence || clobConfidence >= maxClobConfidence) return [];

  // Buy the cheap side
  if (clobUp.mid >= 0.50 && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `overconf: CLOB_UP=${(clobUp.mid*100).toFixed(0)}%, CL_delta=$${clDelta.toFixed(1)}, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }
  if (clobDown.mid >= 0.50 && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `overconf: CLOB_DOWN=${(clobDown.mid*100).toFixed(0)}%, CL_delta=$${clDelta.toFixed(1)}, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  return [];
}
