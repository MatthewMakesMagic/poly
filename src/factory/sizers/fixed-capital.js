/**
 * Sizer: Fixed Capital
 *
 * Returns a fixed dollar amount per trade regardless of market conditions.
 *
 * Covers: FR8 (sizer building block library)
 */

export const name = 'fixed-capital';

export const description =
  'Returns a fixed dollar amount per trade.';

export const paramSchema = {
  capitalPerTrade: { type: 'number', default: 2, description: 'Dollar amount per trade' },
};

/**
 * @param {Object} params
 * @returns {Function} (state, config, signalResult) => { capitalPerTrade: number }
 */
export function create(params = {}) {
  const defaultCapitalPerTrade = params.capitalPerTrade ?? paramSchema.capitalPerTrade.default;

  function sizer(state, config = {}) {
    const capitalPerTrade = config.capitalPerTrade ?? defaultCapitalPerTrade;
    return { capitalPerTrade };
  }

  return sizer;
}
