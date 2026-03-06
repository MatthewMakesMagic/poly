/**
 * Informed Market Maker
 *
 * Acts like a real MM: has a fair value opinion (BS model), loads up on the
 * cheap side, and actively exits if the market moves against the position.
 *
 * Key difference from directional strategies: EARLY EXIT on adverse moves.
 * Instead of riding losing positions to resolution ($0.00), sells mid-window
 * when BS fair value flips, recovering partial value from the CLOB.
 *
 * Flow per window:
 *   1. Compute BS fair value continuously
 *   2. When one side is cheap (ask < fair - edge), buy it
 *   3. Monitor: if BS fair flips direction, sell immediately at CLOB bid
 *   4. Can re-enter if direction flips back (up to maxTrades per window)
 *
 * P&L profile:
 *   - Wins: hold to resolution → $1.00 payout (full profit)
 *   - Losses: early exit at CLOB bid → partial recovery (smaller loss than $0.00 resolution)
 *   - Net: higher WR isn't needed if loss-cutting makes avg loss << avg win
 */

export const name = 'mm-informed';
export const description = 'Informed MM: buy cheap side per BS model, early-exit if fair value flips against position.';

export const defaults = {
  fairEdge: 0.05,              // Buy when ask is 5c below fair value
  exitEdge: 0.03,              // Exit when BS fair moves 3c against our position
  entryWindowMs: 300000,       // Start quoting with 5 min left
  exitWindowMs: 10000,         // Stop entering in final 10s
  maxEntryPrice: 0.60,
  capitalPerTrade: 2,
  minVolSamples: 10,
  maxTradesPerWindow: 2,       // Allow re-entry after exit
  windowDurationMs: 900000,
  spreadBuffer: 0,             // Maker fills — no slippage
};

export const sweepGrid = {
  fairEdge: [0.03, 0.05, 0.08, 0.10, 0.15],
  exitEdge: [0.02, 0.03, 0.05, 0.08],
  entryWindowMs: [180000, 300000, 600000],
  maxEntryPrice: [0.55, 0.60, 0.65],
};

// Per-window state
let position = null;   // { token, side, entryFair }
let tradeCount = 0;
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  position = null;
  tradeCount = 0;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
}

export function evaluate(state, config) {
  const {
    fairEdge = defaults.fairEdge,
    exitEdge = defaults.exitEdge,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    capitalPerTrade = defaults.capitalPerTrade,
    minVolSamples = defaults.minVolSamples,
    maxTradesPerWindow = defaults.maxTradesPerWindow,
    windowDurationMs = defaults.windowDurationMs,
  } = config;

  const { chainlink, clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K || !chainlink?.price) return [];
  if (clHistory.length < minVolSamples) return [];

  // Compute BS fair value
  const bsFair = computeBSFair(chainlink.price, K, clHistory, win.timeToCloseMs);
  if (bsFair == null) return [];

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;
  const sym = win.symbol;
  const signals = [];

  // ─── EXIT LOGIC: check if we should cut losses ───
  if (position) {
    let shouldExit = false;
    let exitReason = '';

    if (position.side === 'up') {
      // We're long UP. Exit if fair value has dropped (BS now says DOWN is more likely)
      const fairDrop = position.entryFair - fairUp;
      if (fairDrop > exitEdge) {
        shouldExit = true;
        exitReason = `mm_exit: fairDrop=${fairDrop.toFixed(3)}, was=${position.entryFair.toFixed(3)}, now=${fairUp.toFixed(3)}`;
      }
    } else {
      // We're long DOWN. Exit if fair value has risen (BS now says UP is more likely)
      const fairRise = fairUp - (1 - position.entryFair);
      if (fairRise > exitEdge) {
        shouldExit = true;
        exitReason = `mm_exit: fairRise=${fairRise.toFixed(3)}, was=${(1-position.entryFair).toFixed(3)}, now=${fairUp.toFixed(3)}`;
      }
    }

    if (shouldExit) {
      signals.push({
        action: 'sell',
        token: position.token,
        reason: exitReason,
      });
      position = null;
      // Don't return yet — might re-enter on the other side
    }
  }

  // ─── ENTRY LOGIC: buy the cheap side ───
  if (!position && tradeCount < maxTradesPerWindow) {
    // Respect entry window
    if (win.timeToCloseMs < entryWindowMs && win.timeToCloseMs > exitWindowMs) {

      // Check UP side
      if (clobUp.bestAsk < fairUp - fairEdge && clobUp.bestAsk <= maxEntryPrice && clobUp.bestAsk > 0.02) {
        position = { token: `${sym}-up`, side: 'up', entryFair: fairUp };
        tradeCount++;
        signals.push({
          action: 'buy',
          token: `${sym}-up`,
          capitalPerTrade,
          reason: `mm_enter: side=UP, fair=${fairUp.toFixed(3)}, ask=${clobUp.bestAsk.toFixed(3)}, edge=${(fairUp - clobUp.bestAsk).toFixed(3)}`,
        });
      }
      // Check DOWN side (only if we didn't just buy UP)
      else if (clobDown.bestAsk < fairDown - fairEdge && clobDown.bestAsk <= maxEntryPrice && clobDown.bestAsk > 0.02) {
        position = { token: `${sym}-down`, side: 'down', entryFair: fairDown };
        tradeCount++;
        signals.push({
          action: 'buy',
          token: `${sym}-down`,
          capitalPerTrade,
          reason: `mm_enter: side=DOWN, fair=${fairDown.toFixed(3)}, ask=${clobDown.bestAsk.toFixed(3)}, edge=${(fairDown - clobDown.bestAsk).toFixed(3)}`,
        });
      }
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
