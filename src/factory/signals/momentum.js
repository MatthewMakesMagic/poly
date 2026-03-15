/**
 * Signal: Momentum
 *
 * Tracks price movement direction over a lookback period using chainlink prices.
 * Signals UP when price is rising, DOWN when falling.
 *
 * Reads: state.chainlink, state.oraclePriceAtOpen, state.strike
 * Covers: FR6 (signal building block library)
 */

export const name = 'momentum';

export const description =
  'Signals direction based on recent price momentum. ' +
  'Compares current chainlink price to its value at window open.';

export const paramSchema = {
  threshold: { type: 'number', default: 20, description: 'Minimum price change in dollars to trigger signal' },
};

/**
 * @param {Object} params
 * @returns {{ evaluate: Function, reset: Function }}
 */
export function create(params = {}) {
  const defaultThreshold = params.threshold ?? paramSchema.threshold.default;
  let firstPrice = null;

  function evaluate(state, config = {}) {
    const threshold = config.threshold ?? defaultThreshold;

    if (!state.chainlink?.price) {
      return { direction: null, strength: 0, reason: 'momentum: no chainlink price' };
    }

    if (firstPrice == null) {
      firstPrice = state.chainlink.price;
      return { direction: null, strength: 0, reason: 'momentum: establishing baseline' };
    }

    const change = state.chainlink.price - firstPrice;

    if (Math.abs(change) > threshold) {
      const direction = change > 0 ? 'UP' : 'DOWN';
      const strength = Math.min(Math.abs(change) / (threshold * 3), 1);
      return {
        direction,
        strength,
        reason: `momentum: change=$${change.toFixed(1)} from open=$${firstPrice.toFixed(0)}`,
      };
    }

    return { direction: null, strength: 0, reason: `momentum: change=$${change.toFixed(1)} below threshold` };
  }

  function reset() {
    firstPrice = null;
  }

  return { evaluate, reset };
}
