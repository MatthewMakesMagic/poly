/**
 * Stale Order Evaluator Module
 *
 * Evaluates open orders to detect when edge has disappeared or reversed.
 * Cancels orders that would result in bad fills due to market movement.
 *
 * Key scenarios where orders become stale:
 * 1. Edge dropped below minimum threshold (market moved, edge gone)
 * 2. Edge reversed (was positive for UP, now positive for DOWN)
 * 3. Window expired or no longer active
 * 4. Market data unavailable for the window
 *
 * @module modules/stale-order-evaluator
 */

import { child } from '../logger/index.js';
import {
  StaleOrderError,
  StaleOrderErrorCodes,
  StaleReason,
  DEFAULT_CONFIG,
} from './types.js';

// Module state
let log = null;
let config = null;
let initialized = false;

// Stats tracking
let stats = {
  evaluations: 0,
  staleDetected: 0,
  cancelledSuccessfully: 0,
  cancelFailed: 0,
  byReason: {},
};

/**
 * Initialize the stale order evaluator module
 *
 * @param {Object} cfg - Configuration object
 * @param {Object} [cfg.staleOrder] - Stale order configuration
 * @param {boolean} [cfg.staleOrder.enabled=true] - Enable/disable evaluation
 * @param {number} [cfg.staleOrder.minEdgeThreshold=0.10] - Minimum edge to keep order
 * @param {boolean} [cfg.staleOrder.cancelOnEdgeReversal=true] - Cancel if edge reversed
 * @param {boolean} [cfg.staleOrder.cancelOnWindowExpired=true] - Cancel if window gone
 * @returns {Promise<void>}
 */
export async function init(cfg = {}) {
  if (initialized) {
    return;
  }

  log = child({ module: 'stale-order-evaluator' });
  log.info('module_init_start');

  // Merge config with defaults
  const staleConfig = cfg.staleOrder || cfg.edge || {};
  config = {
    enabled: staleConfig.enabled ?? DEFAULT_CONFIG.enabled,
    minEdgeThreshold: staleConfig.minEdgeThreshold ?? staleConfig.min_edge_threshold ?? DEFAULT_CONFIG.minEdgeThreshold,
    cancelOnEdgeReversal: staleConfig.cancelOnEdgeReversal ?? DEFAULT_CONFIG.cancelOnEdgeReversal,
    cancelOnWindowExpired: staleConfig.cancelOnWindowExpired ?? DEFAULT_CONFIG.cancelOnWindowExpired,
  };

  initialized = true;
  log.info('module_initialized', { config });
}

/**
 * Recalculate edge for an order given current market conditions
 *
 * @param {Object} order - Order with original signal context
 * @param {Object} windowData - Current window data (market_price, etc.)
 * @param {Object} spotPrices - Current spot prices by symbol
 * @param {Function} calculateProbability - Probability calculation function
 * @returns {Object} { currentEdge, currentModelProbability, currentMarketPrice }
 */
export function recalculateEdge(order, windowData, spotPrices, calculateProbability) {
  if (!order || !windowData) {
    return { currentEdge: null, error: 'missing_data' };
  }

  const symbol = order.symbol?.toLowerCase();
  if (!symbol) {
    return { currentEdge: null, error: 'missing_symbol' };
  }

  // Get current spot price for this symbol
  const spotData = spotPrices?.[symbol];
  if (!spotData?.price) {
    return { currentEdge: null, error: 'spot_price_unavailable' };
  }

  // Get current market price (token price) from window
  const currentMarketPrice = windowData.market_price;
  if (currentMarketPrice == null) {
    return { currentEdge: null, error: 'market_price_unavailable' };
  }

  // Get reference price (strike) from window
  const referencePrice = windowData.reference_price;
  if (!referencePrice) {
    return { currentEdge: null, error: 'reference_price_unavailable' };
  }

  // Calculate time to expiry
  const timeToExpiryMs = windowData.time_remaining_ms || windowData.timeToExpiry;
  if (!timeToExpiryMs || timeToExpiryMs <= 0) {
    return { currentEdge: null, error: 'window_expired' };
  }

  // Calculate current probability
  let currentModelProbability;
  if (typeof calculateProbability === 'function') {
    try {
      const result = calculateProbability(spotData.price, referencePrice, timeToExpiryMs, symbol);
      currentModelProbability = result.p_up;
    } catch (err) {
      log.warn('probability_calculation_failed', {
        order_id: order.order_id,
        error: err.message,
      });
      return { currentEdge: null, error: 'probability_calculation_failed' };
    }
  } else {
    return { currentEdge: null, error: 'no_probability_function' };
  }

  // Calculate current edge based on token side
  let currentEdge;
  if (order.side_token === 'DOWN') {
    // For DOWN token: edge_down = (1 - p_up) - (1 - market_price) = market_price - p_up
    currentEdge = currentMarketPrice - currentModelProbability;
  } else {
    // For UP token: edge_up = p_up - market_price
    currentEdge = currentModelProbability - currentMarketPrice;
  }

  return {
    currentEdge,
    currentModelProbability,
    currentMarketPrice,
    spotPrice: spotData.price,
    referencePrice,
    timeToExpiryMs,
  };
}

