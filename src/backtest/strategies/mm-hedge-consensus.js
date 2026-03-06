/**
 * Continuous MM: Exchange Consensus Filter
 *
 * True continuous market maker using exchange median as S, but PAUSES buying
 * (not skips entire window) when exchange spread > threshold.
 * Resumes buying when spread tightens again.
 *
 * S = exchange median, gated by exchange consensus
 * Vol estimated from CL history.
 *
 * Much more natural than v1's "skip the entire window" approach.
 */

export const name = 'mm-hedge-consensus';
export const description = 'Continuous MM: exchange median BS + consensus filter. Pauses buying when exchanges disagree, resumes when they agree.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 10000,
  maxExchangeSpreadPct: 0.0005,
  minExchanges: 3,
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
    maxExchangeSpreadPct = defaults.maxExchangeSpreadPct,
    minExchanges = defaults.minExchanges,
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

  const exchangeMedian = state.getExchangeMedian();
  if (!exchangeMedian) return [];

  if (win.timeToCloseMs >= entryWindowMs || win.timeToCloseMs <= exitWindowMs) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];
  if (clHistory.length < minVolSamples) return [];

  // Consensus check: pause buying when exchanges disagree (don't skip entire window)
  const exchSpread = state.getExchangeSpread();
  const exchanges = state.getAllExchanges();
  if (!exchSpread || exchanges.length < minExchanges) return [];
  if (exchSpread.rangePct > maxExchangeSpreadPct) return [];

  const bsFair = computeBSFair(exchangeMedian, K, clHistory, win.timeToCloseMs);
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
      reason: `mm_buy: UP, fair=${fairUp.toFixed(3)}, ask=${clobUp.bestAsk.toFixed(3)}, edge=${(fairUp - clobUp.bestAsk).toFixed(3)}, spread=${(exchSpread.rangePct*100).toFixed(3)}%`,
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
      reason: `mm_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${clobDown.bestAsk.toFixed(3)}, edge=${(fairDown - clobDown.bestAsk).toFixed(3)}, spread=${(exchSpread.rangePct*100).toFixed(3)}%`,
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
