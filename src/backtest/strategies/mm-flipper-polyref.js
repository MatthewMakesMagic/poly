/**
 * Flip Trader MM: PolyRef
 *
 * Multiple round-trips per window:
 * - Buy cheap per BS (same edge entry as template)
 * - Track individual entries with prices
 * - When bestBid > entryPrice + minProfit, sell it
 * - After selling, can re-buy later if price drops back below fair - minEdge
 * - Track roundTrips count. No limit on round-trips.
 * - Hold final unsold positions to resolution
 *
 * S = polyRef.price
 * Vol estimated from CL history (settlement oracle).
 */

export const name = 'mm-flipper-polyref';
export const description = 'Flip trader MM: multiple round-trips per window, sells at bid when profitable, re-buys on dips.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 5000,
  minPairEdge: 0.02,
  minProfit: 0.03,
  entryWindowMs: 300000,
  exitWindowMs: 5000,
  maxEntryPrice: 0.65,
  maxHedgePrice: 0.65,
  minVolSamples: 10,
  windowDurationMs: 900000,
  spreadBuffer: 0,
};

export const sweepGrid = {
  minEdge: [0.01, 0.02, 0.03, 0.05],
  maxPerSide: [6, 10, 20],
  cooldownMs: [3000, 5000, 10000],
  capitalPerEntry: [2],
  minProfit: [0.02, 0.03, 0.05],
};

let upPositions = [];  // [{ entryPrice, tokens, cost }]
let downPositions = [];
let upTotalCost = 0;
let downTotalCost = 0;
let lastUpBuyMs = 0;
let lastDownBuyMs = 0;
let roundTrips = 0;
let clHistory = [];
let clOpen = null;

export function onWindowOpen(state) {
  upPositions = [];
  downPositions = [];
  upTotalCost = 0;
  downTotalCost = 0;
  lastUpBuyMs = 0;
  lastDownBuyMs = 0;
  roundTrips = 0;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
}

export function evaluate(state, config) {
  const {
    minEdge = defaults.minEdge,
    maxPerSide = defaults.maxPerSide,
    capitalPerEntry = defaults.capitalPerEntry,
    cooldownMs = defaults.cooldownMs,
    minProfit = defaults.minProfit,
    minPairEdge = defaults.minPairEdge,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    maxHedgePrice = defaults.maxHedgePrice,
    minVolSamples = defaults.minVolSamples,
  } = config;

  const { chainlink, clobUp, clobDown, polyRef, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
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

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;
  const sym = win.symbol;
  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const signals = [];

  const askUp = clobUp.bestAsk;
  const askDown = clobDown.bestAsk;
  const bidUp = clobUp.bestBid;
  const bidDown = clobDown.bestBid;

  // ─── SELL: Flip positions for profit ───

  if (upPositions.length > 0 && bidUp > 0) {
    for (let i = 0; i < upPositions.length; i++) {
      if (bidUp > upPositions[i].entryPrice + minProfit) {
        signals.push({
          action: 'sell',
          token: `${sym}-up`,
          size: upPositions[i].tokens,
          reason: `flip_sell: UP, entry=${upPositions[i].entryPrice.toFixed(3)}, bid=${bidUp.toFixed(3)}, rt=${roundTrips}`,
        });
        upTotalCost -= upPositions[i].cost;
        upPositions.splice(i, 1);
        roundTrips++;
        break; // one sell per tick
      }
    }
  }

  if (downPositions.length > 0 && bidDown > 0) {
    for (let i = 0; i < downPositions.length; i++) {
      if (bidDown > downPositions[i].entryPrice + minProfit) {
        signals.push({
          action: 'sell',
          token: `${sym}-down`,
          size: downPositions[i].tokens,
          reason: `flip_sell: DOWN, entry=${downPositions[i].entryPrice.toFixed(3)}, bid=${bidDown.toFixed(3)}, rt=${roundTrips}`,
        });
        downTotalCost -= downPositions[i].cost;
        downPositions.splice(i, 1);
        roundTrips++;
        break;
      }
    }
  }

  // ─── BUY: Edge entry (can re-buy after selling) ───

  if (askUp < fairUp - minEdge
    && askUp <= maxEntryPrice
    && askUp > 0.01
    && upTotalCost < maxPerSide
    && nowMs - lastUpBuyMs >= cooldownMs) {
    const tokens = capitalPerEntry / askUp;
    signals.push({
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: UP, fair=${fairUp.toFixed(3)}, ask=${askUp.toFixed(3)}, rt=${roundTrips}`,
    });
    upPositions.push({ entryPrice: askUp, tokens, cost: capitalPerEntry });
    upTotalCost += capitalPerEntry;
    lastUpBuyMs = nowMs;
  }

  if (askDown < fairDown - minEdge
    && askDown <= maxEntryPrice
    && askDown > 0.01
    && downTotalCost < maxPerSide
    && nowMs - lastDownBuyMs >= cooldownMs) {
    const tokens = capitalPerEntry / askDown;
    signals.push({
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: capitalPerEntry,
      reason: `edge_buy: DOWN, fair=${fairDown.toFixed(3)}, ask=${askDown.toFixed(3)}, rt=${roundTrips}`,
    });
    downPositions.push({ entryPrice: askDown, tokens, cost: capitalPerEntry });
    downTotalCost += capitalPerEntry;
    lastDownBuyMs = nowMs;
  }

  // ─── HEDGE: Position-aware hedging ───

  const upTokenTotal = upPositions.reduce((s, p) => s + p.tokens, 0);
  const downTokenTotal = downPositions.reduce((s, p) => s + p.tokens, 0);

  if (upTokenTotal > downTokenTotal && downTotalCost < maxPerSide && nowMs - lastDownBuyMs >= cooldownMs) {
    const avgUpPrice = upTotalCost / upTokenTotal;
    const maxDownPrice = 1.00 - avgUpPrice - minPairEdge;
    if (askDown > 0.01 && askDown < maxDownPrice && askDown <= maxHedgePrice) {
      const tokens = capitalPerEntry / askDown;
      signals.push({
        action: 'buy',
        token: `${sym}-down`,
        capitalPerTrade: capitalPerEntry,
        reason: `hedge_buy: DOWN, avgUp=${avgUpPrice.toFixed(3)}, askDn=${askDown.toFixed(3)}`,
      });
      downPositions.push({ entryPrice: askDown, tokens, cost: capitalPerEntry });
      downTotalCost += capitalPerEntry;
      lastDownBuyMs = nowMs;
    }
  }

  if (downTokenTotal > upTokenTotal && upTotalCost < maxPerSide && nowMs - lastUpBuyMs >= cooldownMs) {
    const avgDownPrice = downTotalCost / downTokenTotal;
    const maxUpPrice = 1.00 - avgDownPrice - minPairEdge;
    if (askUp > 0.01 && askUp < maxUpPrice && askUp <= maxHedgePrice) {
      const tokens = capitalPerEntry / askUp;
      signals.push({
        action: 'buy',
        token: `${sym}-up`,
        capitalPerTrade: capitalPerEntry,
        reason: `hedge_buy: UP, avgDn=${avgDownPrice.toFixed(3)}, askUp=${askUp.toFixed(3)}`,
      });
      upPositions.push({ entryPrice: askUp, tokens, cost: capitalPerEntry });
      upTotalCost += capitalPerEntry;
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
