/**
 * Signal: CLOB Imbalance
 *
 * Detects order book imbalance between bid and ask sizes on the CLOB.
 * Large bid-side depth relative to ask-side suggests buying pressure (UP),
 * and vice versa.
 *
 * Reads: state.clobUp, state.clobDown
 * Covers: FR6 (signal building block library)
 */

export const name = 'clob-imbalance';

export const description =
  'Signals direction based on CLOB order book bid/ask size imbalance. ' +
  'Heavy bid depth suggests UP pressure, heavy ask depth suggests DOWN.';

export const paramSchema = {
  imbalanceThreshold: { type: 'number', default: 0.3, description: 'Minimum imbalance ratio to trigger (0-1)' },
  side: { type: 'string', default: 'up', description: 'Which CLOB book to analyze: "up" or "down"' },
};

/**
 * @param {Object} params
 * @returns {{ evaluate: Function }}
 */
export function create(params = {}) {
  const defaultImbalanceThreshold = params.imbalanceThreshold ?? paramSchema.imbalanceThreshold.default;
  const defaultSide = params.side ?? paramSchema.side.default;

  function evaluate(state, config = {}) {
    const imbalanceThreshold = config.imbalanceThreshold ?? defaultImbalanceThreshold;
    const side = config.side ?? defaultSide;

    const book = side === 'down' ? state.clobDown : state.clobUp;

    if (!book || book.bidSize == null || book.askSize == null) {
      return { direction: null, strength: 0, reason: `clob-imbalance: no ${side} book data` };
    }

    const total = book.bidSize + book.askSize;
    if (total === 0) {
      return { direction: null, strength: 0, reason: 'clob-imbalance: empty book (zero total size)' };
    }

    // imbalance > 0 means bid-heavy (buying pressure), < 0 means ask-heavy
    const imbalance = (book.bidSize - book.askSize) / total;

    if (Math.abs(imbalance) > imbalanceThreshold) {
      // For UP book: bid-heavy → UP signal. For DOWN book: bid-heavy → DOWN signal.
      const rawDirection = imbalance > 0 ? 'UP' : 'DOWN';
      // If analyzing the DOWN book, flip interpretation:
      // bid-heavy on DOWN book means people want DOWN tokens → DOWN signal
      const direction = side === 'down'
        ? (imbalance > 0 ? 'DOWN' : 'UP')
        : rawDirection;

      const strength = Math.min(Math.abs(imbalance), 1);
      return {
        direction,
        strength,
        reason: `clob-imbalance: ${side} book imbalance=${imbalance.toFixed(3)}, bid=${book.bidSize.toFixed(1)}, ask=${book.askSize.toFixed(1)}`,
      };
    }

    return { direction: null, strength: 0, reason: `clob-imbalance: imbalance=${imbalance.toFixed(3)} below threshold` };
  }

  return { evaluate };
}
