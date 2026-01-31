/**
 * Position Sizing Logic
 *
 * Core sizing calculations for position sizing.
 * Implements the sizing flow:
 * 1. Calculate base size from config
 * 2. Apply confidence multiplier (optional)
 * 3. Cap at maxPositionSize
 * 4. Check exposure headroom
 * 5. Check orderbook liquidity
 * 6. Apply minimum size threshold
 */

import {
  AdjustmentReason,
  RejectionCode,
  createSizingResult,
  createLiquidityResult,
} from './types.js';

/**
 * Calculate position size for an entry signal
 *
 * @param {Object} signal - Entry signal from strategy-evaluator
 * @param {string} signal.window_id - Window identifier
 * @param {string} signal.market_id - Market identifier
 * @param {string} signal.token_id - Token identifier
 * @param {string} signal.direction - 'long' or 'short'
 * @param {number} signal.confidence - Signal confidence (0.0-1.0)
 * @param {Object} options - Sizing options
 * @param {Object} options.sizingConfig - Sizing configuration
 * @param {Object} options.riskConfig - Risk configuration
 * @param {Function} options.getOrderBook - Polymarket orderbook fetch function
 * @param {Function} options.getCurrentExposure - Position manager exposure function
 * @param {Object} options.log - Logger instance
 * @returns {Promise<Object>} Sizing result with all fields
 */
