/**
 * Polymarket Fee Model
 *
 * Implements Polymarket's actual fee structure for realistic backtesting.
 *
 * Taker fee formula:  fee = C * p * 0.25 * (p * (1-p))^2
 *   where p = token price, C = scaling constant
 *   Max fee at p=0.50: ~1.56%
 *   Drops steeply toward extremes (p=0.90: ~0.20%)
 *
 * Maker rebate: Makers pay NO fee. They earn a share of taker fees
 *   redistributed proportionally. This is INCOME, not a discount.
 *
 * Fee modes:
 *   TAKER_ONLY — apply taker fee on fills (default)
 *   MAKER_REBATE — no fee + earn rebate income
 *   ZERO — no fees (for comparison only, must be explicitly requested)
 *
 * @module factory/fee-model
 */

/**
 * Fee mode enum.
 * @readonly
 * @enum {string}
 */
export const FeeMode = Object.freeze({
  TAKER_ONLY: 'taker',
  MAKER_REBATE: 'maker',
  ZERO: 'zero',
});

/**
 * Polymarket fee scaling constant.
 * Calibrated so max fee at p=0.50 is ~1.5625%.
 *
 * At p=0.50: fee_rate = C * 0.50 * 0.25 * (0.50 * 0.50)^2
 *                     = C * 0.50 * 0.25 * 0.0625
 *                     = C * 0.0078125
 * For max ~1.5625%:   C = 0.015625 / 0.0078125 = 2.0
 */
const FEE_CONSTANT = 2.0;

/**
 * Calculate Polymarket taker fee rate for a given token price.
 *
 * Formula: fee_rate = C * p * 0.25 * (p * (1 - p))^2
 *
 * This fee structure incentivizes trading near extremes (low fee)
 * and penalizes trading at 50/50 prices (higher fee).
 *
 * @param {number} price - Token price (0 < p < 1)
 * @returns {number} Fee rate (e.g., 0.015625 for 1.5625%)
 */
export function calculateTakerFeeRate(price) {
  if (price <= 0 || price >= 1) return 0;
  const p = price;
  const pq = p * (1 - p);
  return FEE_CONSTANT * p * 0.25 * pq * pq;
}

/**
 * Calculate taker fee in dollars for a given fill.
 *
 * @param {number} price - Token fill price
 * @param {number} size - Number of tokens
 * @returns {{ feeRate: number, feeDollars: number, netCostPerToken: number }}
 */
export function calculateTakerFee(price, size) {
  const feeRate = calculateTakerFeeRate(price);
  const grossCost = price * size;
  const feeDollars = grossCost * feeRate;

  return {
    feeRate,
    feeDollars,
    netCostPerToken: price * (1 + feeRate),
  };
}

/**
 * Estimate maker rebate income for a passive fill.
 *
 * Polymarket redistributes 20% of all taker fees in a market
 * to makers proportional to their fee_equivalent contribution.
 *
 * Conservative model: assume small market share (default 1%).
 * The rebate is INCOME — makers get PAID to provide liquidity.
 *
 * @param {number} price - Token fill price (determines fee_equivalent)
 * @param {number} size - Number of tokens filled
 * @param {number} [marketShareEstimate=0.01] - Our share of maker volume (0-1)
 * @returns {{ rebateRate: number, rebateDollars: number, feeEquivalent: number }}
 */
export function estimateMakerRebate(price, size, marketShareEstimate = 0.01) {
  if (price <= 0 || price >= 1 || size <= 0) {
    return { rebateRate: 0, rebateDollars: 0, feeEquivalent: 0 };
  }

  // Fee equivalent is what a taker would have paid on this volume
  const feeRate = calculateTakerFeeRate(price);
  const grossValue = price * size;
  const feeEquivalent = grossValue * feeRate;

  // 20% of all taker fees redistributed to makers
  // Our share = marketShareEstimate of the total maker pool
  // Simplified: rebate = feeEquivalent * 0.20 * marketShareEstimate
  // (In practice this depends on total market maker volume, but this
  //  gives a conservative lower bound)
  const rebateDollars = feeEquivalent * 0.20 * marketShareEstimate;
  const rebateRate = grossValue > 0 ? rebateDollars / grossValue : 0;

  return {
    rebateRate,
    rebateDollars,
    feeEquivalent,
  };
}

/**
 * Apply fee model to a fill result.
 *
 * For TAKER_ONLY: adds fee to cost (reduces effective position)
 * For MAKER_REBATE: subtracts rebate from cost (income)
 * For ZERO: no adjustment
 *
 * @param {Object} fill - Fill result with totalCost, totalShares, vwapPrice
 * @param {string} feeMode - FeeMode value
 * @param {Object} [options]
 * @param {number} [options.marketShareEstimate=0.01] - For maker rebate calculation
 * @returns {Object} Fill result with fee fields added
 */
export function applyFeeToFill(fill, feeMode, options = {}) {
  if (!fill || !fill.success) return fill;

  const { marketShareEstimate = 0.01 } = options;
  const price = fill.vwapPrice || fill.fillPrice || 0;
  const size = fill.totalShares || fill.filled || 0;

  if (feeMode === FeeMode.ZERO) {
    return {
      ...fill,
      feeMode: FeeMode.ZERO,
      feeRate: 0,
      feeDollars: 0,
      rebateDollars: 0,
      netCost: fill.totalCost || (price * size),
    };
  }

  if (feeMode === FeeMode.MAKER_REBATE) {
    const rebate = estimateMakerRebate(price, size, marketShareEstimate);
    const grossCost = fill.totalCost || (price * size);
    return {
      ...fill,
      feeMode: FeeMode.MAKER_REBATE,
      feeRate: 0,
      feeDollars: 0,
      rebateDollars: rebate.rebateDollars,
      rebateRate: rebate.rebateRate,
      feeEquivalent: rebate.feeEquivalent,
      netCost: grossCost - rebate.rebateDollars,
    };
  }

  // Default: TAKER_ONLY
  const fee = calculateTakerFee(price, size);
  const grossCost = fill.totalCost || (price * size);
  return {
    ...fill,
    feeMode: FeeMode.TAKER_ONLY,
    feeRate: fee.feeRate,
    feeDollars: fee.feeDollars,
    netCost: grossCost + fee.feeDollars,
  };
}

/**
 * Parse fee mode from string (CLI argument).
 * Returns FeeMode.TAKER_ONLY for unrecognized values (safe default).
 *
 * @param {string} mode - 'taker', 'maker', 'zero'
 * @returns {string} FeeMode value
 */
export function parseFeeMode(mode) {
  if (!mode) return FeeMode.TAKER_ONLY;
  const normalized = String(mode).toLowerCase().trim();
  if (normalized === 'zero' || normalized === 'none') return FeeMode.ZERO;
  if (normalized === 'maker' || normalized === 'maker_rebate') return FeeMode.MAKER_REBATE;
  return FeeMode.TAKER_ONLY;
}
