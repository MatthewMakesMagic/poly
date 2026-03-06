/**
 * Hyper-Contrarian Endgame
 *
 * The "holy shit" bet: CLOB is 90%+ confident with <30s remaining,
 * but CL is razor-thin near the strike. The market is massively
 * overpricing certainty on what is essentially noise.
 *
 * From Stage 2 analysis: 39% of 80/20 flips had CL moves < $10.
 * At 90/20, the market prices ~90% certainty but ~6% flip rate.
 * When CL delta is tiny, true probability is much closer to 50%.
 *
 * Entry: CLOB >90% one way, CL within $N of strike, final 30s.
 * Buys the cheap side at $0.05-$0.15 for a potential 5-10x payout.
 */

export const name = 'hyper-contrarian-endgame';
export const description = 'Fade extreme CLOB confidence in final 30s when CL is tight. Buys cheap tokens for asymmetric payout.';

export const defaults = {
  minClobConfidence: 0.90,    // CLOB must be 90%+ one way
  maxClDelta: 15,             // CL must be within $15 of strike (tight)
  entryWindowMs: 30000,       // Only in final 30s
  maxEntryPrice: 0.20,        // Cheap tokens only (high asymmetry)
  capitalPerTrade: 2,
};

export const sweepGrid = {
  minClobConfidence: [0.85, 0.90, 0.95],
  maxClDelta: [10, 15, 20, 30],
  entryWindowMs: [15000, 30000, 45000],
  maxEntryPrice: [0.10, 0.15, 0.20, 0.25],
};

let hasBought = false;

export function onWindowOpen() { hasBought = false; }

export function evaluate(state, config) {
  if (hasBought) return [];
  const {
    minClobConfidence = defaults.minClobConfidence,
    maxClDelta = defaults.maxClDelta,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
  } = config;

  const { chainlink, clobUp, clobDown, window: win, oraclePriceAtOpen } = state;
  if (!win || !chainlink?.price || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  // Resolution = CL@close >= CL@open, so "tightness" = how close CL is to CL@open
  const clOpen = oraclePriceAtOpen || state.strike;
  if (clOpen == null) return [];
  const clDelta = Math.abs(chainlink.price - clOpen);
  if (clDelta > maxClDelta) return [];  // CL has moved too far — market may be right

  // CLOB strongly favors UP → buy cheap DOWN
  if (clobUp.mid >= minClobConfidence && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `hyper_contra: CLOB_UP=${clobUp.mid.toFixed(3)}, CL_delta=$${clDelta.toFixed(1)}, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  // CLOB strongly favors DOWN → buy cheap UP
  if (clobDown.mid >= minClobConfidence && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `hyper_contra: CLOB_DOWN=${clobDown.mid.toFixed(3)}, CL_delta=$${clDelta.toFixed(1)}, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  return [];
}