export async function calculateSize(signal, options) {
  const { sizingConfig, riskConfig, getOrderBook, getCurrentExposure, log } = options;

  const {
    baseSizeDollars,
    minSizeDollars,
    maxSlippagePct,
    confidenceMultiplier,
  } = sizingConfig;

  const { maxPositionSize, maxExposure } = riskConfig;

  // Base size from config
  let requestedSize = baseSizeDollars;
  let actualSize = requestedSize;
  let adjustmentReason = AdjustmentReason.NO_ADJUSTMENT;

  // Get current exposure
  const currentExposure = getCurrentExposure ? getCurrentExposure() : 0;
  const headroom = maxExposure - currentExposure;

  // 1. Apply confidence multiplier (optional)
  if (confidenceMultiplier && confidenceMultiplier > 0 && signal.confidence !== undefined) {
    // Scale based on how much confidence exceeds 0.5 baseline
    // confidence=0.5 → multiplier=1.0, confidence=1.0 → multiplier=1+(0.5*multiplier)
    const confidenceBoost = (signal.confidence - 0.5) * confidenceMultiplier;
    actualSize = requestedSize * (1 + confidenceBoost);
  }

  // 2. Cap at maxPositionSize
  if (actualSize > maxPositionSize) {
    log.warn('size_capped_max_position', {
      original_size: actualSize,
      max_position_size: maxPositionSize,
    });
    actualSize = maxPositionSize;
    adjustmentReason = AdjustmentReason.POSITION_LIMIT_CAPPED;
  }

  // 3. Check exposure headroom
  if (actualSize > headroom) {
    if (headroom < minSizeDollars) {
      // Not enough room for minimum trade
      log.warn('position_sizing_rejected', {
        reason: AdjustmentReason.REJECTED,
        rejection_code: RejectionCode.EXPOSURE_CAP_EXCEEDED,
        current_exposure: currentExposure,
        max_exposure: maxExposure,
        requested_size: requestedSize,
        available_headroom: headroom,
      });

      return createSizingResult({
        success: false,
        requested_size: requestedSize,
        actual_size: 0,
        adjustment_reason: AdjustmentReason.REJECTED,
        rejection_code: RejectionCode.EXPOSURE_CAP_EXCEEDED,
        window_id: signal.window_id,
        market_id: signal.market_id,
        token_id: signal.token_id,
        direction: signal.direction,
        confidence: signal.confidence,
        available_liquidity: 0,
        estimated_slippage: 0,
        current_exposure: currentExposure,
        exposure_headroom: headroom,
      });
    }

    log.warn('size_reduced_exposure_cap', {
      original_size: actualSize,
      exposure_headroom: headroom,
    });
    actualSize = headroom;
    adjustmentReason = AdjustmentReason.EXPOSURE_CAPPED;
  }

  // 4. Check orderbook liquidity
  const side = signal.direction === 'long' ? 'buy' : 'sell';
  const liquidityResult = await analyzeOrderbookLiquidity(
    signal.token_id,
    side,
    actualSize,
    getOrderBook,
    maxSlippagePct,
    log
  );

  if (liquidityResult.availableLiquidity < actualSize) {
    if (liquidityResult.availableLiquidity < minSizeDollars) {
      log.warn('position_sizing_rejected', {
        reason: AdjustmentReason.REJECTED,
        rejection_code: RejectionCode.INSUFFICIENT_LIQUIDITY,
        requested_size: requestedSize,
        available_liquidity: liquidityResult.availableLiquidity,
        min_size_dollars: minSizeDollars,
      });

      return createSizingResult({
        success: false,
        requested_size: requestedSize,
        actual_size: 0,
        adjustment_reason: AdjustmentReason.REJECTED,
        rejection_code: RejectionCode.INSUFFICIENT_LIQUIDITY,
        window_id: signal.window_id,
        market_id: signal.market_id,
        token_id: signal.token_id,
        direction: signal.direction,
        confidence: signal.confidence,
        available_liquidity: liquidityResult.availableLiquidity,
        estimated_slippage: liquidityResult.estimatedSlippage,
        current_exposure: currentExposure,
        exposure_headroom: headroom,
      });
    }

    log.warn('size_reduced_liquidity', {
      original_size: actualSize,
      available_liquidity: liquidityResult.availableLiquidity,
    });
    actualSize = liquidityResult.availableLiquidity;
    // Only update reason if it wasn't already set to something else
    if (adjustmentReason === AdjustmentReason.NO_ADJUSTMENT) {
      adjustmentReason = AdjustmentReason.LIQUIDITY_LIMITED;
    }
  }

  // 5. Minimum size check
  if (actualSize < minSizeDollars) {
    log.warn('position_sizing_rejected', {
      reason: AdjustmentReason.BELOW_MINIMUM,
      rejection_code: RejectionCode.BELOW_MINIMUM_SIZE,
      actual_size: actualSize,
      min_size_dollars: minSizeDollars,
    });

    return createSizingResult({
      success: false,
      requested_size: requestedSize,
      actual_size: 0,
      adjustment_reason: AdjustmentReason.BELOW_MINIMUM,
      rejection_code: RejectionCode.BELOW_MINIMUM_SIZE,
      window_id: signal.window_id,
      market_id: signal.market_id,
      token_id: signal.token_id,
      direction: signal.direction,
      confidence: signal.confidence,
      available_liquidity: liquidityResult.availableLiquidity,
      estimated_slippage: liquidityResult.estimatedSlippage,
      current_exposure: currentExposure,
      exposure_headroom: headroom,
    });
  }

  // Success - log the sizing decision
  log.info('position_sized', {
    window_id: signal.window_id,
    expected: {
      base_size_dollars: baseSizeDollars,
      max_position_size: maxPositionSize,
      max_exposure: maxExposure,
    },
    actual: {
      requested_size: requestedSize,
      actual_size: actualSize,
      adjustment_reason: adjustmentReason,
      available_liquidity: liquidityResult.availableLiquidity,
      current_exposure: currentExposure,
    },
  });

  return createSizingResult({
    success: true,
    requested_size: requestedSize,
    actual_size: actualSize,
    adjustment_reason: adjustmentReason,
    window_id: signal.window_id,
    market_id: signal.market_id,
    token_id: signal.token_id,
    direction: signal.direction,
    confidence: signal.confidence,
    available_liquidity: liquidityResult.availableLiquidity,
    estimated_slippage: liquidityResult.estimatedSlippage,
    current_exposure: currentExposure,
    exposure_headroom: headroom,
  });
}

/**
 * Analyze orderbook for available liquidity at acceptable slippage
 *
 * @param {string} tokenId - Token ID
 * @param {string} side - 'buy' or 'sell'
 * @param {number} desiredSize - Desired size in dollars
 * @param {Function} getOrderBook - Orderbook fetch function
 * @param {number} maxSlippagePct - Maximum acceptable slippage (e.g., 0.01 = 1%)
 * @param {Object} log - Logger instance
 * @returns {Promise<Object>} { availableLiquidity, estimatedSlippage, depthAtPrice }
 */
