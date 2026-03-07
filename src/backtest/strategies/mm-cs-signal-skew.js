/**
 * Continuous MM: Exchange Signal Skew
 *
 * Two-sided passive quoting with directional skew driven by exchange signal.
 * When the 5-exchange median implies UP (median > strike + structuralGap),
 * we bid more aggressively on UP (closer to bestBid) and less aggressively
 * on DOWN (further from bestBid). The opposite for DOWN bias.
 *
 * Exchange disagreement (range across exchanges) dampens the skew — when
 * exchanges disagree, we are less confident in the direction.
 *
 * CLOB book imbalance acts as confirmation: if bid-heavy on UP side,
 * that supports an UP skew and vice versa.
 *
 * Variations sweep skewPerDollar: how much each $1 of exchange signal
 * shifts the bid offset on each side.
 */

import {
  initMm,
  onWindowOpenBase,
  onPassiveFillBase,
  evaluateBase,
  getExchangeSignal,
  getExchangeDisagreement,
  getBookImbalance,
} from './mm-continuous-base.js';

export const name = 'mm-cs-signal-skew';
export const description = 'Two-sided passive MM with exchange-signal directional skew and disagreement dampening';
export const usesPassiveOrders = true;

export const defaults = {
  entryWindowMs: 840000,
  exitWindowMs: 30000,
  maxEntryPrice: 0.55,
  minEntryPrice: 0.03,
  capitalPerEntry: 2,
  maxPerSide: 20,
  requoteThreshold: 0.005,
  structuralGap: 46,
  baseOffset: 0.01,           // base offset below bestBid (before skew)
  skewPerDollar: 0.002,       // offset adjustment per $1 of exchange signal
  disagreementDampen: 0.01,   // skew multiplier reduction per $1 of exchange disagreement
  imbalanceWeight: 0.3,       // how much book imbalance contributes to skew (0-1)
};

export const variations = [
  { skewPerDollar: 0.0005 },
  { skewPerDollar: 0.001 },
  { skewPerDollar: 0.002 },
  { skewPerDollar: 0.003 },
  { skewPerDollar: 0.005 },
];

function computeDesiredQuotes(state, config, mm) {
  const { clobUp, clobDown } = state;
  const { baseOffset, skewPerDollar, structuralGap, disagreementDampen, imbalanceWeight } = config;

  const upBid = clobUp?.bestBid;
  const downBid = clobDown?.bestBid;
  if (!upBid || !downBid || upBid <= 0 || downBid <= 0) return { up: null, down: null };

  // Exchange directional signal: positive = UP bias
  const signal = getExchangeSignal(state, structuralGap);
  if (signal == null) {
    // No exchange data — fall back to symmetric bidding
    return {
      up: { price: Math.round((upBid - baseOffset) * 1000) / 1000, reason: 'skew: no signal, symmetric' },
      down: { price: Math.round((downBid - baseOffset) * 1000) / 1000, reason: 'skew: no signal, symmetric' },
    };
  }

  // Exchange disagreement dampens confidence
  const disagreement = getExchangeDisagreement(state);
  const dampenFactor = Math.max(0, 1 - disagreement * disagreementDampen);

  // Book imbalance confirmation (UP book)
  // imbalance > 0.5 = buying pressure on UP → supports UP signal
  const upImbalance = getBookImbalance(clobUp);
  const downImbalance = getBookImbalance(clobDown);
  // Combine: if UP book is bid-heavy and signal is positive, that's confirming
  const imbalanceBias = (upImbalance - 0.5) - (downImbalance - 0.5); // positive = UP confirmation

  // Effective skew: exchange signal + imbalance confirmation, dampened by disagreement
  const rawSkew = signal * skewPerDollar;
  const imbalanceContrib = imbalanceBias * imbalanceWeight * baseOffset;
  const skew = (rawSkew + imbalanceContrib) * dampenFactor;

  // Positive skew = UP bias: reduce UP offset (more aggressive), increase DOWN offset
  const upOffset = baseOffset - skew;   // smaller offset = closer to bestBid = more aggressive
  const downOffset = baseOffset + skew; // larger offset = further from bestBid = less aggressive

  const bidUp = upBid - Math.max(0, upOffset);
  const bidDown = downBid - Math.max(0, downOffset);

  return {
    up: {
      price: Math.round(bidUp * 1000) / 1000,
      reason: `skew: UP sig=${signal.toFixed(0)} skew=${skew.toFixed(4)} damp=${dampenFactor.toFixed(2)} off=${upOffset.toFixed(3)}`,
    },
    down: {
      price: Math.round(bidDown * 1000) / 1000,
      reason: `skew: DOWN sig=${signal.toFixed(0)} skew=${skew.toFixed(4)} damp=${dampenFactor.toFixed(2)} off=${downOffset.toFixed(3)}`,
    },
  };
}

export function evaluate(state, config) {
  const merged = { ...defaults, ...config };
  return evaluateBase(state, merged, computeDesiredQuotes);
}

export function onWindowOpen(state) {
  onWindowOpenBase(state);
}

export function onPassiveFill(fill, state) {
  onPassiveFillBase(fill, state);
}

/**
 * Live/paper trading interface — returns desired quotes for reconciler.
 * Same logic as computeDesiredQuotes but adds size/capital fields and
 * handles window timing inline (since evaluateBase isn't used here).
 */
export function getDesiredQuotes(state, config) {
  const c = { ...defaults, ...config };
  const { clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return { up: null, down: null };
  if (win.timeToCloseMs == null) return { up: null, down: null };
  if (win.timeToCloseMs <= c.exitWindowMs) return { up: null, down: null };
  if (win.timeToCloseMs >= c.entryWindowMs) return { up: null, down: null };

  const mm = initMm(state);
  const desired = computeDesiredQuotes(state, c, mm);

  // Add size + capital for reconciler, check inventory + price bounds
  for (const side of ['up', 'down']) {
    if (!desired[side]) continue;
    const inv = side === 'up' ? mm.upInv : mm.downInv;
    if (inv.cost >= c.maxPerSide) { desired[side] = null; continue; }
    if (desired[side].price < c.minEntryPrice || desired[side].price > c.maxEntryPrice) { desired[side] = null; continue; }
    desired[side].size = c.capitalPerEntry / desired[side].price;
    desired[side].capital = c.capitalPerEntry;
  }
  return desired;
}
