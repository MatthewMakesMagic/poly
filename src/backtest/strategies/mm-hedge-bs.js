/**
 * Continuous MM: CL Fair Value (Baseline)
 *
 * True continuous market maker that buys BOTH sides whenever cheap.
 * No "primary leg" or "hedge" — just buy whatever's below fair value.
 *
 * S = chainlink.price (settlement oracle, simplest model)
 *
 * Core loop every tick:
 *   1. Compute fair value: fairUp = BS(S, K, σ, T), fairDown = 1 - fairUp
 *   2. If clobUp.bestAsk < fairUp - minEdge → BUY UP
 *   3. If clobDown.bestAsk < fairDown - minEdge → BUY DOWN
 *   4. Both can fire on the same tick
 *
 * P&L: paired UP+DOWN tokens guarantee $1.00. Profit = $1.00 - (upPrice + downPrice).
 * Unmatched tokens resolved directionally. All entries at maker (0% fee).
 */

export const name = 'mm-hedge-bs';
export const description = 'Continuous MM: BS fair from CL. Buy both sides whenever cheap, profit from spread + resolution.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 10000,
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

  // Time window check
  if (win.timeToCloseMs >= entryWindowMs || win.timeToCloseMs <= exitWindowMs) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];
  if (clHistory.length < minVolSamples) return [];

  const bsFair = computeBSFair(chainlink.price, K, clHistory, win.timeToCloseMs);
  if (bsFair == null) return [];

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
      capitalPerTrade: capitalPerEntry,
      reason: `mm_buy: UP, fair=${fairUp.toFixed(3)}, ask=${clobUp.bestAsk.toFixed(3)}, edge=${(fairUp - clobUp.bestAsk).toFixed(3)}, deployed=$${upCost.toFixed(1)}`,
    });
    upCost += capitalPerEntry;
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
      capitalPerTrade: capitalPerEntry,
      reason: `mm_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${clobDown.bestAsk.toFixed(3)}, edge=${(fairDown - clobDown.bestAsk).toFixed(3)}, deployed=$${downCost.toFixed(1)}`,
    });
    downCost += capitalPerEntry;
    lastDownBuyMs = nowMs;
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
