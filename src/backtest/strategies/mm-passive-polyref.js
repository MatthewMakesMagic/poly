/**
 * Passive Market Maker: PolyRef with Limit Orders
 *
 * True market-making strategy using passive limit orders instead of aggressive crossing.
 * Posts resting bids ahead of fair value and earns the spread passively.
 *
 * Core logic:
 *   1. Compute BS fair value for UP token from polyRef/CL data
 *   2. Post bid for UP at fair - halfSpread
 *   3. Post bid for DOWN at (1 - fair) - halfSpread
 *   4. When filled on one side, tighten the other side's bid to encourage matching
 *   5. Cancel all orders at T-30s, use aggressive fallback if position is lopsided
 *
 * Signal types:
 *   - place_limit_buy: post resting bids
 *   - cancel_all: clear stale quotes when fair value moves
 *   - buy (aggressive): fallback for late-window hedge if position is lopsided
 *
 * Requires L2 orderbook data for fill simulation.
 */

export const name = 'mm-passive-polyref';
export const description = 'Passive MM using limit orders. Posts bids at fair-spread, earns spread passively via L2 fill simulation.';
export const usesPassiveOrders = true;

export const defaults = {
  halfSpread: 0.03,          // half-spread from fair value (bid at fair - 0.03)
  minEdge: 0.01,             // min edge for a bid to be worthwhile
  maxPerSide: 10,            // max capital per side
  capitalPerEntry: 2,        // capital per limit order
  requoteThreshold: 0.02,    // requote when fair value moves this much
  cooldownMs: 5000,          // min ms between new quote placements
  entryWindowMs: 270000,     // stop new entries at T-30s (300000 - 30000)
  exitWindowMs: 30000,       // cancel all orders at T-30s
  aggressiveHedgeMs: 15000,  // use aggressive hedge in final 15s if lopsided
  maxEntryPrice: 0.60,       // max bid price for initial entries
  maxHedgePrice: 0.65,       // max price for aggressive hedge
  minPairEdge: 0.02,         // min profit per pair for hedge
  minVolSamples: 10,         // min CL samples for vol estimation
  tightenSpread: 0.01,       // tighter spread when hedging (fair - 0.01)
};

let upCost = 0;
let downCost = 0;
let upTokens = 0;
let downTokens = 0;
let lastQuoteMs = 0;
let lastFairUp = null;
let clHistory = [];
let clOpen = null;
let quotedUp = false;
let quotedDown = false;

export function onWindowOpen(state) {
  upCost = 0;
  downCost = 0;
  upTokens = 0;
  downTokens = 0;
  lastQuoteMs = 0;
  lastFairUp = null;
  clHistory = [];
  clOpen = state.window?.oraclePriceAtOpen || null;
  quotedUp = false;
  quotedDown = false;

  // Reset orderbook if available
  if (state._orderbook) {
    state._orderbook.reset();
  }
}

