/**
 * Passive Market Maker: CLOB-Anchored with Limit Orders
 *
 * True market-making strategy using passive limit orders at CLOB-derived prices.
 * Posts resting bids at the current best bid on both UP and DOWN sides.
 * When both fill, combined cost < $1.00 → guaranteed profit at resolution.
 *
 * Core logic:
 *   1. Read CLOB best bid on UP and DOWN sides
 *   2. Check pair edge: bestBidUp + bestBidDown < pairThreshold
 *   3. Post bids at bestBid (or bestBid - offset) on both sides
 *   4. Fills happen passively when L2 asks cross down to our level
 *   5. Cancel at T-30s, aggressive hedge if one-sided
 *
 * Edge source: spread capture on both sides of a binary pair.
 * Combined cost < $1.00 → profit = 1.00 - (upCost + downCost)
 *
 * Signal types:
 *   - place_limit_buy: post resting bids
 *   - cancel_all: clear stale quotes on requote
 *   - buy (aggressive): fallback for late-window hedge if lopsided
 *
 * Requires L2 orderbook data for fill simulation.
 */

export const name = 'mm-passive-polyref';
export const description = 'Passive MM using CLOB-anchored limit orders. Bids at bestBid on both sides, earns pair edge.';
export const usesPassiveOrders = true;

export const defaults = {
  queuePositionFraction: 0.75, // pessimistic: assume near back of queue (0=front, 1=back)
  bidOffset: 0.00,             // offset below bestBid (0 = at bestBid, 0.01 = penny below)
  pairThreshold: 0.995,        // max combined bid cost (bidUp + bidDown < this)
  maxPerSide: 10,              // max capital per side
  capitalPerEntry: 2,          // capital per limit order
  minRequoteIntervalMs: 500,   // anti-storm: min ms between cancel/replace cycles
  entryWindowMs: 840000,       // enter within first minute of 15-min window (14 min entry window)
  exitWindowMs: 30000,         // cancel all at T-30s
  aggressiveHedgeMs: 15000,    // aggressive hedge in final 15s
  maxEntryPrice: 0.65,         // max bid price for any side
  minEntryPrice: 0.03,         // min bid price (skip near-zero)
  maxHedgePrice: 0.70,         // max aggressive hedge price
  minPairEdge: 0.02,           // min profit per pair for hedge calc
  requoteThreshold: 0.005,     // requote when CLOB bestBid moves this much from our resting order
};

/**
 * Initialize per-window strategy state on the MarketState object.
 * This avoids module-level variables which break parallel execution.
 */
function initMmState(state) {
  if (!state._mm) {
    state._mm = {
      upCost: 0,
      downCost: 0,
      upTokens: 0,
      downTokens: 0,
      lastQuoteMs: 0,
      lastBidUp: null,
      lastBidDown: null,
      quotedUp: false,
      quotedDown: false,
    };
  }
  return state._mm;
}

export function onWindowOpen(state) {
  state._mm = null;
  initMmState(state);

  if (state._orderbook) {
    state._orderbook.reset();
  }
}

