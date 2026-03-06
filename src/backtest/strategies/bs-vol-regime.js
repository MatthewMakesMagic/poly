/**
 * BS Vol Regime
 *
 * Compares recent vol (last 30s) to full-window vol.
 * If vol is accelerating (recent > full), uses the higher recent vol for BS.
 * If vol is decelerating, uses the lower full-window vol.
 *
 * The insight: when vol spikes near close, BS fair value widens (more uncertainty),
 * making extreme CLOB prices even more of a mispricing opportunity.
 * When vol is calm, tighter BS bounds mean smaller mispricings are tradeable.
 */

export const name = 'bs-vol-regime';
export const description = 'BS pricing with vol regime detection. Uses max(recent, full-window) vol when accelerating.';

export const defaults = {
  mispricingThreshold: 0.20,
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  recentVolWindowMs: 30000,    // Last 30s for "recent" vol
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.15, 0.20, 0.25, 0.30],
  entryWindowMs: [60000, 90000, 120000],
  recentVolWindowMs: [20000, 30000, 45000],
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
    recentVolWindowMs = defaults.recentVolWindowMs,
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

  const nowMs = clHistory[clHistory.length - 1].ms;

  // Full-window vol
  const fullVol = computeVol(clHistory);
  if (fullVol == null) return [];

  // Recent vol (last N ms)
  const recentCutoff = nowMs - recentVolWindowMs;
  const recentTicks = clHistory.filter(t => t.ms >= recentCutoff);
  const recentVol = recentTicks.length >= 5 ? computeVol(recentTicks) : fullVol;

  // Vol regime: use higher vol if accelerating, lower if decelerating
  const sigmaAnnualized = Math.max(recentVol || 0, fullVol);

  const S = chainlink.price;
  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return [];

  const logSK = Math.log(S / K);
  const d2 = (logSK - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);
  const bsFairUp = normalCDF(d2);

  const clobUpPrice = clobUp.mid;
  const mispricing = clobUpPrice - bsFairUp;

  const volRegime = (recentVol != null && recentVol > fullVol * 1.2) ? 'accel' : 'calm';

  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_volreg: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, regime=${volRegime}` }];
  }
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_volreg: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, regime=${volRegime}` }];
  }

  return [];
}

function computeVol(ticks) {
  let sumSqReturns = 0, returnCount = 0;
  for (let i = 1; i < ticks.length; i++) {
    const dt = (ticks[i].ms - ticks[i-1].ms) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const logReturn = Math.log(ticks[i].price / ticks[i-1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 3) return null;

  const avgTimeStepSec = (ticks[ticks.length-1].ms - ticks[0].ms) / 1000 / returnCount;
  if (avgTimeStepSec <= 0) return null;
  const varPerSec = sumSqReturns / returnCount / avgTimeStepSec;
  return Math.sqrt(varPerSec * 365.25 * 24 * 3600);
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
