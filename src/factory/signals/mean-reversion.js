/**
 * Signal: Mean Reversion
 *
 * Signals when price has deviated significantly from a rolling mean,
 * expecting it to revert. Uses chainlink price history.
 *
 * Reads: state.chainlink
 * Covers: FR6 (signal building block library)
 */

export const name = 'mean-reversion';

export const description =
  'Signals when price deviates from rolling mean, expecting reversion. ' +
  'Signals DOWN when price is above mean (expect drop), UP when below.';

export const paramSchema = {
  lookback: { type: 'number', default: 20, description: 'Number of price observations for rolling mean' },
  deviationThreshold: { type: 'number', default: 30, description: 'Min deviation from mean in dollars to signal' },
};

/**
 * @param {Object} params
 * @returns {{ evaluate: Function, reset: Function }}
 */
export function create(params = {}) {
  const defaultLookback = params.lookback ?? paramSchema.lookback.default;
  const defaultDeviationThreshold = params.deviationThreshold ?? paramSchema.deviationThreshold.default;
  let priceBuffer = [];

  function evaluate(state, config = {}) {
    const lookback = config.lookback ?? defaultLookback;
    const deviationThreshold = config.deviationThreshold ?? defaultDeviationThreshold;

    if (!state.chainlink?.price) {
      return { direction: null, strength: 0, reason: 'mean-reversion: no chainlink price' };
    }

    priceBuffer.push(state.chainlink.price);
    if (priceBuffer.length > lookback) {
      priceBuffer = priceBuffer.slice(-lookback);
    }

    if (priceBuffer.length < lookback) {
      return { direction: null, strength: 0, reason: `mean-reversion: building buffer (${priceBuffer.length}/${lookback})` };
    }

    const mean = priceBuffer.reduce((s, p) => s + p, 0) / priceBuffer.length;
    const deviation = state.chainlink.price - mean;

    if (Math.abs(deviation) > deviationThreshold) {
      // Mean reversion: if above mean, expect drop → DOWN; below mean → UP
      const direction = deviation > 0 ? 'DOWN' : 'UP';
      const strength = Math.min(Math.abs(deviation) / (deviationThreshold * 3), 1);
      return {
        direction,
        strength,
        reason: `mean-reversion: price=$${state.chainlink.price.toFixed(0)}, mean=$${mean.toFixed(0)}, dev=$${deviation.toFixed(1)}`,
      };
    }

    return { direction: null, strength: 0, reason: `mean-reversion: deviation=$${deviation.toFixed(1)} below threshold` };
  }

  function reset() {
    priceBuffer = [];
  }

  return { evaluate, reset };
}
