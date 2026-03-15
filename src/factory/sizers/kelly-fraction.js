/**
 * Sizer: Kelly Fraction
 *
 * Computes position size using the Kelly criterion:
 *   f* = (p * b - q) / b
 * where p = win probability (from signal strength), b = payoff ratio, q = 1-p.
 *
 * Applies a fraction multiplier (e.g., half-Kelly) for safety.
 *
 * Covers: FR8 (sizer building block library)
 */

export const name = 'kelly-fraction';

export const description =
  'Position size via Kelly criterion: scales capital based on estimated edge and variance.';

export const paramSchema = {
  maxCapital: { type: 'number', default: 10, description: 'Maximum capital per trade in dollars' },
  minCapital: { type: 'number', default: 1, description: 'Minimum capital per trade in dollars' },
  kellyMultiplier: { type: 'number', default: 0.5, description: 'Fraction of full Kelly to use (e.g., 0.5 = half-Kelly)' },
  bankroll: { type: 'number', default: 1000, description: 'Total bankroll for Kelly calculation' },
  payoffRatio: { type: 'number', default: 1, description: 'Ratio of win amount to loss amount (binary = ~1)' },
};

/**
 * @param {Object} params
 * @returns {Function} (state, config, signalResult) => { capitalPerTrade: number }
 */
export function create(params = {}) {
  const defaultMaxCapital = params.maxCapital ?? paramSchema.maxCapital.default;
  const defaultMinCapital = params.minCapital ?? paramSchema.minCapital.default;
  const defaultKellyMultiplier = params.kellyMultiplier ?? paramSchema.kellyMultiplier.default;
  const defaultBankroll = params.bankroll ?? paramSchema.bankroll.default;
  const defaultPayoffRatio = params.payoffRatio ?? paramSchema.payoffRatio.default;

  function sizer(state, config = {}, signalResult) {
    const maxCapital = config.maxCapital ?? defaultMaxCapital;
    const minCapital = config.minCapital ?? defaultMinCapital;
    const kellyMultiplier = config.kellyMultiplier ?? defaultKellyMultiplier;
    const bankroll = config.bankroll ?? defaultBankroll;
    const payoffRatio = config.payoffRatio ?? defaultPayoffRatio;

    // Use signal strength as estimated win probability
    const p = signalResult?.strength ?? 0.5;
    const q = 1 - p;
    const b = payoffRatio;

    // Kelly fraction: f* = (p*b - q) / b
    const kellyFraction = (p * b - q) / b;

    // If Kelly says don't bet (negative edge), use minimum
    if (kellyFraction <= 0) {
      return { capitalPerTrade: minCapital };
    }

    const rawCapital = bankroll * kellyFraction * kellyMultiplier;
    const capitalPerTrade = Math.max(minCapital, Math.min(maxCapital, rawCapital));

    return { capitalPerTrade };
  }

  return sizer;
}
