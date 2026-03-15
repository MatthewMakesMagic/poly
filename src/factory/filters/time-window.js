/**
 * Filter: Time Window
 *
 * Only allows entry within the last N milliseconds of a trading window.
 *
 * Reads: state.window.timeToCloseMs
 * Covers: FR7 (filter building block library)
 */

export const name = 'time-window';

export const description =
  'Allows entry only within the last N milliseconds of the trading window.';

export const paramSchema = {
  entryWindowMs: { type: 'number', default: 120000, description: 'Maximum time-to-close in ms to allow entry' },
};

/**
 * @param {Object} params
 * @returns {Function} (state, config, signalResult) => boolean
 */
export function create(params = {}) {
  const defaultEntryWindowMs = params.entryWindowMs ?? paramSchema.entryWindowMs.default;

  function filter(state, config = {}) {
    const entryWindowMs = config.entryWindowMs ?? defaultEntryWindowMs;
    if (!state.window || state.window.timeToCloseMs == null) return false;
    return state.window.timeToCloseMs <= entryWindowMs;
  }

  return filter;
}