export function evaluate(state, config) {
  const {
    halfSpread = defaults.halfSpread,
    minEdge = defaults.minEdge,
    maxPerSide = defaults.maxPerSide,
    capitalPerEntry = defaults.capitalPerEntry,
    requoteThreshold = defaults.requoteThreshold,
    cooldownMs = defaults.cooldownMs,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    aggressiveHedgeMs = defaults.aggressiveHedgeMs,
    maxEntryPrice = defaults.maxEntryPrice,
    maxHedgePrice = defaults.maxHedgePrice,
    minPairEdge = defaults.minPairEdge,
    minVolSamples = defaults.minVolSamples,
    tightenSpread = defaults.tightenSpread,
  } = config;

  const { chainlink, clobUp, clobDown, polyRef, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];

  // Track CL for vol estimation
  if (chainlink?.price) {
    const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    clHistory.push({ price: chainlink.price, ms });
  }

  if (win.timeToCloseMs == null) return [];
  if (!polyRef?.price) return [];

  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const sym = win.symbol;
  const signals = [];

  // ─── PHASE 3: Cancel all at exit window ───
  if (win.timeToCloseMs <= exitWindowMs) {
    if (quotedUp || quotedDown) {
      signals.push({ action: 'cancel_all' });
      quotedUp = false;
      quotedDown = false;
    }

    // Aggressive hedge in final seconds if lopsided
    if (win.timeToCloseMs <= aggressiveHedgeMs && win.timeToCloseMs > 5000) {
      if (upTokens > downTokens && downCost < maxPerSide) {
        const avgUpPrice = upCost / upTokens;
        const maxDownPrice = 1.00 - avgUpPrice - minPairEdge;
        const askDown = clobDown.bestAsk;
        if (askDown > 0.01 && askDown < maxDownPrice && askDown <= maxHedgePrice) {
          signals.push({
            action: 'buy',
            token: `${sym}-down`,
            capitalPerTrade: capitalPerEntry,
            reason: `aggressive_hedge: DOWN, avgUp=${avgUpPrice.toFixed(3)}, ask=${askDown.toFixed(3)}`,
          });
          downCost += capitalPerEntry;
          downTokens += capitalPerEntry / askDown;
        }
      }
      if (downTokens > upTokens && upCost < maxPerSide) {
        const avgDownPrice = downCost / downTokens;
        const maxUpPrice = 1.00 - avgDownPrice - minPairEdge;
        const askUp = clobUp.bestAsk;
        if (askUp > 0.01 && askUp < maxUpPrice && askUp <= maxHedgePrice) {
          signals.push({
            action: 'buy',
            token: `${sym}-up`,
            capitalPerTrade: capitalPerEntry,
            reason: `aggressive_hedge: UP, avgDn=${avgDownPrice.toFixed(3)}, ask=${askUp.toFixed(3)}`,
          });
          upCost += capitalPerEntry;
          upTokens += capitalPerEntry / askUp;
        }
      }
    }

    return signals;
  }

  // ─── Too early or not enough data ───
  if (win.timeToCloseMs >= entryWindowMs) return [];

  if (!clOpen && state.oraclePriceAtOpen) clOpen = state.oraclePriceAtOpen;
  const K = clOpen || (clHistory.length > 0 ? clHistory[0].price : null);
  if (!K) return [];
  if (clHistory.length < minVolSamples) return [];

  // Compute BS fair value
  const bsFair = computeBSFair(polyRef.price, K, clHistory, win.timeToCloseMs);
  if (bsFair == null) return [];

  const fairUp = bsFair;
  const fairDown = 1 - bsFair;

  // ─── Requote check: cancel and replace if fair moved significantly ───
  const fairMoved = lastFairUp != null && Math.abs(fairUp - lastFairUp) >= requoteThreshold;

  if (fairMoved && (quotedUp || quotedDown)) {
    signals.push({ action: 'cancel_all' });
    quotedUp = false;
    quotedDown = false;
  }

  // ─── PHASE 1: Post passive bids ───
  if (nowMs - lastQuoteMs >= cooldownMs) {
    // Determine spread: tighter if we need to hedge
    const upSpread = (downTokens > upTokens) ? tightenSpread : halfSpread;
    const downSpread = (upTokens > downTokens) ? tightenSpread : halfSpread;

    const bidUp = fairUp - upSpread;
    const bidDown = fairDown - downSpread;

    // Post UP bid
    if (!quotedUp && bidUp > minEdge && bidUp <= maxEntryPrice && upCost < maxPerSide) {
      const size = capitalPerEntry / bidUp;
      signals.push({
        action: 'place_limit_buy',
        token: `${sym}-up`,
        price: bidUp,
        size,
        capitalPerTrade: capitalPerEntry,
        reason: `passive_bid: UP, fair=${fairUp.toFixed(3)}, bid=${bidUp.toFixed(3)}, spread=${upSpread.toFixed(3)}`,
      });
      quotedUp = true;
    }

    // Post DOWN bid
    if (!quotedDown && bidDown > minEdge && bidDown <= maxEntryPrice && downCost < maxPerSide) {
      const size = capitalPerEntry / bidDown;
      signals.push({
        action: 'place_limit_buy',
        token: `${sym}-down`,
        price: bidDown,
        size,
        capitalPerTrade: capitalPerEntry,
        reason: `passive_bid: DOWN, fair=${fairDown.toFixed(3)}, bid=${bidDown.toFixed(3)}, spread=${downSpread.toFixed(3)}`,
      });
      quotedDown = true;
    }

    if (signals.length > 0) {
      lastQuoteMs = nowMs;
      lastFairUp = fairUp;
    }
  }

  return signals;
}

/**
 * Called by engine when a passive fill occurs.
 * Updates internal position tracking.
 */
export function onPassiveFill(fill) {
  if (fill.token.includes('up')) {
    upCost += fill.price * fill.size;
    upTokens += fill.size;
    quotedUp = false; // order filled, need to re-quote
  } else {
    downCost += fill.price * fill.size;
    downTokens += fill.size;
    quotedDown = false;
  }
}

function computeBSFair(S, K, history, timeToCloseMs) {
  let sumSqReturns = 0, returnCount = 0;
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].ms - history[i - 1].ms) / 1000;
    if (dt <= 0 || dt > 30) continue;
    const logReturn = Math.log(history[i].price / history[i - 1].price);
    sumSqReturns += logReturn * logReturn;
    returnCount++;
  }
  if (returnCount < 5) return null;

  const avgTimeStepSec = (history[history.length - 1].ms - history[0].ms) / 1000 / returnCount;
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
