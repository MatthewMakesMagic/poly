/**
 * Signal: Exchange Consensus
 *
 * Compares the median exchange price to the strike to determine directional bias.
 * When most exchanges agree price is above/below strike, signals accordingly.
 *
 * Reads: state._exchanges (via getExchangeMedian()), state.strike, state.oraclePriceAtOpen
 * Covers: FR6 (signal building block library)
 */

export const name = 'exchange-consensus';

export const description =
  'Signals direction based on median exchange price relative to strike. ' +
  'Strong consensus across exchanges increases signal strength.';

export const paramSchema = {
  threshold: { type: 'number', default: 50, description: 'Minimum distance from strike in dollars to signal' },
  minExchanges: { type: 'number', default: 2, description: 'Minimum number of exchanges with data' },
};

/**
 * @param {Object} params
 * @returns {{ evaluate: Function }}
 */
export function create(params = {}) {
  const defaultThreshold = params.threshold ?? paramSchema.threshold.default;
  const defaultMinExchanges = params.minExchanges ?? paramSchema.minExchanges.default;

  function evaluate(state, config = {}) {
    const threshold = config.threshold ?? defaultThreshold;
    const minExchanges = config.minExchanges ?? defaultMinExchanges;

    const reference = state.oraclePriceAtOpen ?? state.strike;
    if (reference == null) {
      return { direction: null, strength: 0, reason: 'exchange-consensus: no strike reference' };
    }

    const exchanges = state.getAllExchanges();
    if (exchanges.length < minExchanges) {
      return { direction: null, strength: 0, reason: `exchange-consensus: only ${exchanges.length} exchanges (need ${minExchanges})` };
    }

    const median = state.getExchangeMedian();
    if (median == null) {
      return { direction: null, strength: 0, reason: 'exchange-consensus: could not compute median' };
    }

    const gap = median - reference;

    if (Math.abs(gap) > threshold) {
      const direction = gap > 0 ? 'UP' : 'DOWN';
      const strength = Math.min(Math.abs(gap) / (threshold * 3), 1);
      return {
        direction,
        strength,
        reason: `exchange-consensus: median=$${median.toFixed(0)}, ref=$${reference.toFixed(0)}, gap=$${gap.toFixed(0)}`,
      };
    }

    return { direction: null, strength: 0, reason: `exchange-consensus: gap=$${gap.toFixed(0)} below threshold` };
  }

  return { evaluate };
}
