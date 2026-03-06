/**
 * Paired MM: Vol Regime
 *
 * Like mm-paired-polyref but adjusts minEdge based on realized volatility:
 * - Compute realized vol from clHistory (same as BS calc)
 * - If vol < volThreshold: effectiveMinEdge = minEdge * 1.5 (wider, need more edge in calm markets)
 * - If vol >= volThreshold: effectiveMinEdge = minEdge * 0.5 (tighter, grab mispricings in volatile markets)
 *
 * In volatile markets, BS mispricings are larger and more frequent, so we
 * can afford tighter edge requirements. In calm markets, mispricings are
 * small and fleeting, requiring wider edge to cover spread costs.
 *
 * S = polyRef.price
 * Vol estimated from CL history (settlement oracle).
 */

export const name = 'mm-paired-volregime';
export const description = 'Paired MM with vol-regime adaptive edge. Tighter edge in volatile markets (more mispricings), wider in calm markets.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 10000,
  minPairEdge: 0.02,
  entryWindowMs: 300000,
  exitWindowMs: 5000,
  maxEntryPrice: 0.65,
  maxHedgePrice: 0.65,
  minVolSamples: 10,
  windowDurationMs: 900000,
  spreadBuffer: 0,
  volThreshold: 2.0,    // annualized vol threshold (200%)
  lowVolMultiplier: 1.5,
  highVolMultiplier: 0.5,
};

export const sweepGrid = {
  minEdge: [0.01, 0.02, 0.03, 0.05],
  maxPerSide: [6, 10, 20],
  cooldownMs: [5000, 10000, 15000],
  capitalPerEntry: [2],
  minPairEdge: [0.01, 0.02, 0.05],
  volThreshold: [1.0, 2.0, 3.0],
  lowVolMultiplier: [1.25, 1.5, 2.0],
  highVolMultiplier: [0.25, 0.5, 0.75],
};

let upCost = 0;
let downCost = 0;
let upTokens = 0;
let downTokens = 0;
let lastUpBuyMs = 0;
let lastDownBuyMs = 0;
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  upCost = 0;
  downCost = 0;
  upTokens = 0;
  downTokens = 0;
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
    minPairEdge = defaults.minPairEdge,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    maxHedgePrice = defaults.maxHedgePrice,
    minVolSamples = defaults.minVolSamples,
    volThreshold = defaults.volThreshold,
    lowVolMultiplier = defaults.lowVolMultiplier,
    highVolMultiplier = defaults.highVolMultiplier,
  } = config;

  const { chainlink, clobUp, clobDown, polyRef, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null) return [];
  if (!polyRef?.price) return [];
  if (win.timeToCloseMs >= entryWindowMs || win.timeToCloseMs <= exitWindowMs) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];
  if (clHistory.length < minVolSamples) return [];

  // Compute realized vol (same method as BS)
  const volInfo = computeVolAndBSFair(polyRef.price, K, clHistory, win.timeToCloseMs);
  if (volInfo == null) return [];

  const { bsFair, sigmaAnnualized } = volInfo;

  // Vol regime: adjust minEdge
  const effectiveMinEdge = sigmaAnnualized >= volThreshold
    ? minEdge * highVolMultiplier
    : minEdge * lowVolMultiplier;

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;
  const sym = win.symbol;
  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const signals = [];

  const askUp = clobUp.bestAsk;
  const askDown = clobDown.bestAsk;

  // MODE 1: EDGE ENTRY with vol-adjusted minEdge
  if (askUp < fairUp - effectiveMinEdge
    && askUp <= maxEntryPrice
    && askUp > 0.01
    && upCost < maxPerSide
    && nowMs - lastUpBuyMs >= cooldownMs) {
    const tokens = capitalPerEntry / askUp;
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: UP, fair=${fairUp.toFixed(3)}, ask=${askUp.toFixed(3)}, effEdge=${effectiveMinEdge.toFixed(3)}, vol=${sigmaAnnualized.toFixed(1)}`,
    });
    upCost += capitalPerEntry;
    upTokens += tokens;
    lastUpBuyMs = nowMs;
  }

  if (askDown < fairDown - effectiveMinEdge
    && askDown <= maxEntryPrice
    && askDown > 0.01
    && downCost < maxPerSide
    && nowMs - lastDownBuyMs >= cooldownMs) {
    const tokens = capitalPerEntry / askDown;
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${askDown.toFixed(3)}, effEdge=${effectiveMinEdge.toFixed(3)}, vol=${sigmaAnnualized.toFixed(1)}`,
    });
    downCost += capitalPerEntry;
    downTokens += tokens;
    lastDownBuyMs = nowMs;
  }

  // MODE 2: HEDGE ENTRY
  if (upTokens > downTokens && downCost < maxPerSide && nowMs - lastDownBuyMs >= cooldownMs) {
    const avgUpPrice = upCost / upTokens;
    const maxDownPrice = 1.00 - avgUpPrice - minPairEdge;
    if (askDown > 0.01 && askDown < maxDownPrice && askDown <= maxHedgePrice) {
      const tokens = capitalPerEntry / askDown;
      signals.push({
        action: 'buy',
        token: `${sym}-down`,
        capitalPerTrade: capitalPerEntry,
        reason: `hedge_buy: DOWN, avgUp=${avgUpPrice.toFixed(3)}, askDn=${askDown.toFixed(3)}`,
      });
      downCost += capitalPerEntry;
      downTokens += tokens;
      lastDownBuyMs = nowMs;
    }
  }

  if (downTokens > upTokens && upCost < maxPerSide && nowMs - lastUpBuyMs >= cooldownMs) {
    const avgDownPrice = downCost / downTokens;
    const maxUpPrice = 1.00 - avgDownPrice - minPairEdge;
    if (askUp > 0.01 && askUp < maxUpPrice && askUp <= maxHedgePrice) {
      const tokens = capitalPerEntry / askUp;
      signals.push({
        action: 'buy',
        token: `${sym}-up`,
        capitalPerTrade: capitalPerEntry,
        reason: `hedge_buy: UP, avgDn=${avgDownPrice.toFixed(3)}, askUp=${askUp.toFixed(3)}`,
      });
      upCost += capitalPerEntry;
      upTokens += tokens;
      lastUpBuyMs = nowMs;
    }
  }

  return signals;
}

function computeVolAndBSFair(S, K, history, timeToCloseMs) {
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

  const Tyears = (timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return null;

  const logSK = Math.log(S / K);
  const d2 = (logSK - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
  return { bsFair: normalCDF(d2), sigmaAnnualized };
}

// Keep standalone computeBSFair for interface compatibility
function computeBSFair(S, K, history, timeToCloseMs) {
  const result = computeVolAndBSFair(S, K, history, timeToCloseMs);
  return result ? result.bsFair : null;
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
