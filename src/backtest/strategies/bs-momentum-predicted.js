/**
 * BS Momentum Predicted
 *
 * Instead of using current CL as S, extrapolates exchange momentum to predict CL@close.
 * Exchange prices lead CL by ~2-5s. By measuring recent exchange price velocity,
 * we can predict where CL will be at window close.
 *
 * predicted_CL = current_CL + exchange_momentum * time_remaining * absorption_rate
 * absorption_rate ≈ 0.77 at 5s (from oracle architecture analysis)
 *
 * Uses predicted CL as S in BS formula for a forward-looking fair value.
 */

export const name = 'bs-momentum-predicted';
export const description = 'BS pricing with predicted CL@close from exchange momentum extrapolation.';

export const defaults = {
  mispricingThreshold: 0.20,
  entryWindowMs: 60000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  momentumWindowMs: 10000,     // Measure momentum over last 10s
  absorptionRate: 0.65,        // CL absorbs 65% of exchange moves in ~3s
  maxExtrapolationPct: 0.002,  // Cap extrapolation at 0.2% of price
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.15, 0.20, 0.25, 0.30],
  entryWindowMs: [30000, 60000, 90000],
  momentumWindowMs: [5000, 10000, 15000],
  absorptionRate: [0.50, 0.65, 0.77],
};

let hasBought = false;
let clHistory = [];
let exchangeHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  hasBought = false;
  clHistory = [];
  exchangeHistory = [];
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
    momentumWindowMs = defaults.momentumWindowMs,
    absorptionRate = defaults.absorptionRate,
    maxExtrapolationPct = defaults.maxExtrapolationPct,
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;

  if (chainlink?.price) {
    clHistory.push({ price: chainlink.price, ms });
  }

  const exchangeMedian = state.getExchangeMedian();
  if (exchangeMedian != null) {
    exchangeHistory.push({ price: exchangeMedian, ms });
  }

  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];
  if (!chainlink?.price) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];

  if (clHistory.length < minVolSamples) return [];
  if (exchangeHistory.length < 5) return [];

  // Measure exchange momentum (price change per second over recent window)
  const momentumCutoff = ms - momentumWindowMs;
  const recentExch = exchangeHistory.filter(t => t.ms >= momentumCutoff);
  if (recentExch.length < 3) return [];

  const exchStart = recentExch[0].price;
  const exchEnd = recentExch[recentExch.length - 1].price;
  const exchDtSec = (recentExch[recentExch.length - 1].ms - recentExch[0].ms) / 1000;
  if (exchDtSec < 1) return [];

  const exchangeMomentumPerSec = (exchEnd - exchStart) / exchDtSec;

  // Predict CL@close
  const timeToCloseSec = win.timeToCloseMs / 1000;
  let extrapolation = exchangeMomentumPerSec * timeToCloseSec * absorptionRate;

  // Cap extrapolation
  const maxExtrapolation = chainlink.price * maxExtrapolationPct;
  if (Math.abs(extrapolation) > maxExtrapolation) {
    extrapolation = Math.sign(extrapolation) * maxExtrapolation;
  }

  const predictedCL = chainlink.price + extrapolation;

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

  // BS using predicted CL as S
  const S = predictedCL;
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
      reason: `bs_momentum: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, predCL=$${predictedCL.toFixed(0)}, extrp=$${extrapolation.toFixed(0)}` }];
  }
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_momentum: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, predCL=$${predictedCL.toFixed(0)}, extrp=$${extrapolation.toFixed(0)}` }];
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
