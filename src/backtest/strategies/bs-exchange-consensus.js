/**
 * BS Exchange Consensus
 *
 * Combines BS pricing with exchange agreement filter.
 * Only trades when:
 * 1. BS identifies mispricing (CLOB vs fair value)
 * 2. Exchange spread is tight (exchanges agree on price)
 *
 * When exchanges disagree (wide spread), vol is uncertain and BS estimates unreliable.
 * Tight exchange consensus → high-confidence vol → trustworthy BS signal.
 */

export const name = 'bs-exchange-consensus';
export const description = 'BS pricing filtered by exchange consensus. Only trades when exchange spread is tight (high-confidence vol).';

export const defaults = {
  mispricingThreshold: 0.15,
  entryWindowMs: 90000,
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  maxExchangeSpreadPct: 0.0005,  // Max 0.05% spread across exchanges
  minExchanges: 3,
  windowDurationMs: 900000,
};

export const sweepGrid = {
  mispricingThreshold: [0.10, 0.15, 0.20, 0.25],
  entryWindowMs: [60000, 90000, 120000],
  maxExchangeSpreadPct: [0.0003, 0.0005, 0.001],
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
    maxExchangeSpreadPct = defaults.maxExchangeSpreadPct,
    minExchanges = defaults.minExchanges,
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

  // Check exchange consensus
  const exchSpread = state.getExchangeSpread();
  if (!exchSpread) return [];

  const exchanges = state.getAllExchanges();
  if (exchanges.length < minExchanges) return [];

  // Filter: exchanges must be tightly clustered
  if (exchSpread.rangePct > maxExchangeSpreadPct) return [];

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

  if (mispricing > mispricingThreshold && clobDown.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-down`, capitalPerTrade,
      reason: `bs_consensus: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, exchSpread=${(exchSpread.rangePct*100).toFixed(3)}%` }];
  }
  if (mispricing < -mispricingThreshold && clobUp.bestAsk <= maxEntryPrice) {
    hasBought = true;
    return [{ action: 'buy', token: `${win.symbol}-up`, capitalPerTrade,
      reason: `bs_consensus: P(UP)=${bsFairUp.toFixed(3)}, CLOB=${clobUpPrice.toFixed(3)}, gap=${mispricing.toFixed(3)}, exchSpread=${(exchSpread.rangePct*100).toFixed(3)}%` }];
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
