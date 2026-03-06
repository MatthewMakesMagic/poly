/**
 * CL Disagrees With CLOB — Wide Search
 *
 * Uses Goldilocks delta ($3-$10) but with wider CLOB confidence (55-85%)
 * and mid-range timing (T-30s). Tests whether the edge extends
 * beyond the 60-80% sweet spot.
 *
 * Diagnostic showed T-30, Δ$3-10: 30 trades, 43% WR, +$5.50
 * — wider timing captures more trades but at lower WR.
 */

export const name = 'cl-disagrees-wide';
export const description = 'CL disagrees + Goldilocks delta, wider confidence range (55-85%), T-30s entry.';

export const defaults = {
  minClobConfidence: 0.55,
  maxClobConfidence: 0.85,
  entryWindowMs: 30000,       // T-30s — more trades than T-15
  maxEntryPrice: 0.50,
  capitalPerTrade: 2,
  minClDelta: 3,
  maxClDelta: 10,
};

export const sweepGrid = {
  minClobConfidence: [0.50, 0.55, 0.60],
  maxClobConfidence: [0.80, 0.85, 0.90],
  entryWindowMs: [15000, 30000, 45000],
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

  const clAboveOpen = chainlink.price - clOpen;
  const clDir = clAboveOpen >= 0 ? 'UP' : 'DOWN';
  const absDelta = Math.abs(clAboveOpen);

  // Delta range filter
  if (absDelta < minClDelta || absDelta > maxClDelta) return [];

  const clobConfidence = Math.max(clobUp.mid, clobDown.mid);
  if (clobConfidence < minClobConfidence || clobConfidence >= maxClobConfidence) return [];
  const clobDir = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';

  if (clobDir === clDir) return [];

  if (clDir === 'UP' && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `cl_wide: CL +$${clAboveOpen.toFixed(1)}, CLOB=${clobDir} ${(clobConfidence*100).toFixed(0)}%, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }
  if (clDir === 'DOWN' && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `cl_wide: CL $${clAboveOpen.toFixed(1)}, CLOB=${clobDir} ${(clobConfidence*100).toFixed(0)}%, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  return [];
}
