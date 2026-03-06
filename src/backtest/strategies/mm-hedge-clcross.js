/**
 * Continuous MM: CL-Adaptive Sizing
 *
 * True continuous market maker using CL as S with adaptive position sizing.
 * Scales buy size based on CL proximity to K (strike):
 *   - When CL is near K (uncertain outcome): smaller buys
 *   - When CL is far from K (confident direction): larger buys on the winning side
 *
 * capitalPerEntry * clConfidence, where:
 *   clConfidence = min(1, |S - K| / (σ√T) / 1.5)
 *
 * Vol estimated from CL history.
 */

export const name = 'mm-hedge-clcross';
export const description = 'Continuous MM: CL-based BS with adaptive sizing. Scales position size by CL proximity to K.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 10000,
  confidenceScale: 1.5,
  minConfidence: 0.2,
  entryWindowMs: 300000,
  exitWindowMs: 5000,
  maxEntryPrice: 0.65,
  minVolSamples: 10,
  windowDurationMs: 900000,
  spreadBuffer: 0,
};

export const sweepGrid = {
  minEdge: [0.01, 0.02, 0.03, 0.05],
  maxPerSide: [6, 10, 20],
  cooldownMs: [5000, 10000, 15000],
  capitalPerEntry: [2],
};

let upCost = 0;
let downCost = 0;
let lastUpBuyMs = 0;
let lastDownBuyMs = 0;
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  upCost = 0;
  downCost = 0;
  lastUpBuyMs = 0;
  lastDownBuyMs = 0;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
}

export function evaluate(state, config) {
  const {
    minEdge = defaults.minEdge,
    maxPerSide = defaults.maxPerSide,
    capitalPerEntry = defaults.capitalPerEntry,
    cooldownMs = defaults.cooldownMs,
    confidenceScale = defaults.confidenceScale,
    minConfidence = defaults.minConfidence,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    minVolSamples = defaults.minVolSamples,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null) return [];
  if (!chainlink?.price) return [];

  if (win.timeToCloseMs >= entryWindowMs || win.timeToCloseMs <= exitWindowMs) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];
  if (clHistory.length < minVolSamples) return [];

  // Compute vol for both BS fair and confidence scaling
  const volResult = computeVol(clHistory);
  if (!volResult) return [];
  const { sigmaAnnualized } = volResult;

  const bsFair = computeBSFairWithSigma(chainlink.price, K, sigmaAnnualized, win.timeToCloseMs);
  if (bsFair == null) return [];

  // Adaptive sizing: confidence based on |S-K| / (σ√T)
  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  const sigmaT = sigmaAnnualized * sqrtT;
  const zScore = sigmaT > 1e-10 ? Math.abs(chainlink.price - K) / K / sigmaT : 0;
  const clConfidence = Math.max(minConfidence, Math.min(1, zScore / confidenceScale));
  const adjustedCapital = capitalPerEntry * clConfidence;

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;
  const sym = win.symbol;
  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const signals = [];

  // ─── BUY UP if cheap ───
  if (clobUp.bestAsk < fairUp - minEdge
    && clobUp.bestAsk <= maxEntryPrice
    && clobUp.bestAsk > 0.01
    && upCost < maxPerSide
    && nowMs - lastUpBuyMs >= cooldownMs) {
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: adjustedCapital,
      reason: `mm_buy: UP, fair=${fairUp.toFixed(3)}, ask=${clobUp.bestAsk.toFixed(3)}, conf=${clConfidence.toFixed(2)}, cap=$${adjustedCapital.toFixed(2)}`,
    });
    upCost += adjustedCapital;
    lastUpBuyMs = nowMs;
  }

  // ─── BUY DOWN if cheap ───
  if (clobDown.bestAsk < fairDown - minEdge
    && clobDown.bestAsk <= maxEntryPrice
    && clobDown.bestAsk > 0.01
    && downCost < maxPerSide
    && nowMs - lastDownBuyMs >= cooldownMs) {
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: adjustedCapital,
      reason: `mm_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${clobDown.bestAsk.toFixed(3)}, conf=${clConfidence.toFixed(2)}, cap=$${adjustedCapital.toFixed(2)}`,
    });
    downCost += adjustedCapital;
    lastDownBuyMs = nowMs;
  }

  return signals;
}

function computeVol(history) {
  let sumSqReturns = 0, returnCount = 0;
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].ms - history[i-1].ms) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const logReturn = Math.log(history[i].price / history[i-1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 5) return null;

  const avgTimeStepSec = (history[history.length-1].ms - history[0].ms) / 1000 / returnCount;
  if (avgTimeStepSec <= 0) return null;
  const varPerSec = sumSqReturns / returnCount / avgTimeStepSec;
  const sigmaAnnualized = Math.sqrt(varPerSec * 365.25 * 24 * 3600);
  return { sigmaAnnualized };
}

function computeBSFairWithSigma(S, K, sigmaAnnualized, timeToCloseMs) {
  const Tyears = (timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return null;

  const logSK = Math.log(S / K);
  const d2 = (logSK - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
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
