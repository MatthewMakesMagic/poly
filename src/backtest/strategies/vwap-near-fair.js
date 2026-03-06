/**
 * VWAP Near-Fair Contrarian
 *
 * Same VWAP contrarian logic but with a conviction gate:
 * only fires when CLOB is near 50/50 (conviction < maxConviction).
 *
 * Paper trading showed near-fair (conviction < 0.20) wins 66.7% vs
 * 16% when CLOB is decided (conviction > 0.30). The market hasn't
 * repriced the VWAP move yet.
 */

export const name = 'vwap-near-fair';
export const description = 'VWAP contrarian with conviction gate. Only bets when CLOB is near 50/50 (not yet repriced).';

export const defaults = {
  exchangeThresholdPct: 0.03,
  maxConviction: 0.20,        // Max |clobUp - 0.50| to fire
  entryWindowMs: 60000,
  maxEntryPrice: 0.65,
  capitalPerTrade: 2,
};

export const sweepGrid = {
  exchangeThresholdPct: [0.01, 0.03, 0.05, 0.08],
  maxConviction: [0.15, 0.20, 0.25],
  entryWindowMs: [30000, 60000, 90000],
};

let hasBought = false;

export function onWindowOpen() { hasBought = false; }

export function evaluate(state, config) {
  if (hasBought) return [];
  const {
    exchangeThresholdPct = defaults.exchangeThresholdPct,
    maxConviction = defaults.maxConviction,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
  } = config;

  const { clobUp, clobDown, window: win, oraclePriceAtOpen } = state;
  if (!win || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  // Conviction gate: CLOB must be near 50/50
  const conviction = Math.abs(clobUp.mid - 0.50);
  if (conviction > maxConviction) return [];

  const clOpen = oraclePriceAtOpen || state.strike;
  if (!clOpen) return [];

  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];

  const exchDeltaPct = (exchangeMedian - clOpen) / clOpen;
  const clobDirection = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';
  const exchDirection = exchDeltaPct > 0 ? 'UP' : 'DOWN';

  if (clobDirection === exchDirection) return [];
  if (Math.abs(exchDeltaPct) < exchangeThresholdPct) return [];

  if (exchDirection === 'UP' && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `vwap_nf: conv=${conviction.toFixed(3)}, exch +${(exchDeltaPct*100).toFixed(3)}%` }];
  }
  if (exchDirection === 'DOWN' && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `vwap_nf: conv=${conviction.toFixed(3)}, exch ${(exchDeltaPct*100).toFixed(3)}%` }];
  }
  return [];
}
