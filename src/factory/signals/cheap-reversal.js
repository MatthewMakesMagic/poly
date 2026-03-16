/**
 * Cheap Reversal Signal
 *
 * Fires when:
 * 1. One CLOB token is priced cheap (<maxPrice, default $0.20)
 * 2. Exchange median is close to strike/oracleOpen (within proximityPct)
 * 3. This combination suggests the CLOB is overconfident and a reversal is likely
 *
 * The signal buys the CHEAP side — the contrarian bet.
 *
 * Reads: state.clobUp, state.clobDown, state.getAllExchanges(), state.strike, state.oraclePriceAtOpen
 */

export const name = 'cheap-reversal';
export const description = 'Buy cheap CLOB tokens when exchanges show price near strike (reversal likely)';

export const paramSchema = {
  maxPrice: { type: 'number', default: 0.20, description: 'Max token ask price to consider (cheap threshold)' },
  proximityPct: { type: 'number', default: 0.10, description: 'Max exchange-strike distance as % of strike' },
  minExchanges: { type: 'number', default: 3, description: 'Min exchange feeds required' },
};

export function create(params) {
  const defaults = {
    maxPrice: params.maxPrice ?? 0.20,
    proximityPct: params.proximityPct ?? 0.10,
    minExchanges: params.minExchanges ?? 3,
  };

  // Track debug stats
  let evalCount = 0;
  let cheapFound = 0;

  function reset() {
    evalCount = 0;
    cheapFound = 0;
  }

  function evaluate(state, config = {}) {
    const maxPrice = config.maxPrice ?? defaults.maxPrice;
    const proximityPct = config.proximityPct ?? defaults.proximityPct;
    const minExchanges = config.minExchanges ?? defaults.minExchanges;

    evalCount++;

    const clobDown = state.clobDown;
    const clobUp = state.clobUp;
    if (!clobDown || !clobUp) {
      return { direction: null, strength: 0, reason: 'no CLOB data' };
    }

    // Use bestAsk if available, fall back to mid
    const downPrice = clobDown.bestAsk || clobDown.mid || 0;
    const upPrice = clobUp.bestAsk || clobUp.mid || 0;
    if (downPrice <= 0 || upPrice <= 0) {
      return { direction: null, strength: 0, reason: 'no CLOB prices' };
    }

    // Strike = oracle price at open (works for all symbols)
    const strike = state.oraclePriceAtOpen || state.strike;
    if (!strike) {
      return { direction: null, strength: 0, reason: 'no strike/oracle price' };
    }

    // Get exchange median
    let median;
    if (state.getAllExchanges) {
      const exchanges = state.getAllExchanges();
      const prices = exchanges.map(e => e.price).filter(p => p > 0);
      if (prices.length < minExchanges) {
        return { direction: null, strength: 0, reason: `${prices.length} exchanges (need ${minExchanges})` };
      }
      prices.sort((a, b) => a - b);
      median = prices[Math.floor(prices.length / 2)];
    } else if (state.getExchangeMedian) {
      median = state.getExchangeMedian();
    }
    if (!median) {
      return { direction: null, strength: 0, reason: 'no exchange data' };
    }

    // Check exchange proximity to strike
    const distance = Math.abs(median - strike);
    const distancePct = distance / strike;

    // Check if either token is cheap
    const downCheap = downPrice <= maxPrice && downPrice > 0.01;
    const upCheap = upPrice <= maxPrice && upPrice > 0.01;

    if (downCheap) cheapFound++;
    if (upCheap) cheapFound++;

    // DOWN token is cheap AND exchange is near strike → buy DOWN
    if (downCheap && distancePct <= proximityPct) {
      const exchangeImpliedDown = median < strike;
      return {
        direction: 'DOWN',
        strength: exchangeImpliedDown ? 0.8 : 0.5,
        reason: `cheap_reversal: DOWN@${downPrice.toFixed(3)}, exch ${(distancePct*100).toFixed(2)}% from strike${exchangeImpliedDown ? ' (agrees)' : ''}`,
      };
    }

    // UP token is cheap AND exchange is near strike → buy UP
    if (upCheap && distancePct <= proximityPct) {
      const exchangeImpliedUp = median > strike;
      return {
        direction: 'UP',
        strength: exchangeImpliedUp ? 0.8 : 0.5,
        reason: `cheap_reversal: UP@${upPrice.toFixed(3)}, exch ${(distancePct*100).toFixed(2)}% from strike${exchangeImpliedUp ? ' (agrees)' : ''}`,
      };
    }

    // No cheap token or exchange too far from strike
    if (downCheap || upCheap) {
      return { direction: null, strength: 0, reason: `cheap token found but exch ${(distancePct*100).toFixed(2)}% from strike (need <${proximityPct*100}%)` };
    }
    return { direction: null, strength: 0, reason: `no cheap token (DOWN@${downPrice.toFixed(2)}, UP@${upPrice.toFixed(2)})` };
  }

  evaluate.reset = reset;
  return evaluate;
}
