/**
 * CL Disagrees With CLOB — Goldilocks Delta
 *
 * Core edge: when CLOB is 60-80% confident in one direction but
 * Chainlink (the settlement oracle) is already on the OPPOSITE side
 * of CL@open, bet with CL — but ONLY when CL delta is in the
 * "Goldilocks zone" of $3-$10.
 *
 * Resolution = CL@close >= CL@open (both Chainlink Data Streams).
 *
 * Why delta range matters:
 *   - $0-3:  CL barely crossed, easily flips back → ~28% WR
 *   - $3-10: CL crossed meaningfully, MMs haven't updated → ~65% WR
 *   - $10+:  MMs likely have better info, CLOB is probably right → ~15% WR
 *
 * Late entry (T-15s) ensures CL has less time to reverse.
 *
 * Backtest: 15-16 trades, ~65% WR, +$9-10, ~$0.60/trade
 */

export const name = 'cl-disagrees-with-clob';
export const description = 'Bet with CL when CLOB 60-80% disagrees, CL delta $3-$10 from open, last 15s of window.';

export const defaults = {
  minClobConfidence: 0.60,   // CLOB dominant side must be 60%+
  maxClobConfidence: 0.80,   // But not too decided (>80% = CLOB probably right)
  entryWindowMs: 15000,      // Last 15s of window (late entry = CL more locked)
  maxEntryPrice: 0.45,       // Cheap side typically $0.20-$0.40
  capitalPerTrade: 2,
  minClDelta: 3,             // CL must be at least $3 from CL@open
  maxClDelta: 10,            // But not more than $10 (MMs probably right above this)
};

export const sweepGrid = {
  minClobConfidence: [0.55, 0.60, 0.65],
  maxClobConfidence: [0.75, 0.80, 0.85],
  entryWindowMs: [10000, 15000, 20000, 30000],
  minClDelta: [0, 3, 5],
  maxClDelta: [8, 10, 15, Infinity],
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

  // Where is CL relative to CL@open?
  const clAboveOpen = chainlink.price - clOpen;  // positive = CL above open = UP
  const clDir = clAboveOpen >= 0 ? 'UP' : 'DOWN';
  const absDelta = Math.abs(clAboveOpen);

  // Delta range filter: must be in Goldilocks zone
  if (absDelta < minClDelta || absDelta > maxClDelta) return [];

  // CLOB direction and confidence
  const clobConfidence = Math.max(clobUp.mid, clobDown.mid);
  if (clobConfidence < minClobConfidence || clobConfidence >= maxClobConfidence) return [];
  const clobDir = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';

  // The signal: CL and CLOB disagree
  if (clobDir === clDir) return [];

  // CL says UP but CLOB says DOWN → buy UP (cheap side)
  if (clDir === 'UP' && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `cl_disagree: CL=${clDir} (+$${clAboveOpen.toFixed(1)}), CLOB=${clobDir} (${(clobConfidence*100).toFixed(0)}%), T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  // CL says DOWN but CLOB says UP → buy DOWN (cheap side)
  if (clDir === 'DOWN' && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `cl_disagree: CL=${clDir} ($${clAboveOpen.toFixed(1)}), CLOB=${clobDir} (${(clobConfidence*100).toFixed(0)}%), T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  return [];
}
