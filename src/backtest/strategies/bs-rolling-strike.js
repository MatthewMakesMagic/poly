/**
 * BS Rolling Strike
 *
 * Instead of fixed K = CL@open, uses a rolling median of recent CL prices as K.
 * This captures where CL has been "hovering" rather than where it started.
 *
 * The insight: CL might open at $95,000 but spend 12 minutes near $95,100.
 * The "effective" strike is $95,100, not $95,000. This rolling K better reflects
 * the actual threshold CL needs to cross for resolution.
 *
 * Resolution is still CL@close >= CL@open, but the rolling K helps BS estimate
 * the probability that CL will end above the true open.
 */

export const name = 'bs-rolling-strike';
export const description = 'BS pricing with rolling CL median as K instead of fixed CL@open.';

export const defaults = {
  mispricingThreshold: 0.20,
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  rollingWindowMs: 120000,     // Rolling median over last 2 min of CL
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.15, 0.20, 0.25, 0.30],
  entryWindowMs: [60000, 90000, 120000],
  rollingWindowMs: [60000, 120000, 180000],
  maxEntryPrice: [0.55, 0.60, 0.65],
};

let hasBought = false;
let clHistory = [];
let clOpen = null;  // True CL@open for resolution reference

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
    rollingWindowMs = defaults.rollingWindowMs,
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];
  if (!chainlink?.price) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  // We still need the true open for resolution, but use rolling K for BS
  const trueK = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!trueK) return [];

  if (clHistory.length < minVolSamples) return [];

  const nowMs = clHistory[clHistory.length - 1].ms;

  // Rolling median K from recent CL ticks
  const recentCutoff = nowMs - rollingWindowMs;
  const recentPrices = clHistory.filter(t => t.ms >= recentCutoff).map(t => t.price);
  if (recentPrices.length < 3) return [];

  recentPrices.sort((a, b) => a - b);
  const mid = Math.floor(recentPrices.length / 2);
  const rollingK = recentPrices.length % 2 !== 0
    ? recentPrices[mid]
    : (recentPrices[mid - 1] + recentPrices[mid]) / 2;

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

  // BS uses rolling K but resolution is still relative to true CL@open
  // The rolling K reflects where CL "wants to be" — better estimate of CL@close distribution center
  const S = chainlink.price;
  const K = trueK;  // Still use true open for d2 (that's the resolution threshold)
  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return [];

  // Use rolling K as the distribution center, true K as the threshold
  // Adjusted d2: account for mean-reversion toward rolling K
  const drift = (rollingK - K) / K;  // How far rolling center is from true strike
  const logSK = Math.log(S / K);
  const d2 = (logSK + drift * Tyears * 365.25 * 24 * 3600 - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
  const bsFairUp = normalCDF(d2);

  const clobUpPrice = clobUp.mid;
  const mispricing = clobUpPrice - bsFairUp;

  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_rolling: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, rollK=$${rollingK.toFixed(0)} vs trueK=$${K.toFixed(0)}` }];
  }
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_rolling: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, rollK=$${rollingK.toFixed(0)} vs trueK=$${K.toFixed(0)}` }];
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
