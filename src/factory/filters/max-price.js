/**
 * Filter: Max Price
 *
 * Only allows entry when the token price (best ask) is below a maximum threshold.
 *
 * Reads: state.clobUp, state.clobDown
 * Covers: FR7 (filter building block library)
 */

export const name = 'max-price';

export const description =
  'Allows entry only when the token best ask price is below a maximum threshold.';

export const paramSchema = {
  maxPrice: { type: 'number', default: 0.65, description: 'Maximum acceptable ask price for entry' },
  side: { type: 'string', default: 'down', description: 'Which token side to check: "up" or "down"' },
};

/**
 * @param {Object} params
 * @returns {Function} (state, config, signalResult) => boolean
 */
export function create(params = {}) {
  const defaultMaxPrice = params.maxPrice ?? paramSchema.maxPrice.default;
  const defaultSide = params.side ?? paramSchema.side.default;

  function filter(state, config = {}, signalResult) {
    const maxPrice = config.maxPrice ?? defaultMaxPrice;
    const side = config.side ?? defaultSide;

    // If signalResult has direction, use that to pick side; otherwise use configured side
    const checkSide = signalResult?.direction
      ? signalResult.direction.toLowerCase()
      : side;

    const book = checkSide === 'down' ? state.clobDown : state.clobUp;
    if (!book || book.bestAsk == null) return false;
    return book.bestAsk <= maxPrice;
  }

  return filter;
}
