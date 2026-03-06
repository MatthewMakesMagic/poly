/**
 * Paired MM: Momentum Entry
 *
 * Like mm-paired-polyref but tracks exchange momentum to prioritize
 * counter-trend positioning for better fills:
 * - Keep last 5 exchange median prices
 * - momentum = (latest - oldest) / oldest (percentage move)
 * - If momentum > 0 (trending UP): prioritize DOWN buys (reduce cooldown by 50%)
 * - If momentum < 0 (trending DOWN): prioritize UP buys (reduce cooldown by 50%)
 *
 * Counter-trend positioning means buying the side that will likely revert,
 * giving better entry prices and improving pair matching.
 *
 * S = polyRef.price
 * Vol estimated from CL history (settlement oracle).
 */

export const name = 'mm-paired-momentum';
export const description = 'Paired MM with momentum-based entry priority. Reduces cooldown on counter-trend side for better fills.';

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
  momentumSamples: 5,
  cooldownDiscount: 0.5,
};

export const sweepGrid = {
  minEdge: [0.01, 0.02, 0.03, 0.05],
  maxPerSide: [6, 10, 20],
  cooldownMs: [5000, 10000, 15000],
  capitalPerEntry: [2],
  minPairEdge: [0.01, 0.02, 0.05],
  momentumSamples: [3, 5, 10],
  cooldownDiscount: [0.25, 0.5, 0.75],
};

let upCost = 0;
let downCost = 0;
let upTokens = 0;
let downTokens = 0;
let lastUpBuyMs = 0;
let lastDownBuyMs = 0;
let clHistory = [];
let clOpen = null;
let exchangeHistory = []; // recent exchange median prices

export function onWindowOpen(state) {
  upCost = 0;
  downCost = 0;
  upTokens = 0;
  downTokens = 0;
  lastUpBuyMs = 0;
  lastDownBuyMs = 0;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
  exchangeHistory = [];
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
    momentumSamples = defaults.momentumSamples,
    cooldownDiscount = defaults.cooldownDiscount,
  } = config;

  const { chainlink, clobUp, clobDown, polyRef, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  // Track exchange median for momentum
  if (typeof state.getExchangeMedian === 'function') {
    const median = state.getExchangeMedian();
    if (median) {
      exchangeHistory.push(median);
      if (exchangeHistory.length > momentumSamples * 2) {
        exchangeHistory = exchangeHistory.slice(-momentumSamples * 2);
      }
    }
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

  // Compute momentum from exchange medians
  let momentum = 0;
  if (exchangeHistory.length >= momentumSamples) {
    const oldest = exchangeHistory[exchangeHistory.length - momentumSamples];
    const latest = exchangeHistory[exchangeHistory.length - 1];
    if (oldest > 0) momentum = (latest - oldest) / oldest;
  }

  // Adjust cooldowns based on momentum (counter-trend gets discount)
  const upCooldown = momentum < 0
    ? cooldownMs * cooldownDiscount  // trending DOWN, favor UP buys
    : cooldownMs;
  const downCooldown = momentum > 0
    ? cooldownMs * cooldownDiscount  // trending UP, favor DOWN buys
    : cooldownMs;

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;
  const sym = win.symbol;
  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const signals = [];

  const askUp = clobUp.bestAsk;
  const askDown = clobDown.bestAsk;

  // MODE 1: EDGE ENTRY with momentum-adjusted cooldowns
  if (askUp < fairUp - minEdge
    && askUp <= maxEntryPrice
    && askUp > 0.01
    && upCost < maxPerSide
    && nowMs - lastUpBuyMs >= upCooldown) {
    const tokens = capitalPerEntry / askUp;
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: UP, fair=${fairUp.toFixed(3)}, ask=${askUp.toFixed(3)}, mom=${(momentum * 100).toFixed(3)}%, cd=${upCooldown.toFixed(0)}ms`,
    });
    upCost += capitalPerEntry;
    upTokens += tokens;
    lastUpBuyMs = nowMs;
  }

  if (askDown < fairDown - minEdge
    && askDown <= maxEntryPrice
    && askDown > 0.01
    && downCost < maxPerSide
    && nowMs - lastDownBuyMs >= downCooldown) {
    const tokens = capitalPerEntry / askDown;
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${askDown.toFixed(3)}, mom=${(momentum * 100).toFixed(3)}%, cd=${downCooldown.toFixed(0)}ms`,
    });
    downCost += capitalPerEntry;
    downTokens += tokens;
    lastDownBuyMs = nowMs;
  }

  // MODE 2: HEDGE ENTRY
  if (upTokens > downTokens && downCost < maxPerSide && nowMs - lastDownBuyMs >= downCooldown) {
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

  if (downTokens > upTokens && upCost < maxPerSide && nowMs - lastUpBuyMs >= upCooldown) {
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
