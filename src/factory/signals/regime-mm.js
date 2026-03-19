/**
 * Regime Market Making Signal
 *
 * Time-regime based market making for 15-minute binary options:
 *
 * Phase 1 (T=0 to T=5min): Two-sided passive quoting
 *   - Buy both UP and DOWN near midpoint
 *   - Small size, earning liquidity rewards
 *   - Accept fills on either side
 *
 * Phase 2 (T=5 to T=10min): Informed one-sided
 *   - Exchange signal emerging (~70% accuracy)
 *   - Quote only the exchange-favored side
 *   - Larger size
 *
 * Phase 3 (T=10 to T=14min): Aggressive informed
 *   - Exchange signal strong (~90% accuracy)
 *   - Tight quote on favored side
 *   - Maximum fill rate
 *
 * Phase 4 (T=14 to T=15min): Exit only
 *   - No new entries
 *
 * Reads: state.clobUp, state.clobDown, state.getAllExchanges(), state.oraclePriceAtOpen,
 *        state.window.timeToCloseMs, state.window.closeTime
 */

export const name = 'regime-mm';
export const description = 'Time-regime market making: passive early, informed mid, aggressive late';

export const paramSchema = {
  phase1EndMs: { type: 'number', default: 600000, description: 'Phase 1 ends at T-Xms (default: T-10min = 600s before close)' },
  phase2EndMs: { type: 'number', default: 300000, description: 'Phase 2 ends at T-Xms (default: T-5min)' },
  phase3EndMs: { type: 'number', default: 60000, description: 'Phase 3 ends at T-Xms (default: T-1min)' },
  spreadFromMid: { type: 'number', default: 0.015, description: 'How far below mid to place limit buy (default: 1.5c)' },
  maxEntryPrice: { type: 'number', default: 0.48, description: 'Max price to pay for any token' },
  minExchanges: { type: 'number', default: 3, description: 'Min exchanges for informed phases' },
  phase1Capital: { type: 'number', default: 2, description: 'Capital per side in Phase 1' },
  phase2Capital: { type: 'number', default: 4, description: 'Capital per side in Phase 2' },
  phase3Capital: { type: 'number', default: 6, description: 'Capital per side in Phase 3' },
};

