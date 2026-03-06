/**
 * Market Maker: BS Spread Capture
 *
 * Binary market MM strategy. Instead of betting on direction, buys BOTH sides
 * when CLOB prices them below BS fair value.
 *
 * Mechanics:
 *   - Compute BS fair: P(UP) = N(d2), P(DOWN) = 1 - P(UP)
 *   - Buy UP when clobUp.bestAsk < fairUp - edge
 *   - Buy DOWN when clobDown.bestAsk < fairDown - edge
 *   - If BOTH legs fill: payout = $1.00, profit = 1.00 - totalCost (locked in)
 *   - If ONE leg fills: directional risk, resolved at window close
 *
 * On Polymarket: buying UP at $0.47 + buying DOWN at $0.47 = $0.94 cost.
 * One side pays $1.00 at resolution → $0.06 guaranteed profit.
 * The key: UP_ask + DOWN_ask must sum to < $1.00 for riskless spread.
 *
 * Maker fees: 0% on Polymarket (+ daily rebates from taker fees).
 * Post-only orders guarantee maker status in live trading.
 */

export const name = 'mm-bs-spread';
export const description = 'Binary MM: buy both UP and DOWN when CLOB asks are below BS fair value. Captures spread when both legs fill.';

export const defaults = {
  fairEdge: 0.03,             // Buy when ask is 3c below fair value
  entryWindowMs: 300000,      // Quote throughout last 5 min (MM wants more time)
  exitWindowMs: 15000,        // Stop quoting in final 15s (adverse selection)
  maxEntryPrice: 0.65,        // Max price per leg
  capitalPerTrade: 2,         // Per LEG (so max $4 deployed per window)
  minVolSamples: 10,
  windowDurationMs: 900000,
  spreadBuffer: 0,            // MM uses post-only limit orders → zero slippage
};

export const sweepGrid = {
  fairEdge: [0.01, 0.02, 0.03, 0.05, 0.08],
  entryWindowMs: [180000, 300000, 600000],
  exitWindowMs: [10000, 15000, 30000],
  maxEntryPrice: [0.55, 0.60, 0.65],
};

let boughtUp = false;
let boughtDown = false;
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  boughtUp = false;
  boughtDown = false;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
}

export function evaluate(state, config) {
  if (boughtUp && boughtDown) return [];  // Both legs filled, done

  const {
    fairEdge = defaults.fairEdge,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
    minVolSamples = defaults.minVolSamples,
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  // Entry window: not too early, not too late
  if (win.timeToCloseMs == null) return [];
  if (win.timeToCloseMs >= entryWindowMs) return [];   // Too early
  if (win.timeToCloseMs <= exitWindowMs) return [];     // Too late (adverse selection zone)

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
  const fairUp = normalCDF(d2);
  const fairDown = 1 - fairUp;

  const signals = [];
  const sym = win.symbol;

  // Buy UP leg: ask must be below our fair minus edge
  if (!boughtUp && clobUp.bestAsk < fairUp - fairEdge && clobUp.bestAsk <= maxEntryPrice && clobUp.bestAsk > 0.01) {
    boughtUp = true;
    const legStatus = boughtDown ? 'BOTH' : 'UP_only';
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade,
      reason: `mm_spread: leg=UP, fair=${fairUp.toFixed(3)}, ask=${clobUp.bestAsk.toFixed(3)}, edge=${(fairUp - clobUp.bestAsk).toFixed(3)}, legs=${legStatus}`,
    });
  }

  // Buy DOWN leg: ask must be below our fair minus edge
  if (!boughtDown && clobDown.bestAsk < fairDown - fairEdge && clobDown.bestAsk <= maxEntryPrice && clobDown.bestAsk > 0.01) {
    boughtDown = true;
    const legStatus = boughtUp ? 'BOTH' : 'DOWN_only';
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade,
      reason: `mm_spread: leg=DOWN, fair=${fairDown.toFixed(3)}, ask=${clobDown.bestAsk.toFixed(3)}, edge=${(fairDown - clobDown.bestAsk).toFixed(3)}, legs=${legStatus}`,
    });
  }

  return signals;
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
