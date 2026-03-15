/**
 * Signal: Black-Scholes Fair Value
 *
 * Computes BS fair value for UP token using polyRef as spot, oracle price at open
 * as strike, and realized volatility from chainlink history. Signals direction
 * when CLOB price deviates from fair value.
 *
 * Reads: state.polyRef, state.chainlink, state.clobUp, state.clobDown,
 *        state.oraclePriceAtOpen, state.strike, state.window
 * Covers: FR6 (signal building block library)
 */

export const name = 'bs-fair-value';

export const description =
  'Computes Black-Scholes fair value from polyRef/CL volatility. ' +
  'Signals when CLOB price is cheap relative to theoretical fair value.';

export const paramSchema = {
  minEdge: { type: 'number', default: 0.02, description: 'Minimum edge (fair - ask) to trigger signal' },
  minVolSamples: { type: 'number', default: 10, description: 'Minimum CL data points for vol estimation' },
};

// Per-instance state for CL history tracking
let clHistory = [];

/**
 * @param {Object} params
 * @returns {{ evaluate: Function, reset: Function }}
 */
export function create(params = {}) {
  const defaultMinEdge = params.minEdge ?? paramSchema.minEdge.default;
  const defaultMinVolSamples = params.minVolSamples ?? paramSchema.minVolSamples.default;
  let clHistory = [];

  function evaluate(state, config = {}) {
    const minEdge = config.minEdge ?? defaultMinEdge;
    const minVolSamples = config.minVolSamples ?? defaultMinVolSamples;

    if (!state.polyRef?.price) {
      return { direction: null, strength: 0, reason: 'bs-fair-value: no polyRef price' };
    }
    if (!state.window?.timeToCloseMs) {
      return { direction: null, strength: 0, reason: 'bs-fair-value: no window timing data' };
    }
    if (!state.clobUp && !state.clobDown) {
      return { direction: null, strength: 0, reason: 'bs-fair-value: no CLOB data' };
    }

    // Track CL history for vol estimation
    if (state.chainlink?.price) {
      const ms = state.timestamp ? new Date(state.timestamp).getTime() : 0;
      clHistory.push({ price: state.chainlink.price, ms });
    }

    if (clHistory.length < minVolSamples) {
      return { direction: null, strength: 0, reason: `bs-fair-value: insufficient vol data (${clHistory.length}/${minVolSamples})` };
    }

    const K = state.oraclePriceAtOpen ?? state.strike;
    if (K == null) {
      return { direction: null, strength: 0, reason: 'bs-fair-value: no strike reference' };
    }

    const fairUp = computeBSFair(state.polyRef.price, K, clHistory, state.window.timeToCloseMs);
    if (fairUp == null) {
      return { direction: null, strength: 0, reason: 'bs-fair-value: could not compute fair value' };
    }

    const fairDown = 1 - fairUp;

    // Check UP side
    if (state.clobUp?.bestAsk != null) {
      const edgeUp = fairUp - state.clobUp.bestAsk;
      if (edgeUp > minEdge) {
        return {
          direction: 'UP',
          strength: Math.min(edgeUp / (minEdge * 3), 1),
          reason: `bs-fair-value: UP edge=${edgeUp.toFixed(3)}, fair=${fairUp.toFixed(3)}, ask=${state.clobUp.bestAsk.toFixed(3)}`,
        };
      }
    }

    // Check DOWN side
    if (state.clobDown?.bestAsk != null) {
      const edgeDown = fairDown - state.clobDown.bestAsk;
      if (edgeDown > minEdge) {
        return {
          direction: 'DOWN',
          strength: Math.min(edgeDown / (minEdge * 3), 1),
          reason: `bs-fair-value: DOWN edge=${edgeDown.toFixed(3)}, fair=${fairDown.toFixed(3)}, ask=${state.clobDown.bestAsk.toFixed(3)}`,
        };
      }
    }

    return { direction: null, strength: 0, reason: 'bs-fair-value: no edge detected' };
  }

  function reset() {
    clHistory = [];
  }

  return { evaluate, reset };
}

/**
 * Compute BS fair value (probability of finishing above strike).
 */
function computeBSFair(S, K, history, timeToCloseMs) {
  let sumSqReturns = 0;
  let returnCount = 0;
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
  const p =
    d *
    Math.exp((-x * x) / 2) *
    (t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
  return x > 0 ? 1 - p : p;
}
