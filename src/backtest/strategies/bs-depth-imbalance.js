/**
 * BS Depth Imbalance
 *
 * Combines BS pricing with CLOB order book depth imbalance as confirmation.
 * Only trades when:
 * 1. BS identifies mispricing
 * 2. CLOB depth confirms the direction (more size on the side we're betting)
 *
 * Depth imbalance = (bidSize - askSize) / (bidSize + askSize)
 * Positive imbalance = more bids = bullish pressure
 *
 * Very selective: requires both quantitative (BS) and microstructure (depth) agreement.
 */

export const name = 'bs-depth-imbalance';
export const description = 'BS pricing confirmed by CLOB depth imbalance. Requires both quant and microstructure agreement.';

export const defaults = {
  mispricingThreshold: 0.15,
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  minDepthImbalance: 0.20,     // Depth must be 20%+ skewed in our direction
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.10, 0.15, 0.20, 0.25],
  entryWindowMs: [60000, 90000, 120000],
  minDepthImbalance: [0.10, 0.20, 0.30, 0.40],
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
    minDepthImbalance = defaults.minDepthImbalance,
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
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];

  if (clHistory.length < minVolSamples) return [];

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

  const S = chainlink.price;
  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return [];

  const logSK = Math.log(S / K);
  const d2 = (logSK - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
  const bsFairUp = normalCDF(d2);

  const clobUpPrice = clobUp.mid;
  const mispricing = clobUpPrice - bsFairUp;

  // Compute depth imbalance for UP token
  const upTotal = (clobUp.bidSize || 0) + (clobUp.askSize || 0);
  const upImbalance = upTotal > 0 ? ((clobUp.bidSize || 0) - (clobUp.askSize || 0)) / upTotal : 0;

  // Compute depth imbalance for DOWN token
  const downTotal = (clobDown.bidSize || 0) + (clobDown.askSize || 0);
  const downImbalance = downTotal > 0 ? ((clobDown.bidSize || 0) - (clobDown.askSize || 0)) / downTotal : 0;

  // CLOB overprices UP → buy DOWN, confirm with DOWN depth (positive imbalance = bids > asks = bullish for DOWN)
  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    if (downImbalance >= minDepthImbalance) {
      hasBought = true;
      return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
        reason: `bs_depth: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, downImbal=${downImbalance.toFixed(2)}` }];
    }
  }
  // CLOB underprices UP → buy UP, confirm with UP depth
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    if (upImbalance >= minDepthImbalance) {
      hasBought = true;
      return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
        reason: `bs_depth: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, upImbal=${upImbalance.toFixed(2)}` }];
    }
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
