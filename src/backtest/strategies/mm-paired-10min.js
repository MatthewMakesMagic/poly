/**
 * Paired MM: 10 Minute Entry Window
 *
 * Same as mm-paired-polyref but with entryWindowMs=600000 (10 min).
 * More time before close = more chances to match pairs.
 *
 * S = polyRef.price
 * Vol estimated from CL history (settlement oracle).
 */

export const name = 'mm-paired-10min';
export const description = 'Paired MM: PolyRef BS + hedging with 10 min entry window for more matching opportunities.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 10000,
  minPairEdge: 0.02,
  entryWindowMs: 600000,
  exitWindowMs: 5000,
  maxEntryPrice: 0.65,
  maxHedgePrice: 0.65,
  minVolSamples: 10,
  windowDurationMs: 900000,
  spreadBuffer: 0,
};

export const sweepGrid = {
  minEdge: [0.01, 0.02, 0.03, 0.05],
  maxPerSide: [6, 10, 20],
  cooldownMs: [5000, 10000, 15000],
  capitalPerEntry: [2],
  minPairEdge: [0.01, 0.02, 0.05],
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

  const bsFair = computeBSFair(polyRef.price, K, clHistory, win.timeToCloseMs);
  if (bsFair == null) return [];

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;
  const sym = win.symbol;
  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const signals = [];

  const askUp = clobUp.bestAsk;
  const askDown = clobDown.bestAsk;

  // ─── MODE 1: EDGE ENTRY ───

  if (askUp < fairUp - minEdge
    && askUp <= maxEntryPrice
    && askUp > 0.01
    && upCost < maxPerSide
    && nowMs - lastUpBuyMs >= cooldownMs) {
    const tokens = capitalPerEntry / askUp;
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: UP, fair=${fairUp.toFixed(3)}, ask=${askUp.toFixed(3)}, edge=${(fairUp - askUp).toFixed(3)}`,
    });
    upCost += capitalPerEntry;
    upTokens += tokens;
    lastUpBuyMs = nowMs;
  }

  if (askDown < fairDown - minEdge
    && askDown <= maxEntryPrice
    && askDown > 0.01
    && downCost < maxPerSide
    && nowMs - lastDownBuyMs >= cooldownMs) {
    const tokens = capitalPerEntry / askDown;
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${askDown.toFixed(3)}, edge=${(fairDown - askDown).toFixed(3)}`,
    });
    downCost += capitalPerEntry;
    downTokens += tokens;
    lastDownBuyMs = nowMs;
  }

  // ─── MODE 2: HEDGE ENTRY ───

  if (upTokens > downTokens && downCost < maxPerSide && nowMs - lastDownBuyMs >= cooldownMs) {
    const avgUpPrice = upCost / upTokens;
    const maxDownPrice = 1.00 - avgUpPrice - minPairEdge;
    if (askDown > 0.01
      && askDown < maxDownPrice
      && askDown <= maxHedgePrice) {
      const tokens = capitalPerEntry / askDown;
      signals.push({
        action: 'buy',
        token: `${sym}-down`,
        capitalPerTrade: capitalPerEntry,
        reason: `hedge_buy: DOWN, avgUp=${avgUpPrice.toFixed(3)}, askDn=${askDown.toFixed(3)}, pairProfit=${(1.00 - avgUpPrice - askDown).toFixed(3)}`,
      });
      downCost += capitalPerEntry;
      downTokens += tokens;
      lastDownBuyMs = nowMs;
    }
  }

  if (downTokens > upTokens && upCost < maxPerSide && nowMs - lastUpBuyMs >= cooldownMs) {
    const avgDownPrice = downCost / downTokens;
    const maxUpPrice = 1.00 - avgDownPrice - minPairEdge;
    if (askUp > 0.01
      && askUp < maxUpPrice
      && askUp <= maxHedgePrice) {
      const tokens = capitalPerEntry / askUp;
      signals.push({
        action: 'buy',
        token: `${sym}-up`,
        capitalPerTrade: capitalPerEntry,
        reason: `hedge_buy: UP, avgDn=${avgDownPrice.toFixed(3)}, askUp=${askUp.toFixed(3)}, pairProfit=${(1.00 - avgDownPrice - askUp).toFixed(3)}`,
      });
      upCost += capitalPerEntry;
      upTokens += tokens;
      lastUpBuyMs = nowMs;
    }
  }

  return signals;
}

function computeBSFair(S, K, history, timeToCloseMs) {
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
