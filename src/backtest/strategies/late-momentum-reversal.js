/**
 * Late-Window Momentum Reversal Strategy (Contrarian)
 *
 * Fades sharp moves in the final 60-90 seconds of the window.
 * Theory: Late-window momentum often overshoots when MMs panic-reprice.
 * The VWAP-based oracle (Chainlink) is slower to move, so sharp CLOB moves
 * near close are often wrong.
 *
 * Measures momentum as rate-of-change in CLOB mid price over a lookback period.
 * When momentum exceeds threshold, buys the opposite token.
 *
 * Strategy interface: { name, evaluate, onWindowOpen }
 */

export const name = 'late-momentum-reversal';

export const defaults = {
  momentumThreshold: 0.08,   // Min CLOB price change to trigger fade (e.g. UP drops 0.08 in lookback)
  lookbackMs: 15000,          // Lookback period for momentum calculation (15s)
  entryWindowMs: 60000,       // Only enter in last 60s
  maxEntryPrice: 0.75,        // Max price for the counter-token
  positionSize: 1,
  fadeDirection: 'both',      // 'up_fade' (fade UP momentum), 'down_fade', or 'both'
};

export const sweepGrid = {
  momentumThreshold: [0.05, 0.08, 0.10, 0.15, 0.20],
  lookbackMs: [10000, 15000, 20000, 30000],
  entryWindowMs: [30000, 45000, 60000, 90000],
  maxEntryPrice: [0.65, 0.70, 0.75],
};

// Track CLOB history for momentum calculation
let upHistory = [];   // [{ts, mid}]
let downHistory = []; // [{ts, mid}]
let hasFadedUp = false;
let hasFadedDown = false;

export function onWindowOpen(state, config) {
  upHistory = [];
  downHistory = [];
  hasFadedUp = false;
  hasFadedDown = false;
}

export function evaluate(state, config) {
  const {
    momentumThreshold = defaults.momentumThreshold,
    lookbackMs = defaults.lookbackMs,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    positionSize = defaults.positionSize,
    fadeDirection = defaults.fadeDirection,
  } = config;

  const { clobUp, clobDown, window: win } = state;
  if (!win) return [];

  const now = state.timestamp ? new Date(state.timestamp).getTime() : 0;

  // Record CLOB prices
  if (clobUp?.mid) {
    upHistory.push({ ts: now, mid: clobUp.mid });
  }
  if (clobDown?.mid) {
    downHistory.push({ ts: now, mid: clobDown.mid });
  }

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  const signals = [];
  const cutoff = now - lookbackMs;

  // Calculate UP momentum (positive = UP price increasing)
  if ((fadeDirection === 'both' || fadeDirection === 'up_fade') && !hasFadedUp && clobDown) {
    const pastUp = upHistory.find(h => h.ts >= cutoff);
    if (pastUp && clobUp?.mid) {
      const momentum = clobUp.mid - pastUp.mid; // positive = UP price surging

      // Fade UP surge: if UP price surged, buy DOWN (bet it reverses)
      if (momentum > momentumThreshold && clobDown.bestAsk <= maxEntryPrice) {
        hasFadedUp = true;
        signals.push({
          action: 'buy',
          token: `${win.symbol}-down`,
          size: positionSize,
          reason: `late_reversal: fade UP surge=${momentum.toFixed(3)} over ${lookbackMs}ms`,
          confidence: Math.min(momentum / 0.20, 1),
        });
      }
    }
  }

  // Calculate DOWN momentum (positive = DOWN price increasing)
  if ((fadeDirection === 'both' || fadeDirection === 'down_fade') && !hasFadedDown && clobUp) {
    const pastDown = downHistory.find(h => h.ts >= cutoff);
    if (pastDown && clobDown?.mid) {
      const momentum = clobDown.mid - pastDown.mid; // positive = DOWN price surging

      // Fade DOWN surge: if DOWN price surged, buy UP (bet it reverses)
      if (momentum > momentumThreshold && clobUp.bestAsk <= maxEntryPrice) {
        hasFadedDown = true;
        signals.push({
          action: 'buy',
          token: `${win.symbol}-up`,
          size: positionSize,
          reason: `late_reversal: fade DOWN surge=${momentum.toFixed(3)} over ${lookbackMs}ms`,
          confidence: Math.min(momentum / 0.20, 1),
        });
      }
    }
  }

  return signals;
}
