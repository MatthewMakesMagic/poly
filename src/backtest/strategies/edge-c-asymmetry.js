/**
 * Edge C: Cross-Instrument Information Asymmetry
 *
 * Exploits the structural ~$80 gap between Chainlink Data Streams (settlement oracle)
 * and exchange prices. When polyRef is near strike AND Chainlink is significantly below
 * strike, buys DOWN tokens — because settlement uses Chainlink, which is structurally lower.
 *
 * Resolution: chainlink_close > strike ? UP : DOWN
 *
 * Strategy interface contract:
 *   { name, evaluate, onWindowOpen?, onWindowClose? }
 */

export const name = 'edge-c-asymmetry';

/**
 * Default strategy parameters.
 * Can be overridden via strategyConfig.
 */
export const defaults = {
  deficitThreshold: 80,       // Min CL deficit to trigger (dollars)
  nearStrikeThreshold: 100,   // polyRef must be within this of strike
  entryWindowMs: 120000,      // Only enter within last 2 min of window
  maxDownPrice: 0.65,         // Max price willing to pay for DOWN token
  positionSize: 1,            // Tokens to buy
};

/**
 * Evaluate market state and return signals.
 *
 * @param {import('../market-state.js').MarketState} state
 * @param {Object} config - Merged strategy config
 * @returns {Object[]} Array of signals (empty = no action)
 */
export function evaluate(state, config) {
  const {
    deficitThreshold = defaults.deficitThreshold,
    nearStrikeThreshold = defaults.nearStrikeThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxDownPrice = defaults.maxDownPrice,
    positionSize = defaults.positionSize,
  } = config;

  const { strike, chainlink, polyRef, clobDown, window: win } = state;

  // Need all data present
  if (strike == null || !chainlink?.price || !polyRef?.price || !clobDown || !win) {
    return [];
  }

  const deficit = strike - chainlink.price;
  const refNearStrike = Math.abs(polyRef.price - strike) < nearStrikeThreshold;
  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  const downCheap = clobDown.bestAsk < maxDownPrice;

  if (refNearStrike && deficit > deficitThreshold && timeOk && downCheap) {
    const token = `${win.symbol}-down`;
    return [{
      action: 'buy',
      token,
      size: positionSize,
      reason: `edge_c: deficit=$${deficit.toFixed(0)}, ref_gap=$${(polyRef.price - strike).toFixed(0)}`,
      confidence: Math.min(deficit / 150, 1),
    }];
  }

  return [];
}