export async function analyzeOrderbookLiquidity(
  tokenId,
  side,
  desiredSize,
  getOrderBook,
  maxSlippagePct,
  log
) {
  // If no orderbook function provided, return conservative estimate
  if (!getOrderBook) {
    log.warn('orderbook_not_available', { reason: 'getOrderBook function not provided' });
    return createLiquidityResult({
      availableLiquidity: 0,
      estimatedSlippage: 1.0,
      depthAtPrice: 0,
      error: 'orderbook_not_available',
    });
  }

  try {
    const orderbook = await getOrderBook(tokenId);

    // For buys, we look at asks (sellers); for sells, we look at bids (buyers)
    const levels = side === 'buy' ? orderbook.asks : orderbook.bids;

    if (!levels || levels.length === 0) {
      log.debug('orderbook_empty', { token_id: tokenId, side });
      return createLiquidityResult({
        availableLiquidity: 0,
        estimatedSlippage: 1.0,
        depthAtPrice: 0,
      });
    }

    // Calculate how much we can buy/sell within acceptable slippage
    const bestPrice = parseFloat(levels[0].price);
    const slippageThreshold = side === 'buy'
      ? bestPrice * (1 + maxSlippagePct)
      : bestPrice * (1 - maxSlippagePct);

    let availableLiquidity = 0;
    let lastPrice = bestPrice;

    for (const level of levels) {
      const price = parseFloat(level.price);
      const size = parseFloat(level.size);
      const value = price * size;

      // Check if this level is within acceptable slippage
      if (side === 'buy' && price > slippageThreshold) break;
      if (side === 'sell' && price < slippageThreshold) break;

      availableLiquidity += value;
      lastPrice = price;

      if (availableLiquidity >= desiredSize) break;
    }

    // Calculate estimated slippage
    const estimatedSlippage = Math.abs(lastPrice - bestPrice) / bestPrice;

    return createLiquidityResult({
      availableLiquidity,
      estimatedSlippage,
      depthAtPrice: levels.length,
    });
  } catch (err) {
    // On orderbook fetch error, return conservative estimate
    log.warn('orderbook_fetch_failed', {
      token_id: tokenId,
      error: err.message,
    });
    return createLiquidityResult({
      availableLiquidity: 0,
      estimatedSlippage: 1.0,
      depthAtPrice: 0,
      error: err.message,
    });
  }
}

/**
 * Calculate base size from config with optional confidence adjustment
 *
 * @param {Object} signal - Entry signal
 * @param {Object} sizingConfig - Sizing configuration
 * @returns {number} Base size in dollars
 */
export function calculateBaseSize(signal, sizingConfig) {
  const { baseSizeDollars, confidenceMultiplier } = sizingConfig;

  let size = baseSizeDollars;

  // Apply confidence multiplier if configured
  if (confidenceMultiplier && confidenceMultiplier > 0 && signal.confidence !== undefined) {
    const confidenceBoost = (signal.confidence - 0.5) * confidenceMultiplier;
    size = baseSizeDollars * (1 + confidenceBoost);
  }

  return size;
}

/**
 * Check exposure limits
 *
 * @param {number} currentExposure - Current total exposure
 * @param {number} newSize - Proposed new position size
 * @param {number} maxExposure - Maximum allowed exposure
 * @returns {Object} { canProceed, adjustedSize, headroom }
 */
export function checkExposureLimits(currentExposure, newSize, maxExposure) {
  const headroom = maxExposure - currentExposure;

  if (newSize <= headroom) {
    return {
      canProceed: true,
      adjustedSize: newSize,
      headroom,
      reason: null,
    };
  }

  if (headroom > 0) {
    return {
      canProceed: true,
      adjustedSize: headroom,
      headroom,
      reason: AdjustmentReason.EXPOSURE_CAPPED,
    };
  }

  return {
    canProceed: false,
    adjustedSize: 0,
    headroom,
    reason: AdjustmentReason.REJECTED,
  };
}
