/**
 * Cheap Reversal Signal
 *
 * Fires when:
 * 1. One CLOB token is priced cheap (<maxPrice) — market is confident
 * 2. Exchange median DISAGREES with the CLOB's direction — exchanges say the other way
 *
 * Example: CLOB DOWN at $0.08 (market says UP). But exchange median is BELOW strike
 * (exchanges say DOWN). The CLOB is wrong → buy DOWN at $0.08 for a 12:1 payout.
 *
 * The proximity is between exchange-implied direction and CLOB-implied direction,
 * NOT exchange-to-strike distance (which is meaningless for low-priced assets).
 *
 * Reads: state.clobUp, state.clobDown, state.getAllExchanges(), state.oraclePriceAtOpen/strike
 */

export const name = 'cheap-reversal';
export const description = 'Buy cheap CLOB tokens when exchanges disagree with market consensus';

export const paramSchema = {
  maxPrice: { type: 'number', default: 0.15, description: 'Max token ask price to consider cheap' },
  requireExchangeDisagree: { type: 'boolean', default: true, description: 'Require exchanges to disagree with CLOB direction' },
  minExchanges: { type: 'number', default: 3, description: 'Min exchange feeds required' },
};

export function create(params) {
  const defaults = {
    maxPrice: params.maxPrice ?? 0.15,
    requireExchangeDisagree: params.requireExchangeDisagree ?? true,
    minExchanges: params.minExchanges ?? 3,
  };

  function evaluate(state, config = {}) {
    const maxPrice = config.maxPrice ?? defaults.maxPrice;
    const requireDisagree = config.requireExchangeDisagree ?? defaults.requireExchangeDisagree;
    const minExchanges = config.minExchanges ?? defaults.minExchanges;

    const clobDown = state.clobDown;
    const clobUp = state.clobUp;
    if (!clobDown || !clobUp) {
      return { direction: null, strength: 0, reason: 'no CLOB data' };
    }

    const downPrice = clobDown.bestAsk || clobDown.mid || 0;
    const upPrice = clobUp.bestAsk || clobUp.mid || 0;
    if (downPrice <= 0 || upPrice <= 0) {
      return { direction: null, strength: 0, reason: 'no CLOB prices' };
    }

    // Strike = oracle price at open
    const strike = state.oraclePriceAtOpen || state.strike;
    if (!strike) {
      return { direction: null, strength: 0, reason: 'no strike' };
    }

    // Get exchange median
    let median;
    if (state.getAllExchanges) {
      const prices = state.getAllExchanges().map(e => e.price).filter(p => p > 0);
      if (prices.length < minExchanges) {
        return { direction: null, strength: 0, reason: `${prices.length} exchanges` };
      }
      prices.sort((a, b) => a - b);
      median = prices[Math.floor(prices.length / 2)];
    } else if (state.getExchangeMedian) {
      median = state.getExchangeMedian();
    }
    if (!median) {
      return { direction: null, strength: 0, reason: 'no exchange data' };
    }

    const exchangeSaysUp = median > strike;
    const exchangeSaysDown = median < strike;

    // DOWN token is cheap — CLOB confident it's UP
    if (downPrice <= maxPrice && downPrice > 0.01) {
      // CLOB says UP (DOWN is cheap). Do exchanges agree or disagree?
      if (requireDisagree && exchangeSaysUp) {
        // Exchanges AGREE with CLOB → no contrarian signal
        return { direction: null, strength: 0, reason: `DOWN@${downPrice.toFixed(2)} cheap but exch agrees UP` };
      }
      if (exchangeSaysDown || !requireDisagree) {
        // Exchanges DISAGREE — they say DOWN while CLOB says UP → contrarian buy DOWN
        const strength = exchangeSaysDown ? 0.9 : 0.5;
        return {
          direction: 'DOWN',
          strength,
          reason: `reversal: DOWN@${downPrice.toFixed(3)}, CLOB says UP but exch says DOWN (median=${median.toFixed(4)} < strike=${strike.toFixed(4)})`,
        };
      }
    }

    // UP token is cheap — CLOB confident it's DOWN
    if (upPrice <= maxPrice && upPrice > 0.01) {
      if (requireDisagree && exchangeSaysDown) {
        return { direction: null, strength: 0, reason: `UP@${upPrice.toFixed(2)} cheap but exch agrees DOWN` };
      }
      if (exchangeSaysUp || !requireDisagree) {
        const strength = exchangeSaysUp ? 0.9 : 0.5;
        return {
          direction: 'UP',
          strength,
          reason: `reversal: UP@${upPrice.toFixed(3)}, CLOB says DOWN but exch says UP (median=${median.toFixed(4)} > strike=${strike.toFixed(4)})`,
        };
      }
    }

    return { direction: null, strength: 0, reason: `no cheap token (D@${downPrice.toFixed(2)} U@${upPrice.toFixed(2)})` };
  }

  function reset() {}

  return { evaluate, reset };
}
