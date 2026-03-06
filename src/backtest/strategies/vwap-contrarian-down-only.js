/**
 * VWAP Contrarian — DOWN Only
 *
 * Same as vwap-contrarian but only bets DOWN.
 * Paper trading showed DOWN-only wins 81.8% vs 63.6% for UP.
 * The structural CL deficit (~$47 below exchange spot) means DOWN is systematically underpriced.
 */

export const name = 'vwap-contrarian-down-only';
export const description = 'VWAP contrarian but DOWN bets only. Exploits structural CL-below-exchange deficit.';

export const defaults = {
  exchangeThresholdPct: 0.03,
  entryWindowMs: 60000,
  maxEntryPrice: 0.70,
  capitalPerTrade: 2,
};

export const sweepGrid = {
  exchangeThresholdPct: [0.01, 0.03, 0.05, 0.08],
  entryWindowMs: [30000, 60000, 90000],
  maxEntryPrice: [0.55, 0.65, 0.70],
};

let hasBought = false;

export function onWindowOpen() { hasBought = false; }

export function evaluate(state, config) {
  if (hasBought) return [];
  const {
    exchangeThresholdPct = defaults.exchangeThresholdPct,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
  } = config;

  const { clobUp, clobDown, window: win, oraclePriceAtOpen } = state;
  if (!win || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  const clOpen = oraclePriceAtOpen || state.strike;
  if (!clOpen) return [];

  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];

  const exchDeltaPct = (exchangeMedian - clOpen) / clOpen;
  const clobDirection = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';

  // Only DOWN bets: exchanges say DOWN but CLOB says UP
  if (clobDirection !== 'UP') return [];
  if (exchDeltaPct >= 0) return [];  // exchanges also say UP, no disagreement
  if (Math.abs(exchDeltaPct) < exchangeThresholdPct) return [];

  if (clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `vwap_down: exch ${(exchDeltaPct*100).toFixed(3)}% below vs CLOB UP=${clobUp.mid.toFixed(3)}` }];
  }
  return [];
}
