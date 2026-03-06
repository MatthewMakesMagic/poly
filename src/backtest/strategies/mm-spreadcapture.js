/**
 * Pure Spread Capture MM
 *
 * Simplest possible MM strategy. No BS computation, no directional view.
 * ONLY buys when askUp + askDown < 1.00 - minEdge.
 * Always buys both sides simultaneously with equal capital.
 * Guaranteed profit per pair = 1.00 - (askUp + askDown).
 */

export const name = 'mm-spreadcapture';
export const description = 'Pure spread capture: buy both sides only when combined ask < 1.00 - minEdge.';

export const defaults = {
  minEdge: 0.02,
  maxPerSide: 10,
  capitalPerEntry: 2,
  cooldownMs: 10000,
  entryWindowMs: 300000,
  exitWindowMs: 5000,
  maxEntryPrice: 0.65,
  windowDurationMs: 900000,
  spreadBuffer: 0,
};

export const sweepGrid = {
  minEdge: [0.005, 0.01, 0.02, 0.03, 0.05],
  maxPerSide: [6, 10, 20],
  cooldownMs: [5000, 10000, 15000],
  capitalPerEntry: [2],
  maxEntryPrice: [0.55, 0.65, 0.75],
};

let upCost = 0;
let downCost = 0;
let lastBuyMs = 0;

export function onWindowOpen() {
  upCost = 0;
  downCost = 0;
  lastBuyMs = 0;
}

export function evaluate(state, config) {
  const {
    minEdge = defaults.minEdge,
    maxPerSide = defaults.maxPerSide,
    capitalPerEntry = defaults.capitalPerEntry,
    cooldownMs = defaults.cooldownMs,
    entryWindowMs = defaults.entryWindowMs,
    exitWindowMs = defaults.exitWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
  } = config;

  const { clobUp, clobDown, window: win } = state;
  if (!win || !clobUp || !clobDown) return [];
  if (win.timeToCloseMs == null) return [];
  if (win.timeToCloseMs >= entryWindowMs || win.timeToCloseMs <= exitWindowMs) return [];

  const askUp = clobUp.bestAsk;
  const askDown = clobDown.bestAsk;
  if (!askUp || !askDown || askUp <= 0.01 || askDown <= 0.01) return [];

  const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
  if (nowMs - lastBuyMs < cooldownMs) return [];

  // Both sides must be affordable
  if (askUp > maxEntryPrice || askDown > maxEntryPrice) return [];
  if (upCost >= maxPerSide || downCost >= maxPerSide) return [];

  // Combined cost must leave guaranteed profit
  const combinedAsk = askUp + askDown;
  if (combinedAsk >= 1.00 - minEdge) return [];

  const sym = win.symbol;
  const spread = (1.00 - combinedAsk).toFixed(3);

  lastBuyMs = nowMs;
  upCost += capitalPerEntry;
  downCost += capitalPerEntry;

  return [
    {
      action: 'buy',
      token: `${sym}-up`,
      capitalPerTrade: capitalPerEntry,
      reason: `spread_capture: UP, askUp=${askUp.toFixed(3)}, askDn=${askDown.toFixed(3)}, spread=${spread}`,
    },
    {
      action: 'buy',
      token: `${sym}-down`,
      capitalPerTrade: capitalPerEntry,
      reason: `spread_capture: DOWN, askUp=${askUp.toFixed(3)}, askDn=${askDown.toFixed(3)}, spread=${spread}`,
    },
  ];
}