export function evaluate(state, config) {
  const {
    bidOffset = defaults.bidOffset,
    pairThreshold = defaults.pairThreshold,
    maxPerSide = defaults.maxPerSide,
    capitalPerEntry = defaults.capitalPerEntry,
    minRequoteIntervalMs = defaults.minRequoteIntervalMs,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    aggressiveHedgeMs = defaults.aggressiveHedgeMs,
    maxEntryPrice = defaults.maxEntryPrice,
    minEntryPrice = defaults.minEntryPrice,
    maxHedgePrice = defaults.maxHedgePrice,
    minPairEdge = defaults.minPairEdge,
    requoteThreshold = defaults.requoteThreshold,
  } = config;

  const { clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null) return [];

  const mm = initMmState(state);
  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  const sym = win.symbol;
  const signals = [];

  // ─── PHASE 3: Exit window — cancel and aggressive hedge ───
  if (win.timeToCloseMs <= exitWindowMs) {
    if (mm.quotedUp || mm.quotedDown) {
      signals.push({ action: 'cancel_all' });
      mm.quotedUp = false;
      mm.quotedDown = false;
    }

    if (win.timeToCloseMs <= aggressiveHedgeMs && win.timeToCloseMs > 5000) {
      // Hedge lopsided position
      if (mm.upTokens > 0 && mm.downTokens === 0 && mm.downCost < maxPerSide) {
        const avgUpPrice = mm.upCost / mm.upTokens;
        const maxDownPrice = 1.00 - avgUpPrice - minPairEdge;
        const askDown = clobDown.bestAsk;
        if (askDown > 0.01 && askDown < maxDownPrice && askDown <= maxHedgePrice) {
          signals.push({
            action: 'buy',
            token: `${sym}-down`,
            capitalPerTrade: capitalPerEntry,
            reason: `aggressive_hedge: DOWN, avgUp=${avgUpPrice.toFixed(3)}, ask=${askDown.toFixed(3)}`,
          });
          mm.downCost += capitalPerEntry;
          mm.downTokens += capitalPerEntry / askDown;
        }
      }
      if (mm.downTokens > 0 && mm.upTokens === 0 && mm.upCost < maxPerSide) {
        const avgDownPrice = mm.downCost / mm.downTokens;
        const maxUpPrice = 1.00 - avgDownPrice - minPairEdge;
        const askUp = clobUp.bestAsk;
        if (askUp > 0.01 && askUp < maxUpPrice && askUp <= maxHedgePrice) {
          signals.push({
            action: 'buy',
            token: `${sym}-up`,
            capitalPerTrade: capitalPerEntry,
            reason: `aggressive_hedge: UP, avgDn=${avgDownPrice.toFixed(3)}, ask=${askUp.toFixed(3)}`,
          });
          mm.upCost += capitalPerEntry;
          mm.upTokens += capitalPerEntry / askUp;
        }
      }
    }

    return signals;
  }

  // ─── Too early ───
  if (win.timeToCloseMs >= entryWindowMs) return [];

  // Use L2 levels for pricing when available (more accurate than CLOB snapshots)
  const l2BidsUp = clobUp.levels?.bids;
  const l2BidsDown = clobDown.levels?.bids;
  const l2AsksUp = clobUp.levels?.asks;
  const l2AsksDown = clobDown.levels?.asks;
  const clobBidUp = (l2BidsUp?.length > 0 ? l2BidsUp[0][0] : null) || clobUp.bestBid;
  const clobBidDown = (l2BidsDown?.length > 0 ? l2BidsDown[0][0] : null) || clobDown.bestBid;
  const clobAskUp = (l2AsksUp?.length > 0 ? l2AsksUp[0][0] : null) || clobUp.bestAsk;
  const clobAskDown = (l2AsksDown?.length > 0 ? l2AsksDown[0][0] : null) || clobDown.bestAsk;
  if (!clobBidUp || !clobBidDown || clobBidUp <= 0 || clobBidDown <= 0) return [];

  // ─── Compute desired bid prices from current CLOB ───
  let bidUp = clobBidUp - bidOffset;
  let bidDown = clobBidDown - bidOffset;

  // Inventory skew: tighten the side we need to match
  if (mm.upTokens > 0 && mm.downTokens === 0) {
    bidDown = clobBidDown; // no offset for the needed side
  } else if (mm.downTokens > 0 && mm.upTokens === 0) {
    bidUp = clobBidUp;
  }

  // ─── Tick-driven requote: cancel stale orders if fair value moved ───
  const hasOrders = mm.quotedUp || mm.quotedDown;
  const bidMovedUp = mm.lastBidUp != null && Math.abs(bidUp - mm.lastBidUp) >= requoteThreshold;
  const bidMovedDown = mm.lastBidDown != null && Math.abs(bidDown - mm.lastBidDown) >= requoteThreshold;
  const needsRequote = hasOrders && (bidMovedUp || bidMovedDown);

  if (needsRequote && (nowMs - mm.lastQuoteMs >= minRequoteIntervalMs)) {
    signals.push({ action: 'cancel_all' });
    mm.quotedUp = false;
    mm.quotedDown = false;
  }

  // ─── Place quotes if not currently in market ───
  if (!mm.quotedUp && !mm.quotedDown) {
    // Check pair edge
    const pairCost = bidUp + bidDown;
    if (pairCost >= pairThreshold) return signals; // not enough edge

    // Validate price ranges
    const upValid = bidUp >= minEntryPrice && bidUp <= maxEntryPrice && mm.upCost < maxPerSide;
    const downValid = bidDown >= minEntryPrice && bidDown <= maxEntryPrice && mm.downCost < maxPerSide;

    if (upValid) {
      const size = capitalPerEntry / bidUp;
      signals.push({
        action: 'place_limit_buy',
        token: `${sym}-up`,
        price: bidUp,
        size,
        capitalPerTrade: capitalPerEntry,
        reason: `passive_bid: UP, bid=${bidUp.toFixed(3)}, ask=${clobAskUp?.toFixed(3) || '?'}, pairCost=${pairCost.toFixed(3)}`,
      });
      mm.quotedUp = true;
    }

    if (downValid) {
      const size = capitalPerEntry / bidDown;
      signals.push({
        action: 'place_limit_buy',
        token: `${sym}-down`,
        price: bidDown,
        size,
        capitalPerTrade: capitalPerEntry,
        reason: `passive_bid: DOWN, bid=${bidDown.toFixed(3)}, ask=${clobAskDown?.toFixed(3) || '?'}, pairCost=${pairCost.toFixed(3)}`,
      });
      mm.quotedDown = true;
    }

    if (mm.quotedUp || mm.quotedDown) {
      mm.lastQuoteMs = nowMs;
      mm.lastBidUp = bidUp;
      mm.lastBidDown = bidDown;
    }
  }

  return signals;
}

