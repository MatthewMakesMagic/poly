/**
 * Sizer: Volatility Scaled
 *
 * Adjusts position size inversely to recent price volatility.
 * Higher volatility → smaller positions; lower volatility → larger positions.
 *
 * Uses chainlink price history to estimate realized volatility.
 *
 * Reads: state.chainlink
 * Covers: FR8 (sizer building block library)
 */

export const name = 'volatility-scaled';

export const description =
  'Adjusts position size inversely to recent price volatility from chainlink data.';

export const paramSchema = {
  baseCapital: { type: 'number', default: 2, description: 'Base capital per trade in dollars' },
  maxCapital: { type: 'number', default: 10, description: 'Maximum capital per trade' },
  minCapital: { type: 'number', default: 1, description: 'Minimum capital per trade' },
  targetVol: { type: 'number', default: 50, description: 'Target annualized volatility in dollars for base sizing' },
  lookback: { type: 'number', default: 20, description: 'Number of price points for vol estimation' },
};

/**
 * @param {Object} params
 * @returns {Function & { reset: Function }} (state, config, signalResult) => { capitalPerTrade: number }
 */
export function create(params = {}) {
  const defaultBaseCapital = params.baseCapital ?? paramSchema.baseCapital.default;
  const defaultMaxCapital = params.maxCapital ?? paramSchema.maxCapital.default;
  const defaultMinCapital = params.minCapital ?? paramSchema.minCapital.default;
  const defaultTargetVol = params.targetVol ?? paramSchema.targetVol.default;
  const defaultLookback = params.lookback ?? paramSchema.lookback.default;
  let priceHistory = [];

  function sizer(state, config = {}) {
    const baseCapital = config.baseCapital ?? defaultBaseCapital;
    const maxCapital = config.maxCapital ?? defaultMaxCapital;
    const minCapital = config.minCapital ?? defaultMinCapital;
    const targetVol = config.targetVol ?? defaultTargetVol;
    const lookback = config.lookback ?? defaultLookback;

    if (state.chainlink?.price) {
      priceHistory.push(state.chainlink.price);
      if (priceHistory.length > lookback) {
        priceHistory = priceHistory.slice(-lookback);
      }
    }

    if (priceHistory.length < 5) {
      return { capitalPerTrade: baseCapital };
    }

    // Compute realized vol as standard deviation of price changes
    const changes = [];
    for (let i = 1; i < priceHistory.length; i++) {
      changes.push(priceHistory[i] - priceHistory[i - 1]);
    }
    const mean = changes.reduce((s, c) => s + c, 0) / changes.length;
    const variance = changes.reduce((s, c) => s + (c - mean) ** 2, 0) / changes.length;
    const vol = Math.sqrt(variance);

    if (vol <= 0) {
      return { capitalPerTrade: baseCapital };
    }

    // Scale inversely: low vol → bigger position, high vol → smaller
    const scaleFactor = targetVol / vol;
    const rawCapital = baseCapital * Math.min(scaleFactor, 3); // cap at 3x base
    const capitalPerTrade = Math.max(minCapital, Math.min(maxCapital, rawCapital));

    return { capitalPerTrade };
  }

  sizer.reset = function () {
    priceHistory = [];
  };

  return sizer;
}
