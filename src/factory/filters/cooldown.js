/**
 * Filter: Cooldown
 *
 * Enforces a minimum time between entries.
 *
 * Reads: state.timestamp
 * Covers: FR7 (filter building block library)
 */

export const name = 'cooldown';

export const description =
  'Enforces a minimum cooldown period between trade entries.';

export const paramSchema = {
  cooldownMs: { type: 'number', default: 10000, description: 'Minimum milliseconds between entries' },
};

/**
 * @param {Object} params
 * @returns {Function & { reset: Function }} (state, config, signalResult) => boolean
 */
export function create(params = {}) {
  const defaultCooldownMs = params.cooldownMs ?? paramSchema.cooldownMs.default;
  let lastEntryMs = 0;

  function filter(state, config = {}) {
    const cooldownMs = config.cooldownMs ?? defaultCooldownMs;
    const nowMs = state.timestamp ? new Date(state.timestamp).getTime() : 0;
    if (nowMs === 0) return false;

    if (nowMs - lastEntryMs >= cooldownMs) {
      lastEntryMs = nowMs;
      return true;
    }
    return false;
  }

  filter.reset = function () {
    lastEntryMs = 0;
  };

  return filter;
}
