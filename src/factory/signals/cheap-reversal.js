/**
 * Cheap Reversal Signal
 *
 * Fires when:
 * 1. One CLOB token is priced cheap (<maxPrice, default $0.20)
 * 2. Exchange median is close to strike (within proximityPct)
 * 3. This combination suggests the CLOB is overconfident and a reversal is likely
 *
 * The signal buys the CHEAP side — the contrarian bet.
 *
 * Based on reversal deep-dive analysis:
 * - $0.15-0.20 bucket: 15-33% reversal rate = positive EV
 * - Key tell: exchange proximity to strike (within $0.07 for SOL, $0.001 for XRP)
 * - CLOB repricing aggressively = market realizing it's wrong
 *
 * Reads: state.clobUp, state.clobDown, state.getAllExchanges(), state.window.strike
 */

export const name = 'cheap-reversal';
export const description = 'Buy cheap CLOB tokens when exchanges show price near strike (reversal likely)';

export const paramSchema = {
  maxPrice: { type: 'number', default: 0.20, description: 'Max token ask price to consider (cheap threshold)' },
  proximityPct: { type: 'number', default: 0.10, description: 'Max exchange-strike distance as % of strike' },
  minExchanges: { type: 'number', default: 3, description: 'Min exchange feeds required' },
  minClobRepricing: { type: 'number', default: 0, description: 'Min CLOB price change in recent ticks (0 = disabled)' },
};

export function create(params) {
  const defaults = {
    maxPrice: params.maxPrice ?? 0.20,
    proximityPct: params.proximityPct ?? 0.10,
    minExchanges: params.minExchanges ?? 3,
    minClobRepricing: params.minClobRepricing ?? 0,
  };

  return function evaluate(state, config = {}) {
    const maxPrice = config.maxPrice ?? defaults.maxPrice;
    const proximityPct = config.proximityPct ?? defaults.proximityPct;
    const minExchanges = config.minExchanges ?? defaults.minExchanges;

    // Need CLOB data for both sides
    const clobDown = state.clobDown;
    const clobUp = state.clobUp;
    if (!clobDown?.bestAsk || !clobUp?.bestAsk) {
      return { direction: null, strength: 0, reason: 'no CLOB data' };
    }

    // Need strike price
    const strike = state.window?.strike || state.strike;
    if (!strike) {
      return { direction: null, strength: 0, reason: 'no strike price' };
    }

    // Get exchange median
    const exchanges = state.getAllExchanges ? state.getAllExchanges() : [];
    const prices = exchanges.map(e => e.price).filter(p => p > 0);
    if (prices.length < minExchanges) {
      return { direction: null, strength: 0, reason: `only ${prices.length} exchanges (need ${minExchanges})` };
    }
    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];

    // Check exchange proximity to strike
    const distance = Math.abs(median - strike);
    const distancePct = distance / strike;
    if (distancePct > proximityPct) {
      return { direction: null, strength: 0, reason: `exchange ${distancePct.toFixed(4)} from strike (need <${proximityPct})` };
    }

    // Check if either token is cheap
    const downAsk = clobDown.bestAsk;
    const upAsk = clobUp.bestAsk;

    // DOWN token is cheap — CLOB thinks UP, but exchange is near strike
    if (downAsk <= maxPrice && downAsk > 0.01) {
      const exchangeImpliedDown = median < strike; // exchange says DOWN
      const strength = exchangeImpliedDown ? 0.8 : 0.5; // stronger if exchange agrees with contrarian
      return {
        direction: 'DOWN',
        strength,
        reason: `cheap_reversal: DOWN@${downAsk.toFixed(3)}, exch ${distancePct.toFixed(4)} from strike${exchangeImpliedDown ? ' (exch agrees DOWN)' : ''}`,
        token: `${state.window?.symbol || 'btc'}-down`,
      };
    }

    // UP token is cheap — CLOB thinks DOWN, but exchange is near strike
    if (upAsk <= maxPrice && upAsk > 0.01) {
      const exchangeImpliedUp = median > strike; // exchange says UP
      const strength = exchangeImpliedUp ? 0.8 : 0.5;
      return {
        direction: 'UP',
        strength,
        reason: `cheap_reversal: UP@${upAsk.toFixed(3)}, exch ${distancePct.toFixed(4)} from strike${exchangeImpliedUp ? ' (exch agrees UP)' : ''}`,
        token: `${state.window?.symbol || 'btc'}-up`,
      };
    }

    return { direction: null, strength: 0, reason: 'no cheap token' };
  };
}