export function create(params) {
  const defaults = {
    phase1EndMs: params.phase1EndMs ?? 600000,
    phase2EndMs: params.phase2EndMs ?? 300000,
    phase3EndMs: params.phase3EndMs ?? 60000,
    spreadFromMid: params.spreadFromMid ?? 0.015,
    maxEntryPrice: params.maxEntryPrice ?? 0.48,
    minExchanges: params.minExchanges ?? 3,
    phase1Capital: params.phase1Capital ?? 2,
    phase2Capital: params.phase2Capital ?? 4,
    phase3Capital: params.phase3Capital ?? 6,
  };

  let tradesThisWindow = 0;
  let capitalDeployed = 0;

  function evaluate(state, config = {}) {
    const phase1EndMs = config.phase1EndMs ?? defaults.phase1EndMs;
    const phase2EndMs = config.phase2EndMs ?? defaults.phase2EndMs;
    const phase3EndMs = config.phase3EndMs ?? defaults.phase3EndMs;
    const spreadFromMid = config.spreadFromMid ?? defaults.spreadFromMid;
    const maxEntryPrice = config.maxEntryPrice ?? defaults.maxEntryPrice;
    const minExchanges = config.minExchanges ?? defaults.minExchanges;
    const phase1Capital = config.phase1Capital ?? defaults.phase1Capital;
    const phase2Capital = config.phase2Capital ?? defaults.phase2Capital;
    const phase3Capital = config.phase3Capital ?? defaults.phase3Capital;

    // Determine time remaining
    const timeToClose = state.window?.timeToCloseMs;
    if (timeToClose == null) {
      return { direction: null, strength: 0, reason: 'no timing data' };
    }

    // Phase 4: Exit only (last minute)
    if (timeToClose < phase3EndMs) {
      return { direction: null, strength: 0, reason: `phase4_exit: ${(timeToClose/1000).toFixed(0)}s left` };
    }

    // Need CLOB data
    const clobDown = state.clobDown;
    const clobUp = state.clobUp;
    if (!clobDown || !clobUp) {
      return { direction: null, strength: 0, reason: 'no CLOB' };
    }

    const downAsk = clobDown.bestAsk || clobDown.mid || 0;
    const upAsk = clobUp.bestAsk || clobUp.mid || 0;
    if (downAsk <= 0 || upAsk <= 0) {
      return { direction: null, strength: 0, reason: 'no CLOB prices' };
    }

    // Get exchange direction for informed phases
    const strike = state.oraclePriceAtOpen || state.strike;
    let exchangeDirection = null;
    let exchangeStrength = 0;

    if (strike && state.getAllExchanges) {
      const prices = state.getAllExchanges().map(e => e.price).filter(p => p > 0);
      if (prices.length >= minExchanges) {
        prices.sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        const distFromStrike = (median - strike) / strike;
        exchangeDirection = median > strike ? 'UP' : 'DOWN';
        exchangeStrength = Math.abs(distFromStrike);
      }
    }

    // PHASE 1: Two-sided passive (T=0 to T=10min before close)
    if (timeToClose > phase1EndMs) {
      // Buy whichever side is cheaper (closer to midpoint spread capture)
      const downEntry = Math.min(downAsk, 0.50 - spreadFromMid);
      const upEntry = Math.min(upAsk, 0.50 - spreadFromMid);

      if (downEntry <= maxEntryPrice && downEntry > 0.01) {
        tradesThisWindow++;
        capitalDeployed += phase1Capital;
        return {
          direction: 'DOWN',
          strength: 0.3,
          reason: `phase1_passive: DOWN@${downEntry.toFixed(3)}, two-sided quoting, ${(timeToClose/1000).toFixed(0)}s left`,
          capitalPerTrade: phase1Capital,
        };
      }
      if (upEntry <= maxEntryPrice && upEntry > 0.01) {
        tradesThisWindow++;
        capitalDeployed += phase1Capital;
        return {
          direction: 'UP',
          strength: 0.3,
          reason: `phase1_passive: UP@${upEntry.toFixed(3)}, two-sided quoting, ${(timeToClose/1000).toFixed(0)}s left`,
          capitalPerTrade: phase1Capital,
        };
      }
      return { direction: null, strength: 0, reason: `phase1: prices too high (D@${downAsk.toFixed(2)} U@${upAsk.toFixed(2)})` };
    }

    // PHASE 2: Informed one-sided (T=10min to T=5min before close)
    if (timeToClose > phase2EndMs) {
      if (!exchangeDirection) {
        return { direction: null, strength: 0, reason: 'phase2: no exchange signal' };
      }

      const favoredAsk = exchangeDirection === 'DOWN' ? downAsk : upAsk;
      if (favoredAsk <= maxEntryPrice && favoredAsk > 0.01) {
        tradesThisWindow++;
        capitalDeployed += phase2Capital;
        return {
          direction: exchangeDirection,
          strength: 0.6,
          reason: `phase2_informed: ${exchangeDirection}@${favoredAsk.toFixed(3)}, exch says ${exchangeDirection} (str=${(exchangeStrength*100).toFixed(2)}%), ${(timeToClose/1000).toFixed(0)}s left`,
          capitalPerTrade: phase2Capital,
        };
      }
      return { direction: null, strength: 0, reason: `phase2: ${exchangeDirection} side too expensive @${favoredAsk.toFixed(2)}` };
    }

    // PHASE 3: Aggressive informed (T=5min to T=1min before close)
    if (timeToClose > phase3EndMs) {
      if (!exchangeDirection) {
        return { direction: null, strength: 0, reason: 'phase3: no exchange signal' };
      }

      // In phase 3, we're more aggressive — accept higher prices
      const aggressiveMaxPrice = Math.min(maxEntryPrice + 0.05, 0.55);
      const favoredAsk = exchangeDirection === 'DOWN' ? downAsk : upAsk;

      if (favoredAsk <= aggressiveMaxPrice && favoredAsk > 0.01) {
        tradesThisWindow++;
        capitalDeployed += phase3Capital;
        return {
          direction: exchangeDirection,
          strength: 0.9,
          reason: `phase3_aggressive: ${exchangeDirection}@${favoredAsk.toFixed(3)}, exch strong ${exchangeDirection} (str=${(exchangeStrength*100).toFixed(2)}%), ${(timeToClose/1000).toFixed(0)}s left`,
          capitalPerTrade: phase3Capital,
        };
      }
      return { direction: null, strength: 0, reason: `phase3: ${exchangeDirection} side @${favoredAsk.toFixed(2)} > max ${aggressiveMaxPrice.toFixed(2)}` };
    }

    return { direction: null, strength: 0, reason: 'unknown phase' };
  }

  function reset() {
    tradesThisWindow = 0;
    capitalDeployed = 0;
  }

  return { evaluate, reset };
}
