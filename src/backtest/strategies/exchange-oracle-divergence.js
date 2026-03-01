/**
 * Exchange-vs-Oracle Divergence Strategy (Contrarian)
 *
 * Bets with exchange direction when exchanges disagree with Chainlink oracle.
 * Based on analysis showing: when Binance strongly UP but CL trending DOWN,
 * Binance direction wins 5/5 times in UP cases.
 *
 * Theory: Exchanges lead oracles by ~5s. When exchange median says UP
 * but CL is still below strike, CL will eventually catch up. Similarly
 * when exchanges say DOWN but CLOB is pricing UP.
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'exchange-oracle-divergence';

export const defaults = {
  exchangeLeadThreshold: 30,   // Exchange must be this many $ above/below strike
  clDisagreeThreshold: 20,     // CL must be at least this many $ in opposite direction
  entryWindowMs: 90000,        // Only enter in last 90s
  maxEntryPrice: 0.70,         // Max token price
  positionSize: 1,
  minExchanges: 2,             // Need at least N exchanges agreeing
};

export const sweepGrid = {
  exchangeLeadThreshold: [20, 30, 50, 75, 100],
  clDisagreeThreshold: [10, 20, 30, 50],
  entryWindowMs: [60000, 90000, 120000],
  maxEntryPrice: [0.60, 0.65, 0.70, 0.75],
};

let hasBought = false;

export function onWindowOpen(state, config) {
  hasBought = false;
}

export function evaluate(state, config) {
  const {
    exchangeLeadThreshold = defaults.exchangeLeadThreshold,
    clDisagreeThreshold = defaults.clDisagreeThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    positionSize = defaults.positionSize,
    minExchanges = defaults.minExchanges,
  } = config;

  const { strike, chainlink, clobUp, clobDown, window: win } = state;
  if (hasBought) return [];
  if (!win || !chainlink?.price || strike == null) return [];

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  // Get exchange consensus
  const exchanges = state.getAllExchanges();
  if (exchanges.length < minExchanges) return [];

  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];

  const exchangeAboveStrike = exchangeMedian - strike;  // positive = exchanges say UP
  const clAboveStrike = chainlink.price - strike;        // positive = CL says UP

  // Case 1: Exchanges say UP (above strike), CL says DOWN (below strike)
  if (exchangeAboveStrike > exchangeLeadThreshold && clAboveStrike < -clDisagreeThreshold) {
    if (clobUp && clobUp.bestAsk <= maxEntryPrice) {
      hasBought = true;
      return [{
        action: 'buy',
        token: `${win.symbol}-up`,
        size: positionSize,
        reason: `exch_oracle_div: exch=${exchangeAboveStrike.toFixed(0)} above, cl=${clAboveStrike.toFixed(0)} below`,
        confidence: Math.min(Math.abs(exchangeAboveStrike) / 100, 1),
      }];
    }
  }

  // Case 2: Exchanges say DOWN (below strike), CL says UP (above strike)
  if (exchangeAboveStrike < -exchangeLeadThreshold && clAboveStrike > clDisagreeThreshold) {
    if (clobDown && clobDown.bestAsk <= maxEntryPrice) {
      hasBought = true;
      return [{
        action: 'buy',
        token: `${win.symbol}-down`,
        size: positionSize,
        reason: `exch_oracle_div: exch=${exchangeAboveStrike.toFixed(0)} below, cl=${clAboveStrike.toFixed(0)} above`,
        confidence: Math.min(Math.abs(exchangeAboveStrike) / 100, 1),
      }];
    }
  }

  return [];
}