export const LIVE_DEFAULTS = {
  ...defaults,
  entryWindowMs: 840000,       // 14 min — nearly full window for MM rebalancing
  minEntryPrice: 0.20,  // up from 0.03 — avoid illiquid OTM range
  maxEntryPrice: 0.55,  // tighter — avoid overpaying (down from 0.65)
};

/**
 * Declarative desired-state quoting for live engine v2.
 * Returns the quotes we WANT resting — reconciler diffs vs actual.
 * No signals, no booleans, no cancel logic. Pure function of state.
 *
 * @param {Object} state - MarketState
 * @param {Object} config - Strategy config
 * @returns {{ up: { price, size, capital } | null, down: { price, size, capital } | null }}
 */
export function getDesiredQuotes(state, config) {
  const {
    bidOffset = defaults.bidOffset,
    pairThreshold = defaults.pairThreshold,
    maxPerSide = defaults.maxPerSide,
    capitalPerEntry = defaults.capitalPerEntry,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    minEntryPrice = defaults.minEntryPrice,
    requoteThreshold = defaults.requoteThreshold,
  } = config;

  const { clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return { up: null, down: null };
  if (win.timeToCloseMs == null) return { up: null, down: null };

  // Exit window — no resting quotes wanted
  if (win.timeToCloseMs <= exitWindowMs) return { up: null, down: null };

  // Too early — not in entry window
  if (win.timeToCloseMs >= entryWindowMs) return { up: null, down: null };

  const mm = initMmState(state);

  // L2 levels for pricing
  const l2BidsUp = clobUp.levels?.bids;
  const l2BidsDown = clobDown.levels?.bids;
  const clobBidUp = (l2BidsUp?.length > 0 ? l2BidsUp[0][0] : null) || clobUp.bestBid;
  const clobBidDown = (l2BidsDown?.length > 0 ? l2BidsDown[0][0] : null) || clobDown.bestBid;
  if (!clobBidUp || !clobBidDown || clobBidUp <= 0 || clobBidDown <= 0) return { up: null, down: null };

  // Desired bid prices
  let bidUp = clobBidUp - bidOffset;
  let bidDown = clobBidDown - bidOffset;

  // Inventory skew: tighten the side we need
  if (mm.upTokens > 0 && mm.downTokens === 0) {
    bidDown = clobBidDown;
  } else if (mm.downTokens > 0 && mm.upTokens === 0) {
    bidUp = clobBidUp;
  }

  // Pair edge check
  const pairCost = bidUp + bidDown;
  if (pairCost >= pairThreshold) return { up: null, down: null };

  // Build desired quotes per side (independently)
  let up = null;
  let down = null;

  if (bidUp >= minEntryPrice && bidUp <= maxEntryPrice && mm.upCost < maxPerSide) {
    up = { price: bidUp, size: capitalPerEntry / bidUp, capital: capitalPerEntry };
  }
  if (bidDown >= minEntryPrice && bidDown <= maxEntryPrice && mm.downCost < maxPerSide) {
    down = { price: bidDown, size: capitalPerEntry / bidDown, capital: capitalPerEntry };
  }

  return { up, down };
}

/**
 * Called by engine when a passive fill occurs.
 * Updates per-window position tracking on state._mm.
 */
export function onPassiveFill(fill, state) {
  const mm = initMmState(state);
  if (fill.token.includes('up')) {
    mm.upCost += fill.price * fill.size;
    mm.upTokens += fill.size;
    mm.quotedUp = false;
  } else {
    mm.downCost += fill.price * fill.size;
    mm.downTokens += fill.size;
    mm.quotedDown = false;
  }
}
