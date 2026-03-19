/**
 * Informed Entry Signal
 *
 * Only enters when TWO conditions are met:
 * 1. Exchange has moved meaningfully from strike (we KNOW the likely direction)
 * 2. CLOB hasn't fully repriced yet (the token is still CHEAP relative to our info)
 *
 * The edge: exchange moves first, CLOB lags. We buy the favored token
 * while it's still cheap. If CLOB has already repriced to $0.90, there's
 * no edge — we'd be buying $0.90 for a $1 payout (10% return, not worth the risk).
 *
 * Reads: state.clobUp, state.clobDown, state.getAllExchanges(), state.oraclePriceAtOpen
 */

export const name = 'informed-entry';
export const description = 'Buy favored token only when exchange confirms direction AND CLOB is still cheap';

export const paramSchema = {
  minExchangeDistPct: { type: 'number', default: 0.05, description: 'Min exchange distance from strike (%) to confirm direction' },
  maxClobPrice: { type: 'number', default: 0.60, description: 'Max CLOB ask for the favored token (must still be cheap)' },
  minClobPrice: { type: 'number', default: 0.01, description: 'Min CLOB ask (filter out $0 garbage)' },
  minExchanges: { type: 'number', default: 3, description: 'Min exchange feeds required' },
};

export function create(params) {
  const defaults = {
    minExchangeDistPct: params.minExchangeDistPct ?? 0.05,
    maxClobPrice: params.maxClobPrice ?? 0.60,
    minClobPrice: params.minClobPrice ?? 0.01,
    minExchanges: params.minExchanges ?? 3,
  };

  function evaluate(state, config = {}) {
    const minDistPct = config.minExchangeDistPct ?? defaults.minExchangeDistPct;
    const maxClob = config.maxClobPrice ?? defaults.maxClobPrice;
    const minClob = config.minClobPrice ?? defaults.minClobPrice;
    const minExchanges = config.minExchanges ?? defaults.minExchanges;

    // Need CLOB
    const clobDown = state.clobDown;
    const clobUp = state.clobUp;
    if (!clobDown || !clobUp) {
      return { direction: null, strength: 0, reason: 'no CLOB' };
    }

    const downAsk = clobDown.bestAsk || clobDown.mid || 0;
    const upAsk = clobUp.bestAsk || clobUp.mid || 0;

    // Need strike
    const strike = state.oraclePriceAtOpen || state.strike;
    if (!strike) {
      return { direction: null, strength: 0, reason: 'no strike' };
    }

    // Get exchange median
    if (!state.getAllExchanges) {
      return { direction: null, strength: 0, reason: 'no exchange fn' };
    }
    const prices = state.getAllExchanges().map(e => e.price).filter(p => p > 0);
    if (prices.length < minExchanges) {
      return { direction: null, strength: 0, reason: `${prices.length} exchanges` };
    }
    prices.sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];

    // Check 1: Has exchange moved enough from strike?
    const distFromStrike = (median - strike) / strike;
    const absDist = Math.abs(distFromStrike);

    if (absDist < minDistPct / 100) {
      return { direction: null, strength: 0, reason: `exch too close to strike (${(absDist*100).toFixed(4)}% < ${minDistPct}%)` };
    }

    const exchangeDirection = distFromStrike > 0 ? 'UP' : 'DOWN';

    // Check 2: Is the favored token still CHEAP on CLOB?
    // If exchange says DOWN, we want to buy DOWN — is DOWN ask still cheap?
    // If exchange says UP, we want to buy UP — is UP ask still cheap?
    const favoredAsk = exchangeDirection === 'DOWN' ? downAsk : upAsk;
    const unfavoredAsk = exchangeDirection === 'DOWN' ? upAsk : downAsk;

    if (favoredAsk < minClob) {
      return { direction: null, strength: 0, reason: `${exchangeDirection} token @${favoredAsk.toFixed(3)} below min` };
    }

    if (favoredAsk > maxClob) {
      // CLOB has already repriced — no edge left
      return { direction: null, strength: 0, reason: `NO EDGE: ${exchangeDirection} token already @${favoredAsk.toFixed(3)} (CLOB caught up)` };
    }

    // Both conditions met: exchange confirms direction AND CLOB is still cheap
    // Strength based on how cheap the token is (cheaper = bigger payout = more edge)
    const strength = 1 - favoredAsk; // $0.10 token = 0.9 strength, $0.50 token = 0.5 strength

    return {
      direction: exchangeDirection,
      strength,
      reason: `informed: exch ${(distFromStrike*100).toFixed(3)}% from strike → ${exchangeDirection}, CLOB ${exchangeDirection}@${favoredAsk.toFixed(3)} (cheap! payout=${(1-favoredAsk).toFixed(2)})`,
    };
  }

  function reset() {}

  return { evaluate, reset };
}
