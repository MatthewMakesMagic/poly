/**
 * CL Disagrees With CLOB — Very Late Entry (T-10)
 *
 * Same Goldilocks signal but enters even later: only last 10 seconds.
 * At T-10, CL is almost fully locked into final direction.
 *
 * Trades the tightest possible window where CL has crossed $3-$10
 * past CL@open but CLOB hasn't updated.
 *
 * Backtest: 10 trades, 70% WR, +$7.34
 */

export const name = 'cl-disagrees-tight';
export const description = 'CL disagrees + Goldilocks delta, last 10s only. Highest per-trade EV.';

export const defaults = {
  minClobConfidence: 0.60,
  maxClobConfidence: 0.80,
  entryWindowMs: 10000,       // Last 10s — CL almost locked
  maxEntryPrice: 0.45,
  capitalPerTrade: 2,
  minClDelta: 3,
  maxClDelta: 10,
};

export const sweepGrid = {
  minClobConfidence: [0.55, 0.60, 0.65],
  maxClobConfidence: [0.75, 0.80, 0.85],
  entryWindowMs: [5000, 10000, 15000],
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
      reason: `cl_tight: CL +$${clAboveOpen.toFixed(1)}, CLOB=${clobDir} ${(clobConfidence*100).toFixed(0)}%, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }
  if (clDir === 'DOWN' && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `cl_tight: CL $${clAboveOpen.toFixed(1)}, CLOB=${clobDir} ${(clobConfidence*100).toFixed(0)}%, T-${(win.timeToCloseMs/1000).toFixed(0)}s` }];
  }

  return [];
}
