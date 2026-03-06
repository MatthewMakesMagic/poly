/**
 * VWAP Contrarian Strategy
 *
 * Bets when exchange consensus (VWAP proxy) disagrees with CLOB direction.
 * Exchange median vs CL@open determines "true" direction;
 * CLOB UP/DOWN mid determines "market" direction.
 * When they disagree and exchange signal is strong enough, bet with exchanges.
 */

export const name = 'vwap-contrarian';
export const description = 'Bets with exchange consensus when it disagrees with CLOB direction. Proxy for VWAP edge.';

export const defaults = {
  exchangeThresholdPct: 0.03,  // Exchange median must be 0.03% away from strike
  entryWindowMs: 60000,        // Last 60s (T-60 sweet spot from paper trading)
  maxEntryPrice: 0.70,
  capitalPerTrade: 2,
};

export const sweepGrid = {
  exchangeThresholdPct: [0.01, 0.03, 0.05, 0.08],
  entryWindowMs: [30000, 60000, 90000],
  maxEntryPrice: [0.60, 0.65, 0.70],
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

  // Use CL@open as reference — that's what settlement compares against
  const clOpen = oraclePriceAtOpen || state.strike;
  if (!clOpen) return [];

  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];

  const exchDeltaPct = (exchangeMedian - clOpen) / clOpen;
  const clobDirection = clobUp.mid >= 0.50 ? 'UP' : 'DOWN';
  const exchDirection = exchDeltaPct > 0 ? 'UP' : 'DOWN';

  // Only trade when they disagree AND exchange signal is strong enough
  if (clobDirection === exchDirection) return [];
  if (Math.abs(exchDeltaPct) < exchangeThresholdPct) return [];

  if (exchDirection === 'UP' && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `vwap_contra: exch +${(exchDeltaPct*100).toFixed(3)}% vs CLOB DOWN` }];
  }
  if (exchDirection === 'DOWN' && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `vwap_contra: exch ${(exchDeltaPct*100).toFixed(3)}% vs CLOB UP` }];
  }
  return [];
}
