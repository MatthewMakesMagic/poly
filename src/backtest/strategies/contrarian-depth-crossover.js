/**
 * Contrarian Depth Crossover
 *
 * When CLOB is heavily decided (>75% one way) but the contrarian side
 * has real bid depth (MMs quoting real money on the losing side),
 * bet contrarian.
 *
 * Theory: MMs who maintain depth on the "losing" side have private info
 * or model the probability differently. When they put real money up
 * at 83-91% of crossover cases, the market direction flips.
 *
 * Also detects spread widening on the dominant side (MMs pulling quotes = uncertainty).
 */

export const name = 'contrarian-depth-crossover';
export const description = 'Bets against CLOB when contrarian side has unusual depth or dominant side spread widens.';

export const defaults = {
  minConviction: 0.25,         // CLOB must be 0.75+ or 0.25- (decided)
  minContrarianBidSize: 50,    // Min bid size on cheap side
  minSpreadWiden: 0.05,        // Min spread on expensive side (widening = uncertainty)
  entryWindowMs: 90000,
  maxEntryPrice: 0.35,         // Contrarian side is cheap
  capitalPerTrade: 2,
  requireBothSignals: false,   // If true, need depth AND spread
};

export const sweepGrid = {
  minConviction: [0.20, 0.25, 0.30],
  minContrarianBidSize: [20, 50, 100],
  minSpreadWiden: [0.03, 0.05, 0.08],
  maxEntryPrice: [0.25, 0.30, 0.35],
};

let hasBought = false;

export function onWindowOpen() { hasBought = false; }

export function evaluate(state, config) {
  if (hasBought) return [];
  const {
    minConviction = defaults.minConviction,
    minContrarianBidSize = defaults.minContrarianBidSize,
    minSpreadWiden = defaults.minSpreadWiden,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
    requireBothSignals = defaults.requireBothSignals,
  } = config;

  const { clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  // CLOB heavily favors UP (clobUp > 0.75) → contrarian = DOWN
  if (clobUp.mid >= 0.50 + minConviction) {
    const hasDepth = clobDown.bidSize >= minContrarianBidSize;
    const hasSpreadWiden = clobUp.spread >= minSpreadWiden;
    const signal = requireBothSignals ? (hasDepth && hasSpreadWiden) : (hasDepth || hasSpreadWiden);

    if (signal && clobDown.bestAsk <= maxEntryPrice) {
      hasBought = true;
      return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
        reason: `depth_cross: UP=${clobUp.mid.toFixed(3)}, DOWN_bid_sz=${clobDown.bidSize}, UP_spread=${clobUp.spread.toFixed(3)}` }];
    }
  }

  // CLOB heavily favors DOWN (clobDown > 0.75) → contrarian = UP
  if (clobDown.mid >= 0.50 + minConviction) {
    const hasDepth = clobUp.bidSize >= minContrarianBidSize;
    const hasSpreadWiden = clobDown.spread >= minSpreadWiden;
    const signal = requireBothSignals ? (hasDepth && hasSpreadWiden) : (hasDepth || hasSpreadWiden);

    if (signal && clobUp.bestAsk <= maxEntryPrice) {
      hasBought = true;
      return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
        reason: `depth_cross: DOWN=${clobDown.mid.toFixed(3)}, UP_bid_sz=${clobUp.bidSize}, DOWN_spread=${clobDown.spread.toFixed(3)}` }];
    }
  }

  return [];
}
