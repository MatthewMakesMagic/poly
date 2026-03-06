/**
 * BS Exchange Corridor
 *
 * Instead of a single S, computes BS fair value at the min and max exchange prices.
 * This creates a fair-value corridor (range). Only trades when CLOB is outside
 * BOTH bounds — i.e., overpriced even under the most favorable exchange interpretation.
 *
 * Very selective: requires CLOB to be extreme relative to the full exchange range.
 */

export const name = 'bs-exchange-corridor';
export const description = 'BS fair value as min/max range from exchanges. Trades only when CLOB is outside both bounds.';

export const defaults = {
  mispricingThreshold: 0.10,  // Lower threshold since corridor already provides selectivity
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  minExchanges: 3,
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.05, 0.10, 0.15, 0.20],
  entryWindowMs: [60000, 90000, 120000],
  maxEntryPrice: [0.55, 0.60, 0.65],
  minExchanges: [2, 3],
};

let hasBought = false;
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  hasBought = false;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
}

export function evaluate(state, config) {
  if (hasBought) return [];
  const {
    mispricingThreshold = defaults.mispricingThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
    minVolSamples = defaults.minVolSamples,
    minExchanges = defaults.minExchanges,
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  // Need enough exchanges for a meaningful corridor
  const exchanges = state.getAllExchanges();
  const exchPrices = exchanges.map(e => e.price).filter(p => p != null);
  if (exchPrices.length < minExchanges) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];

  if (clHistory.length < minVolSamples) return [];

  // Vol from CL
  let sumSqReturns = 0, returnCount = 0;
  for (let i = 1; i < clHistory.length; i++) {
    const dt = (clHistory[i].ms - clHistory[i-1].ms) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const logReturn = Math.log(clHistory[i].price / clHistory[i-1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 5) return [];

  const avgTimeStepSec = (clHistory[clHistory.length-1].ms - clHistory[0].ms) / 1000 / returnCount;
  if (avgTimeStepSec <= 0) return [];
  const varPerSec = sumSqReturns / returnCount / avgTimeStepSec;
  const sigmaAnnualized = Math.sqrt(varPerSec * 365.25 * 24 * 3600);

  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return [];

  // Compute BS fair at min and max exchange prices
  let minExchPrice = exchPrices[0], maxExchPrice = exchPrices[0];
  for (let i = 1; i < exchPrices.length; i++) {
    if (exchPrices[i] < minExchPrice) minExchPrice = exchPrices[i];
    if (exchPrices[i] > maxExchPrice) maxExchPrice = exchPrices[i];
  }

  const bsFairLow = bsFair(minExchPrice, K, sigmaAnnualized, Tyears, sqrtT);
  const bsFairHigh = bsFair(maxExchPrice, K, sigmaAnnualized, Tyears, sqrtT);

  const clobUpPrice = clobUp.mid;

  // CLOB above the highest BS estimate → overpriced UP
  if (clobUpPrice - bsFairHigh > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_corridor: CLOB=${clobUpPrice.toFixed(3)} > corridor=[${bsFairLow.toFixed(3)},${bsFairHigh.toFixed(3)}], gap=${(clobUpPrice-bsFairHigh).toFixed(3)}` }];
  }
  // CLOB below the lowest BS estimate → underpriced UP
  if (bsFairLow - clobUpPrice > mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_corridor: CLOB=${clobUpPrice.toFixed(3)} < corridor=[${bsFairLow.toFixed(3)},${bsFairHigh.toFixed(3)}], gap=${(bsFairLow-clobUpPrice).toFixed(3)}` }];
  }

  return [];
}

function bsFair(S, K, sigma, Tyears, sqrtT) {
  const logSK = Math.log(S / K);
  const d2 = (logSK - 0.5 * sigma * sigma * Tyears) / (sigma * sqrtT);
  return normalCDF(d2);
}

function normalCDF(x) {
  if (x > 6) return 1;
  if (x < -6) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;
  const p = d * Math.exp(-x * x / 2) *
    (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x > 0 ? 1 - p : p;
}
