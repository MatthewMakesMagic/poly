/**
 * CLOB Reversal Strategy (Contrarian)
 *
 * Buys when CLOB probability drops sharply from window peak.
 * Theory: Sharp drops in CLOB price often overshoot — MMs overreact to
 * short-term oracle moves, creating buying opportunities.
 *
 * Tracks peak CLOB UP price during the window, then buys UP when price
 * drops by dropThreshold from that peak. Conversely, tracks peak CLOB DOWN
 * price and buys DOWN when it drops from peak.
 *
 * Strategy interface: { name, evaluate, onWindowOpen, onWindowClose }
 */

export const name = 'clob-reversal';

export const defaults = {
  dropThreshold: 0.15,       // Min drop from peak to trigger (e.g. 0.15 = 15 cents)
  entryWindowMs: 180000,     // Only enter within last 3 min of window
  maxEntryPrice: 0.70,       // Max price willing to pay for token
  minPeakPrice: 0.55,        // Peak must have been at least this to count
  positionSize: 1,
  direction: 'both',         // 'up', 'down', or 'both'
};

export const sweepGrid = {
  dropThreshold: [0.10, 0.15, 0.20, 0.25, 0.30],
  entryWindowMs: [120000, 180000, 240000],
  maxEntryPrice: [0.60, 0.65, 0.70],
  minPeakPrice: [0.50, 0.55, 0.60],
};

// Per-window state
let peakUp = 0;
let peakDown = 0;
let hasBoughtUp = false;
let hasBoughtDown = false;

export function onWindowOpen(state, config) {
  peakUp = 0;
  peakDown = 0;
  hasBoughtUp = false;
  hasBoughtDown = false;
}

export function evaluate(state, config) {
  const {
    dropThreshold = defaults.dropThreshold,
    entryWindowMs = defaults.entryWindowMs,
    maxEntryPrice = defaults.maxEntryPrice,
    minPeakPrice = defaults.minPeakPrice,
    positionSize = defaults.positionSize,
    direction = defaults.direction,
  } = config;

  const { clobUp, clobDown, window: win } = state;
  if (!win) return [];

  const signals = [];

  // Track peaks
  if (clobUp?.mid > peakUp) peakUp = clobUp.mid;
  if (clobDown?.mid > peakDown) peakDown = clobDown.mid;

  const timeOk = win.timeToCloseMs != null && win.timeToCloseMs < entryWindowMs;
  if (!timeOk) return [];

  // Check UP reversal: peak was high, now dropped
  if ((direction === 'up' || direction === 'both') && !hasBoughtUp && clobUp) {
    const dropFromPeak = peakUp - clobUp.mid;
    if (peakUp >= minPeakPrice && dropFromPeak >= dropThreshold && clobUp.bestAsk <= maxEntryPrice) {
      hasBoughtUp = true;
      signals.push({
        action: 'buy',
        token: `${win.symbol}-up`,
        size: positionSize,
        reason: `clob_reversal_up: peak=${peakUp.toFixed(3)}, drop=${dropFromPeak.toFixed(3)}`,
        confidence: Math.min(dropFromPeak / 0.30, 1),
      });
    }
  }

  // Check DOWN reversal: peak was high, now dropped
  if ((direction === 'down' || direction === 'both') && !hasBoughtDown && clobDown) {
    const dropFromPeak = peakDown - clobDown.mid;
    if (peakDown >= minPeakPrice && dropFromPeak >= dropThreshold && clobDown.bestAsk <= maxEntryPrice) {
      hasBoughtDown = true;
      signals.push({
        action: 'buy',
        token: `${win.symbol}-down`,
        size: positionSize,
        reason: `clob_reversal_down: peak=${peakDown.toFixed(3)}, drop=${dropFromPeak.toFixed(3)}`,
        confidence: Math.min(dropFromPeak / 0.30, 1),
      });
    }
  }

  return signals;
}
