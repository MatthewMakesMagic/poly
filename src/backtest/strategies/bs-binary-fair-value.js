/**
 * Black-Scholes Binary Fair Value
 *
 * Treats each 15-min window as a cash-or-nothing binary option.
 * Uses realized CL volatility to compute BS fair probability of UP.
 * Trades when CLOB diverges significantly from BS fair value.
 *
 * BS binary call: P(UP) = N(d2)
 * d2 = ln(S/K) / (σ√T)   [r≈0, drift≈0 for 15min]
 * S = current CL price
 * K = CL@open (oracle_price_at_open)
 * T = time remaining / total window time
 * σ = realized CL volatility (annualized, computed from recent ticks)
 *
 * The key insight: when S≈K and T>0, BS says fair value ≈ 0.50.
 * But CLOB often prices 0.80+ for tiny leads. BS quantifies the overpricing.
 */

export const name = 'bs-binary-fair-value';
export const description = 'Black-Scholes binary option pricing. Trades when CLOB diverges from BS fair probability.';

export const defaults = {
  mispricingThreshold: 0.15,  // CLOB must differ from BS fair by 15+ cents
  entryWindowMs: 90000,       // Last 90s
  maxEntryPrice: 0.65,
  capitalPerTrade: 2,
  minVolSamples: 10,          // Need at least 10 CL ticks to estimate vol
  windowDurationMs: 900000,   // 15 min total window
};

export const sweepGrid = {
  mispricingThreshold: [0.10, 0.15, 0.20, 0.25, 0.30],
  entryWindowMs: [60000, 90000, 120000],
  maxEntryPrice: [0.55, 0.60, 0.65, 0.70],
};

// Per-window state
let hasBought = false;
let clHistory = [];  // { price, ms }
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
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  // Track CL history for vol estimation
  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null || win.timeToCloseMs >= entryWindowMs) return [];
  if (!chainlink?.price) return [];

  // Get CL@open from window data or first CL reading
  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];

  const S = chainlink.price;
  const T = win.timeToCloseMs / windowDurationMs;  // fraction of window remaining
  if (T <= 0) return [];

  // Estimate realized volatility from CL history
  if (clHistory.length < minVolSamples) return [];

  // Compute log returns
  let sumSqReturns = 0;
  let returnCount = 0;
  for (let i = 1; i < clHistory.length; i++) {
    const dt = (clHistory[i].ms - clHistory[i-1].ms) / 1000;  // seconds
    if (dt <= 0 || dt > 30) continue;  // skip gaps
    const logReturn = Math.log(clHistory[i].price / clHistory[i-1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 5) return [];

  // Annualized vol from per-second variance
  const avgTimeStepSec = (clHistory[clHistory.length-1].ms - clHistory[0].ms) / 1000 / returnCount;
  if (avgTimeStepSec <= 0) return [];
  const varPerSec = sumSqReturns / returnCount / avgTimeStepSec;
  const sigmaAnnualized = Math.sqrt(varPerSec * 365.25 * 24 * 3600);

  // BS d2 for binary option (no drift, r=0)
  const logSK = Math.log(S / K);
  const Tyears = (win.timeToCloseMs / 1000) / (365.25 * 24 * 3600);
  const sqrtT = Math.sqrt(Tyears);
  if (sigmaAnnualized * sqrtT < 1e-10) return [];  // avoid division by zero

  const d2 = (logSK - 0.5 * sigmaAnnualized * sigmaAnnualized * Tyears) / (sigmaAnnualized * sqrtT);

  // N(d2) using approximation
  const bsFairUp = normalCDF(d2);

  // Compare to CLOB
  const clobUpPrice = clobUp.mid;
  const mispricing = clobUpPrice - bsFairUp;

  // CLOB overprices UP → buy DOWN (it's cheap)
  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_fair: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, σ=${(sigmaAnnualized*100).toFixed(1)}%` }];
  }
  // CLOB underprices UP → buy UP
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_fair: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, σ=${(sigmaAnnualized*100).toFixed(1)}%` }];
  }

  return [];
}

// Standard normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x) {
  if (x > 6) return 1;
  if (x < -6) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327;  // 1/sqrt(2*PI)
  const p = d * Math.exp(-x * x / 2) *
    (t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x > 0 ? 1 - p : p;
}
