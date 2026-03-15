/**
 * Signal: Ref Near Strike
 *
 * Signals DOWN when polyRef price is within a threshold distance of the
 * reference price (oraclePriceAtOpen or strike). Used in edge-c-style
 * strategies to confirm the reference price is near enough to matter.
 *
 * Reads: state.polyRef, state.oraclePriceAtOpen, state.strike
 * Covers: FR6 (signal building block library)
 */

export const name = 'ref-near-strike';

export const description =
  'Signals when polyRef price is within a threshold distance of the strike/oracle reference. ' +
  'Used to confirm the reference price proximity condition.';

export const paramSchema = {
  threshold: { type: 'number', default: 100, description: 'Maximum distance in dollars between polyRef and strike to trigger signal' },
};

/**
 * @param {Object} params
 * @returns {{ evaluate: Function }}
 */
export function create(params = {}) {
  const defaultThreshold = params.threshold ?? paramSchema.threshold.default;

  function evaluate(state, config = {}) {
    const threshold = config.threshold ?? defaultThreshold;

    if (!state.polyRef?.price) {
      return { direction: null, strength: 0, reason: 'ref-near-strike: no polyRef price available' };
    }

    const reference = state.oraclePriceAtOpen ?? state.strike;
    if (reference == null) {
      return { direction: null, strength: 0, reason: 'ref-near-strike: no strike/oracle reference available' };
    }

    const distance = Math.abs(state.polyRef.price - reference);

    if (distance < threshold) {
      // The closer to strike, the stronger the signal
      const strength = Math.max(0, 1 - distance / threshold);
      return {
        direction: 'DOWN',
        strength,
        reason: `ref-near-strike: distance=$${distance.toFixed(0)} < threshold=$${threshold}`,
      };
    }

    return { direction: null, strength: 0, reason: `ref-near-strike: distance=$${distance.toFixed(0)} >= threshold=$${threshold}` };
  }

  return { evaluate };
}
