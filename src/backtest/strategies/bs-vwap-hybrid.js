/**
 * Black-Scholes + VWAP Hybrid
 *
 * Combines BS binary pricing with VWAP signal.
 * Instead of using current CL as S, uses exchange median (VWAP proxy)
 * as the "forward-looking" S — where CL is likely heading.
 *
 * This addresses the core BS limitation: CL is lagged by ~2-5s.
 * Exchanges lead CL, so exchange median is a better predictor of CL@close.
 *
 * Trades when: BS(exchange_median, K) disagrees with CLOB
 * AND standard BS(CL, K) also agrees (confirmation).
 */

export const name = 'bs-vwap-hybrid';
export const description = 'BS fair value using exchange median as forward-looking CL predictor. Trades CLOB mispricing.';

export const defaults = {
  mispricingThreshold: 0.15,
  entryWindowMs: 60000,
  maxEntryPrice: 0.65,
  capitalPerTrade: 2,
  minVolSamples: 10,
  windowDurationMs: 900000,
  clConfirmation: true,       // Require CL-based BS to agree
};

export const sweepGrid = {
  mispricingThreshold: [0.10, 0.15, 0.20, 0.25],
  entryWindowMs: [30000, 60000, 90000],
  maxEntryPrice: [0.55, 0.60, 0.65],
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
    windowDurationMs = defaults.windowDurationMs,
    clConfirmation = defaults.clConfirmation,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];

  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian == null) return [];

  // Fallback: try state.oraclePriceAtOpen, then first CL tick
  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];

  if (clHistory.length < minVolSamples) return [];

  // Compute realized vol from CL
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

  // BS fair using exchange median as forward S
  const logSK_exch = Math.log(exchangeMedian / K);
  const d2_exch = (logSK_exch - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
  const bsFairExch = normalCDF(d2_exch);

  // Optional: CL-based confirmation
  if (clConfirmation && chainlink?.price) {
    const logSK_cl = Math.log(chainlink.price / K);
    const d2_cl = (logSK_cl - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
    const bsFairCL = normalCDF(d2_cl);
    // Both must agree on direction of mispricing
    const exchMispricing = clobUp.mid - bsFairExch;
    const clMispricing = clobUp.mid - bsFairCL;
    if (Math.sign(exchMispricing) !== Math.sign(clMispricing)) return [];
  }

  const mispricing = clobUp.mid - bsFairExch;

  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_vwap: P(UP)=${bsFairExch.toFixed(3)}, CLOB=${clobUp.mid.toFixed(3)}, gap=${mispricing.toFixed(3)}` }];
  }
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_vwap: P(UP)=${bsFairExch.toFixed(3)}, CLOB=${clobUp.mid.toFixed(3)}, gap=${mispricing.toFixed(3)}` }];
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