/**
 * Evaluate a single order for staleness
 *
 * @param {Object} order - Order to evaluate
 * @param {Object} windowData - Current window data
 * @param {Object} spotPrices - Current spot prices
 * @param {Function} calculateProbability - Probability calculation function
 * @returns {Object} Evaluation result { isStale, reason, details }
 */
export function evaluateOrder(order, windowData, spotPrices, calculateProbability) {
  ensureInitialized();

  if (!config.enabled) {
    return { isStale: false, reason: null };
  }

  const orderId = order.order_id || order.id;

  // Check if window data is available
  if (!windowData) {
    if (config.cancelOnWindowExpired) {
      log.info('order_stale_window_not_found', {
        order_id: orderId,
        window_id: order.window_id,
      });
      return {
        isStale: true,
        reason: StaleReason.WINDOW_NOT_FOUND,
        details: { window_id: order.window_id },
      };
    }
    return { isStale: false, reason: null };
  }

  // Check if window has expired
  const timeRemaining = windowData.time_remaining_ms || windowData.timeToExpiry;
  if (timeRemaining != null && timeRemaining <= 0) {
    if (config.cancelOnWindowExpired) {
      log.info('order_stale_window_expired', {
        order_id: orderId,
        window_id: order.window_id,
      });
      return {
        isStale: true,
        reason: StaleReason.WINDOW_EXPIRED,
        details: { window_id: order.window_id, time_remaining_ms: timeRemaining },
      };
    }
  }

  // Recalculate current edge
  const edgeResult = recalculateEdge(order, windowData, spotPrices, calculateProbability);

  if (edgeResult.error) {
    log.debug('edge_recalculation_failed', {
      order_id: orderId,
      error: edgeResult.error,
    });

    // If we can't calculate edge due to missing data, consider stale
    if (edgeResult.error === 'window_expired') {
      return {
        isStale: true,
        reason: StaleReason.WINDOW_EXPIRED,
        details: { error: edgeResult.error },
      };
    }

    return {
      isStale: true,
      reason: StaleReason.PRICE_DATA_UNAVAILABLE,
      details: { error: edgeResult.error },
    };
  }

  const { currentEdge, currentModelProbability, currentMarketPrice } = edgeResult;
  const originalEdge = order.original_edge;

  // Check if edge reversed (was positive, now negative)
  if (config.cancelOnEdgeReversal && originalEdge > 0 && currentEdge < 0) {
    log.info('order_stale_edge_reversed', {
      order_id: orderId,
      window_id: order.window_id,
      original_edge: originalEdge,
      current_edge: currentEdge,
      side_token: order.side_token,
    });
    return {
      isStale: true,
      reason: StaleReason.EDGE_REVERSED,
      details: {
        original_edge: originalEdge,
        current_edge: currentEdge,
        model_probability: currentModelProbability,
        market_price: currentMarketPrice,
      },
    };
  }

  // Check if edge dropped below threshold
  if (currentEdge < config.minEdgeThreshold) {
    log.info('order_stale_edge_below_threshold', {
      order_id: orderId,
      window_id: order.window_id,
      original_edge: originalEdge,
      current_edge: currentEdge,
      threshold: config.minEdgeThreshold,
    });
    return {
      isStale: true,
      reason: StaleReason.EDGE_BELOW_THRESHOLD,
      details: {
        original_edge: originalEdge,
        current_edge: currentEdge,
        threshold: config.minEdgeThreshold,
        model_probability: currentModelProbability,
        market_price: currentMarketPrice,
      },
    };
  }

  // Order still has sufficient edge
  log.debug('order_edge_valid', {
    order_id: orderId,
    original_edge: originalEdge,
    current_edge: currentEdge,
    threshold: config.minEdgeThreshold,
  });

  return {
    isStale: false,
    reason: null,
    details: {
      current_edge: currentEdge,
      threshold: config.minEdgeThreshold,
    },
  };
}

