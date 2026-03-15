/**
 * Signal: Chainlink Deficit
 *
 * Detects when Chainlink oracle price is significantly below the strike price,
 * indicating a structural DOWN bias since settlement uses the lower CL value.
 *
 * Reads: state.chainlink, state.strike, state.oraclePriceAtOpen
 * Covers: FR6 (signal building block library)
 */

export const name = 'chainlink-deficit';

export const description =
  'Signals DOWN when Chainlink oracle is significantly below strike, ' +
  'exploiting the structural lag between CL settlement and exchange prices.';

export const paramSchema = {
  threshold: { type: 'number', default: 80, description: 'Minimum CL deficit in dollars to trigger signal' },
};

/**
 * @param {Object} params
 * @returns {{ evaluate: Function }}
 */
export function create(params = {}) {
  const defaultThreshold = params.threshold ?? paramSchema.threshold.default;

  function evaluate(state, config = {}) {
    const threshold = config.threshold ?? defaultThreshold;

    if (state.strike == null && state.oraclePriceAtOpen == null) {
      return { direction: null, strength: 0, reason: 'chainlink-deficit: no strike/oracle reference available' };
    }
    if (!state.chainlink?.price) {
      return { direction: null, strength: 0, reason: 'chainlink-deficit: no chainlink price available' };
    }

    const reference = state.oraclePriceAtOpen ?? state.strike;
    const deficit = reference - state.chainlink.price;

    if (deficit > threshold) {
      const strength = Math.min(deficit / (threshold * 2), 1);
      return {
        direction: 'DOWN',
        strength,
        reason: `chainlink-deficit: deficit=$${deficit.toFixed(0)} > threshold=$${threshold}`,
      };
    }

    return { direction: null, strength: 0, reason: `chainlink-deficit: deficit=$${deficit.toFixed(0)} below threshold` };
  }

  return { evaluate };
}
