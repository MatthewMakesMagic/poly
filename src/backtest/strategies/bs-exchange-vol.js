/**
 * BS Exchange Volatility
 *
 * Uses CL as S but computes realized vol from exchange prices instead of CL.
 * Exchange prices are less smoothed than CL (which is VWAP-based), so exchange
 * vol better captures true short-term price dynamics.
 *
 * Higher exchange vol → wider BS fair value range → bigger mispricing needed → more selective.
 */

export const name = 'bs-exchange-vol';
export const description = 'BS binary pricing with volatility estimated from exchange prices (less smoothed than CL).';

export const defaults = {
  mispricingThreshold: 0.20,
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.15, 0.20, 0.25, 0.30],
  entryWindowMs: [60000, 90000, 120000],
  maxEntryPrice: [0.55, 0.60, 0.65],
};

let hasBought = false;
let exchangeHistory = [];  // { price, ms }
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  hasBought = false;
  exchangeHistory = [];
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
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;

  // Track CL history
  if (chainlink?.price) {
    clHistory.push({ price: chainlink.price, ms });
  }

  // Track exchange median history for vol
  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian != null) {
    exchangeHistory.push({ price: exchangeMedian, ms });
  }

  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];
  if (!chainlink?.price) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];

  if (exchangeHistory.length < minVolSamples) return [];

  // Compute vol from exchange prices (less smoothed)
  let sumSqReturns = 0, returnCount = 0;
  for (let i = 1; i < exchangeHistory.length; i++) {
    const dt = (exchangeHistory[i].ms - exchangeHistory[i-1].ms) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const logReturn = Math.log(exchangeHistory[i].price / exchangeHistory[i-1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 5) return [];

  const avgTimeStepSec = (exchangeHistory[exchangeHistory.length-1].ms - exchangeHistory[0].ms) / 1000 / returnCount;
  if (avgTimeStepSec <= 0) return [];
  const varPerSec = sumSqReturns / returnCount / avgTimeStepSec;
  const sigmaAnnualized = Math.sqrt(varPerSec * 365.25 * 24 * 3600);

  const S = chainlink.price;
  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return [];

  const logSK = Math.log(S / K);
  const d2 = (logSK - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
  const bsFairUp = normalCDF(d2);

  const clobUpPrice = clobUp.mid;
  const mispricing = clobUpPrice - bsFairUp;

  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_exchvol: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, σ_exch=${(sigmaAnnualized*100).toFixed(1)}%` }];
  }
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_exchvol: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, σ_exch=${(sigmaAnnualized*100).toFixed(1)}%` }];
  }

  return [];
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
