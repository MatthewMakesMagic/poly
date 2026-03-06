/**
 * BS Theta Decay
 *
 * Exploits the time-decay (theta) of binary options near close.
 * As T→0, BS fair value snaps to 0 or 1 (depending on S vs K).
 * But CLOB often prices in a middle zone (0.40-0.60) even very close to expiry.
 *
 * This strategy specifically targets the final 30s where theta decay is strongest.
 * Only trades when BS says fair value is extreme (>0.70 or <0.30) but CLOB hasn't caught up.
 */

export const name = 'bs-theta-decay';
export const description = 'Targets late-window theta decay. Trades when BS snaps toward 0/1 but CLOB stays in middle zone.';

export const defaults = {
  mispricingThreshold: 0.15,
  entryWindowMs: 30000,       // Last 30s — theta is strongest
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  bsExtremeThreshold: 0.65,   // BS must be >0.65 or <0.35 to trigger
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.10, 0.15, 0.20, 0.25],
  entryWindowMs: [20000, 30000, 45000],
  bsExtremeThreshold: [0.60, 0.65, 0.70, 0.75],
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
    bsExtremeThreshold = defaults.bsExtremeThreshold,
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

  // Only trade when BS is extreme (theta has pushed fair value far from 0.50)
  if (bsFairUp < bsExtremeThreshold && bsFairUp > (1 - bsExtremeThreshold)) return [];

  const clobUpPrice = clobUp.mid;
  const mispricing = clobUpPrice - bsFairUp;

  // BS says strong UP (fair >0.65) but CLOB still cheap → buy UP
  if (bsFairUp >= bsExtremeThreshold && mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_theta: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, T=${(win.timeToCloseMs/1000).toFixed(0)}s, gap=${mispricing.toFixed(3)}` }];
  }
  // BS says strong DOWN (fair <0.35) but CLOB UP still high → buy DOWN
  if (bsFairUp <= (1 - bsExtremeThreshold) && mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_theta: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, T=${(win.timeToCloseMs/1000).toFixed(0)}s, gap=${mispricing.toFixed(3)}` }];
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
