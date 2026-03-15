/**
 * Filter: Min Data
 *
 * Requires a minimum number of data points (ticks) before allowing entry.
 * Prevents trading on insufficient market data.
 *
 * Reads: state.getTickCount()
 * Covers: FR7 (filter building block library)
 */

export const name = 'min-data';

export const description =
  'Requires a minimum number of ticks/data points before allowing entry.';

export const paramSchema = {
  minTicks: { type: 'number', default: 50, description: 'Minimum tick count before entry is allowed' },
};

/**
 * @param {Object} params
 * @returns {Function} (state, config, signalResult) => boolean
 */
export function create(params = {}) {
  const defaultMinTicks = params.minTicks ?? paramSchema.minTicks.default;

  function filter(state, config = {}) {
    const minTicks = config.minTicks ?? defaultMinTicks;
    const tickCount = typeof state.getTickCount === 'function' ? state.getTickCount() : (state._tickCount ?? 0);
    return tickCount >= minTicks;
  }

  return filter;
}