/**
 * Evaluate all open orders for staleness
 *
 * @param {Object[]} openOrders - Array of open orders
 * @param {Object[]} activeWindows - Array of active windows
 * @param {Object} spotPrices - Current spot prices by symbol
 * @param {Function} calculateProbability - Probability calculation function
 * @returns {Object} { stale: Order[], valid: Order[], summary }
 */
export function evaluateAll(openOrders, activeWindows, spotPrices, calculateProbability) {
  ensureInitialized();

  if (!config.enabled) {
    return {
      stale: [],
      valid: [],
      summary: { evaluated: 0, stale: 0, valid: 0, byReason: {} },
    };
  }

  if (!openOrders || openOrders.length === 0) {
    return {
      stale: [],
      valid: [],
      summary: { evaluated: 0, stale: 0, valid: 0, byReason: {} },
    };
  }

  // Build window lookup map
  const windowMap = new Map();
  for (const window of (activeWindows || [])) {
    const windowId = window.window_id || window.id;
    if (windowId) {
      windowMap.set(windowId, window);
    }
  }

  const stale = [];
  const valid = [];
  const byReason = {};

  for (const order of openOrders) {
    stats.evaluations++;

    // Skip orders without signal context (placed before this feature)
    if (order.original_edge == null) {
      valid.push(order);
      continue;
    }

    const windowData = windowMap.get(order.window_id);
    const result = evaluateOrder(order, windowData, spotPrices, calculateProbability);

    if (result.isStale) {
      stats.staleDetected++;
      stale.push({
        ...order,
        stale_reason: result.reason,
        stale_details: result.details,
      });

      // Track by reason
      byReason[result.reason] = (byReason[result.reason] || 0) + 1;
    } else {
      valid.push(order);
    }
  }

  const summary = {
    evaluated: openOrders.length,
    stale: stale.length,
    valid: valid.length,
    byReason,
  };

  if (stale.length > 0) {
    log.info('stale_orders_detected', summary);
  }

  return { stale, valid, summary };
}

/**
 * Cancel stale orders via order manager
 *
 * @param {Object[]} staleOrders - Orders to cancel
 * @param {Object} orderManager - Order manager module instance
 * @returns {Promise<Object>} { cancelled: string[], failed: string[], summary }
 */
export async function cancelStaleOrders(staleOrders, orderManager) {
  ensureInitialized();

  if (!staleOrders || staleOrders.length === 0) {
    return { cancelled: [], failed: [], summary: { attempted: 0, cancelled: 0, failed: 0 } };
  }

  if (!orderManager || typeof orderManager.cancelOrder !== 'function') {
    throw new StaleOrderError(
      StaleOrderErrorCodes.CANCEL_FAILED,
      'Order manager not available or missing cancelOrder function'
    );
  }

  const cancelled = [];
  const failed = [];

  for (const order of staleOrders) {
    const orderId = order.order_id || order.id;

    try {
      await orderManager.cancelOrder(orderId);
      cancelled.push(orderId);
      stats.cancelledSuccessfully++;

      log.info('stale_order_cancelled', {
        order_id: orderId,
        window_id: order.window_id,
        reason: order.stale_reason,
        original_edge: order.original_edge,
        current_edge: order.stale_details?.current_edge,
      });
    } catch (err) {
      failed.push(orderId);
      stats.cancelFailed++;

      log.warn('stale_order_cancel_failed', {
        order_id: orderId,
        error: err.message,
        code: err.code,
      });
    }
  }

  const summary = {
    attempted: staleOrders.length,
    cancelled: cancelled.length,
    failed: failed.length,
  };

  if (summary.attempted > 0) {
    log.info('stale_order_cancellation_complete', summary);
  }

  return { cancelled, failed, summary };
}

/**
 * Get current module state
 *
 * @returns {Object} Current state including config and stats
 */
export function getState() {
  return {
    initialized,
    config: config ? { ...config } : null,
    stats: { ...stats },
  };
}

/**
 * Get current stats
 *
 * @returns {Object} Stats object
 */
export function getStats() {
  return { ...stats };
}

/**
 * Reset stats (for testing)
 */
export function resetStats() {
  stats = {
    evaluations: 0,
    staleDetected: 0,
    cancelledSuccessfully: 0,
    cancelFailed: 0,
    byReason: {},
  };
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start', { stats });
  }

  config = null;
  initialized = false;

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {StaleOrderError} If not initialized
 */
function ensureInitialized() {
  if (!initialized) {
    throw new StaleOrderError(
      StaleOrderErrorCodes.NOT_INITIALIZED,
      'Stale order evaluator not initialized. Call init() first.'
    );
  }
}

// Re-export types
export { StaleOrderError, StaleOrderErrorCodes, StaleReason } from './types.js';
