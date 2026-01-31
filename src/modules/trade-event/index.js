/**
 * Trade Event Module
 *
 * Public interface for trade event logging with expected vs actual values.
 * Follows the standard module interface: init(config), getState(), shutdown()
 *
 * Capabilities:
 * - Record signal events when strategy generates entry/exit signals
 * - Record entry events with slippage and latency calculations
 * - Record exit events with position linking
 * - Record alerts for divergence and error conditions
 * - Query events by window, position, or filters
 *
 * @module modules/trade-event
 */

import { child } from '../logger/index.js';
import { TradeEventError, TradeEventErrorCodes, TradeEventType } from './types.js';
import {
  isInitialized,
  setInitialized,
  setConfig,
  getConfig,
  resetState,
  getStateSnapshot,
} from './state.js';
import {
  calculateLatencies,
  calculateSlippage,
  insertTradeEvent,
  queryEvents,
  queryEventsByWindow,
  queryEventsByPosition,
  validateRequiredFields,
  positionExists,
  queryLatencyStats,
  calculateP95Latency,
  getLatencyBreakdown,
  querySlippageStats,
  querySlippageBySize,
  querySlippageBySpread,
  detectDiagnosticFlags,
  checkDivergence,
  detectStateDivergence,
  queryDivergentEvents,
  queryDivergenceSummary,
} from './logic.js';

// Module state
let log = null;

/**
 * Initialize the trade event module
 *
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
export async function init(config) {
  if (isInitialized()) {
    throw new TradeEventError(
      TradeEventErrorCodes.ALREADY_INITIALIZED,
      'Trade event module already initialized',
      {}
    );
  }

  // Create child logger for this module
  log = child({ module: 'trade-event' });
  log.info('module_init_start');

  // Store configuration
  setConfig(config);

  setInitialized(true);
  log.info('module_initialized');
}

/**
 * Record a signal event when strategy detects entry/exit opportunity
 *
 * @param {Object} params - Signal parameters
 * @param {string} params.windowId - Window identifier
 * @param {string} params.strategyId - Strategy identifier
 * @param {string} params.signalType - Type of signal (entry/exit)
 * @param {number} params.priceAtSignal - Market price when signal detected
 * @param {number} params.expectedPrice - Expected execution price
 * @param {Object} [params.marketContext] - Market context data
 * @param {number} [params.marketContext.bidAtSignal] - Bid price at signal
 * @param {number} [params.marketContext.askAtSignal] - Ask price at signal
 * @param {number} [params.marketContext.spreadAtSignal] - Spread at signal
 * @param {number} [params.marketContext.depthAtSignal] - Depth at signal
 * @returns {Promise<number>} Created event ID
 */
export async function recordSignal({
  windowId,
  strategyId,
  signalType,
  priceAtSignal,
  expectedPrice,
  marketContext = {},
}) {
  ensureInitialized();

  validateRequiredFields({ windowId, strategyId, signalType, priceAtSignal }, [
    'windowId',
    'strategyId',
    'signalType',
    'priceAtSignal',
  ]);

  const signalDetectedAt = new Date().toISOString();

  const record = {
    event_type: TradeEventType.SIGNAL,
    window_id: windowId,
    strategy_id: strategyId,
    module: 'trade-event',
    signal_detected_at: signalDetectedAt,
    price_at_signal: priceAtSignal,
    expected_price: expectedPrice ?? null,
    bid_at_signal: marketContext.bidAtSignal ?? null,
    ask_at_signal: marketContext.askAtSignal ?? null,
    spread_at_signal: marketContext.spreadAtSignal ?? null,
    depth_at_signal: marketContext.depthAtSignal ?? null,
    level: 'info',
    event: `trade_signal_${signalType}`,
    notes: { signal_type: signalType },
  };

  const eventId = insertTradeEvent(record);

  // Log signal event via logger module
  log.info(`trade_signal_${signalType}`, {
    window_id: windowId,
    strategy_id: strategyId,
    price_at_signal: priceAtSignal,
    expected_price: expectedPrice,
    market_context: marketContext,
  });

  return eventId;
}

/**
 * Record an entry event when position is opened
 *
 * @param {Object} params - Entry parameters
 * @param {string} params.windowId - Window identifier
 * @param {number} params.positionId - Position identifier
 * @param {number} params.orderId - Order identifier
 * @param {string} params.strategyId - Strategy identifier
 * @param {Object} params.timestamps - Event timestamps
 * @param {string} params.timestamps.signalDetectedAt - ISO timestamp when signal detected
 * @param {string} params.timestamps.orderSubmittedAt - ISO timestamp when order submitted
 * @param {string} [params.timestamps.orderAckedAt] - ISO timestamp when order acknowledged
 * @param {string} [params.timestamps.orderFilledAt] - ISO timestamp when order filled
 * @param {Object} params.prices - Price data
 * @param {number} params.prices.priceAtSignal - Price when signal detected
 * @param {number} params.prices.priceAtSubmit - Price when order submitted
 * @param {number} params.prices.priceAtFill - Price when order filled
 * @param {number} params.prices.expectedPrice - Expected execution price
 * @param {Object} params.sizes - Size data
 * @param {number} params.sizes.requestedSize - Requested order size
 * @param {number} params.sizes.filledSize - Actual filled size
 * @param {Object} [params.marketContext] - Market context at signal
 * @returns {Promise<number>} Created event ID
 */
export async function recordEntry({
  windowId,
  positionId,
  orderId,
  strategyId,
  timestamps,
  prices,
  sizes,
  marketContext = {},
}) {
  ensureInitialized();

  validateRequiredFields({ windowId, positionId, orderId, strategyId }, [
    'windowId',
    'positionId',
    'orderId',
    'strategyId',
  ]);

  // Calculate latencies
  const latencies = calculateLatencies(timestamps);

  // Calculate slippage
  const slippage = calculateSlippage(prices);

  // Calculate size vs depth ratio
  const sizeVsDepthRatio = marketContext.depthAtSignal && sizes.requestedSize
    ? sizes.requestedSize / marketContext.depthAtSignal
    : null;

  // Detect diagnostic flags based on thresholds (Story 5.2 + 5.3)
  const config = getConfig() || {};
  const thresholds = config.tradeEvent?.thresholds || {};
  const eventForFlagDetection = {
    event_type: 'entry',
    latency_total_ms: latencies.latency_total_ms,
    latency_decision_to_submit_ms: latencies.latency_decision_to_submit_ms,
    latency_submit_to_ack_ms: latencies.latency_submit_to_ack_ms,
    latency_ack_to_fill_ms: latencies.latency_ack_to_fill_ms,
    slippage_vs_expected: slippage.slippage_vs_expected,
    slippage_signal_to_fill: slippage.slippage_signal_to_fill,
    expected_price: prices.expectedPrice,
    price_at_signal: prices.priceAtSignal,
    price_at_fill: prices.priceAtFill,
    size_vs_depth_ratio: sizeVsDepthRatio,
    requested_size: sizes.requestedSize,
    filled_size: sizes.filledSize,
  };

  // Use checkDivergence for comprehensive analysis (Story 5.3)
  const divergenceResult = checkDivergence(eventForFlagDetection, thresholds);
  const diagnosticFlags = divergenceResult.flags;

  // Determine log level based on divergence (Story 5.3: warn for divergence, info for normal)
  const hasSevereDivergence = divergenceResult.divergences.some(d => d.severity === 'error');
  const logLevel = hasSevereDivergence ? 'error' : (divergenceResult.hasDivergence ? 'warn' : 'info');

  const record = {
    event_type: TradeEventType.ENTRY,
    window_id: windowId,
    position_id: positionId,
    order_id: orderId,
    strategy_id: strategyId,
    module: 'trade-event',
    signal_detected_at: timestamps.signalDetectedAt ?? null,
    order_submitted_at: timestamps.orderSubmittedAt ?? null,
    order_acked_at: timestamps.orderAckedAt ?? null,
    order_filled_at: timestamps.orderFilledAt ?? null,
    ...latencies,
    price_at_signal: prices.priceAtSignal ?? null,
    price_at_submit: prices.priceAtSubmit ?? null,
    price_at_fill: prices.priceAtFill ?? null,
    expected_price: prices.expectedPrice ?? null,
    ...slippage,
    bid_at_signal: marketContext.bidAtSignal ?? null,
    ask_at_signal: marketContext.askAtSignal ?? null,
    spread_at_signal: marketContext.spreadAtSignal ?? null,
    depth_at_signal: marketContext.depthAtSignal ?? null,
    requested_size: sizes.requestedSize ?? null,
    filled_size: sizes.filledSize ?? null,
    size_vs_depth_ratio: sizeVsDepthRatio,
    diagnostic_flags: diagnosticFlags.length > 0 ? diagnosticFlags : null,
    level: logLevel,
    event: 'trade_entry',
  };

  const eventId = insertTradeEvent(record);

  // Log entry event with appropriate level based on divergence (Story 5.3)
  const logData = {
    window_id: windowId,
    position_id: positionId,
    expected: {
      price: prices.expectedPrice,
      size: sizes.requestedSize,
    },
    actual: {
      price: prices.priceAtFill,
      size: sizes.filledSize,
    },
    slippage: slippage.slippage_vs_expected,
    latency_ms: latencies.latency_total_ms,
    diagnostic_flags: diagnosticFlags.length > 0 ? diagnosticFlags : undefined,
  };

  if (logLevel === 'error') {
    log.error('trade_entry_divergence', logData, { strategy_id: strategyId });
  } else if (logLevel === 'warn') {
    log.warn('trade_entry_divergence', logData, { strategy_id: strategyId });
  } else {
    log.info('trade_entry', logData, { strategy_id: strategyId });
  }

  return eventId;
}

/**
 * Record an exit event when position is closed
 *
 * @param {Object} params - Exit parameters
 * @param {string} params.windowId - Window identifier
 * @param {number} params.positionId - Position identifier
 * @param {number} params.orderId - Order identifier
 * @param {string} params.strategyId - Strategy identifier
 * @param {string} params.exitReason - Reason for exit (stop_loss, take_profit, window_expiry, manual)
 * @param {Object} params.timestamps - Event timestamps
 * @param {Object} params.prices - Price data
 * @param {Object} [params.sizes] - Size data
 * @param {Object} [params.marketContext] - Market context at signal
 * @returns {Promise<number>} Created event ID
 */
export async function recordExit({
  windowId,
  positionId,
  orderId,
  strategyId,
  exitReason,
  timestamps,
  prices,
  sizes = {},
  marketContext = {},
}) {
  ensureInitialized();

  validateRequiredFields({ windowId, positionId, exitReason }, [
    'windowId',
    'positionId',
    'exitReason',
  ]);

  // Validate position exists
  if (!positionExists(positionId)) {
    throw new TradeEventError(
      TradeEventErrorCodes.POSITION_NOT_FOUND,
      `Position not found: ${positionId}`,
      { positionId }
    );
  }

  // Calculate latencies
  const latencies = calculateLatencies(timestamps || {});

  // Calculate slippage
  const slippage = calculateSlippage(prices || {});

  // Calculate size vs depth ratio
  const sizeVsDepthRatio = marketContext.depthAtSignal && sizes.requestedSize
    ? sizes.requestedSize / marketContext.depthAtSignal
    : null;

  // Detect diagnostic flags based on thresholds (Story 5.2 + 5.3)
  const config = getConfig() || {};
  const thresholds = config.tradeEvent?.thresholds || {};
  const eventForFlagDetection = {
    event_type: 'exit',
    latency_total_ms: latencies.latency_total_ms,
    latency_decision_to_submit_ms: latencies.latency_decision_to_submit_ms,
    latency_submit_to_ack_ms: latencies.latency_submit_to_ack_ms,
    latency_ack_to_fill_ms: latencies.latency_ack_to_fill_ms,
    slippage_vs_expected: slippage.slippage_vs_expected,
    slippage_signal_to_fill: slippage.slippage_signal_to_fill,
    expected_price: prices?.expectedPrice,
    price_at_signal: prices?.priceAtSignal,
    price_at_fill: prices?.priceAtFill,
    size_vs_depth_ratio: sizeVsDepthRatio,
    requested_size: sizes.requestedSize,
    filled_size: sizes.filledSize,
  };

  // Use checkDivergence for comprehensive analysis (Story 5.3)
  const divergenceResult = checkDivergence(eventForFlagDetection, thresholds);
  const diagnosticFlags = divergenceResult.flags;

  // Determine log level based on divergence (Story 5.3: warn for divergence, info for normal)
  const hasSevereDivergence = divergenceResult.divergences.some(d => d.severity === 'error');
  const logLevel = hasSevereDivergence ? 'error' : (divergenceResult.hasDivergence ? 'warn' : 'info');

  const record = {
    event_type: TradeEventType.EXIT,
    window_id: windowId,
    position_id: positionId,
    order_id: orderId ?? null,
    strategy_id: strategyId ?? null,
    module: 'trade-event',
    signal_detected_at: timestamps?.signalDetectedAt ?? null,
    order_submitted_at: timestamps?.orderSubmittedAt ?? null,
    order_acked_at: timestamps?.orderAckedAt ?? null,
    order_filled_at: timestamps?.orderFilledAt ?? null,
    ...latencies,
    price_at_signal: prices?.priceAtSignal ?? null,
    price_at_submit: prices?.priceAtSubmit ?? null,
    price_at_fill: prices?.priceAtFill ?? null,
    expected_price: prices?.expectedPrice ?? null,
    ...slippage,
    bid_at_signal: marketContext.bidAtSignal ?? null,
    ask_at_signal: marketContext.askAtSignal ?? null,
    spread_at_signal: marketContext.spreadAtSignal ?? null,
    depth_at_signal: marketContext.depthAtSignal ?? null,
    requested_size: sizes.requestedSize ?? null,
    filled_size: sizes.filledSize ?? null,
    size_vs_depth_ratio: sizeVsDepthRatio,
    diagnostic_flags: diagnosticFlags.length > 0 ? diagnosticFlags : null,
    level: logLevel,
    event: 'trade_exit',
    notes: { exit_reason: exitReason },
  };

  const eventId = insertTradeEvent(record);

  // Log exit event with appropriate level based on divergence (Story 5.3)
  const logData = {
    window_id: windowId,
    position_id: positionId,
    exit_reason: exitReason,
    expected: {
      price: prices?.expectedPrice,
      size: sizes.requestedSize,
    },
    actual: {
      price: prices?.priceAtFill,
      size: sizes.filledSize,
    },
    slippage: slippage.slippage_vs_expected,
    latency_ms: latencies.latency_total_ms,
    diagnostic_flags: diagnosticFlags.length > 0 ? diagnosticFlags : undefined,
  };

  if (logLevel === 'error') {
    log.error('trade_exit_divergence', logData, { strategy_id: strategyId });
  } else if (logLevel === 'warn') {
    log.warn('trade_exit_divergence', logData, { strategy_id: strategyId });
  } else {
    log.info('trade_exit', logData, { strategy_id: strategyId });
  }

  return eventId;
}

/**
 * Record an alert event for divergence or error conditions
 *
 * @param {Object} params - Alert parameters
 * @param {string} params.windowId - Window identifier
 * @param {number} [params.positionId] - Position identifier (if applicable)
 * @param {string} params.alertType - Type of alert (divergence, error, warning)
 * @param {Object} params.data - Alert data
 * @param {string} [params.level='warn'] - Log level (warn or error)
 * @param {string[]} [params.diagnosticFlags] - Diagnostic flags for pattern detection
 * @returns {Promise<number>} Created event ID
 */
export async function recordAlert({
  windowId,
  positionId,
  alertType,
  data,
  level = 'warn',
  diagnosticFlags = [],
}) {
  ensureInitialized();

  validateRequiredFields({ windowId, alertType, data }, [
    'windowId',
    'alertType',
    'data',
  ]);

  // Validate level
  const validLevel = level === 'error' ? 'error' : 'warn';

  const record = {
    event_type: alertType === 'divergence' ? TradeEventType.DIVERGENCE : TradeEventType.ALERT,
    window_id: windowId,
    position_id: positionId ?? null,
    module: 'trade-event',
    level: validLevel,
    event: `trade_alert_${alertType}`,
    diagnostic_flags: diagnosticFlags.length > 0 ? diagnosticFlags : null,
    notes: data,
  };

  const eventId = insertTradeEvent(record);

  // Log alert event with full diagnostic context
  const logFn = validLevel === 'error' ? log.error : log.warn;
  logFn(`trade_alert_${alertType}`, {
    window_id: windowId,
    position_id: positionId,
    alert_type: alertType,
    data,
    diagnostic_flags: diagnosticFlags,
  });

  return eventId;
}

/**
 * Get events with optional filters
 *
 * @param {Object} [options] - Query options
 * @param {number} [options.limit=100] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @param {string} [options.eventType] - Filter by event type
 * @param {string} [options.level] - Filter by log level
 * @returns {Promise<Object[]>} Array of event records
 */
export async function getEvents(options = {}) {
  ensureInitialized();
  return queryEvents(options);
}

/**
 * Get events by window ID
 *
 * @param {string} windowId - Window identifier
 * @returns {Promise<Object[]>} Array of event records for the window
 */
export async function getEventsByWindow(windowId) {
  ensureInitialized();

  if (!windowId) {
    throw new TradeEventError(
      TradeEventErrorCodes.MISSING_REQUIRED_FIELD,
      'Missing required field: windowId',
      { field: 'windowId' }
    );
  }

  return queryEventsByWindow(windowId);
}

/**
 * Get events by position ID
 *
 * @param {number} positionId - Position identifier
 * @returns {Promise<Object[]>} Array of event records for the position
 */
export async function getEventsByPosition(positionId) {
  ensureInitialized();

  if (positionId === undefined || positionId === null) {
    throw new TradeEventError(
      TradeEventErrorCodes.MISSING_REQUIRED_FIELD,
      'Missing required field: positionId',
      { field: 'positionId' }
    );
  }

  return queryEventsByPosition(positionId);
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY ANALYSIS FUNCTIONS (Story 5.2, AC5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get latency statistics with optional filters
 *
 * Returns min/max/avg/p95 latency metrics grouped by latency component
 * (decision→submit, submit→ack, ack→fill, total).
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {string} [options.timeRange.startDate] - Start date (ISO string)
 * @param {string} [options.timeRange.endDate] - End date (ISO string)
 * @returns {Object} Latency statistics including min/max/avg/p95
 */
export function getLatencyStats(options = {}) {
  ensureInitialized();

  // Get basic stats (min/max/avg)
  const stats = queryLatencyStats(options);

  // Get p95 values
  const p95 = calculateP95Latency(options);

  // Merge p95 into stats structure
  return {
    count: stats.count,
    total: {
      ...stats.total,
      p95: p95.total,
    },
    decisionToSubmit: {
      ...stats.decisionToSubmit,
      p95: p95.decisionToSubmit,
    },
    submitToAck: {
      ...stats.submitToAck,
      p95: p95.submitToAck,
    },
    ackToFill: {
      ...stats.ackToFill,
      p95: p95.ackToFill,
    },
  };
}

/**
 * Get detailed latency breakdown for a single event
 *
 * @param {number} eventId - Event ID
 * @returns {Object|null} Latency breakdown or null if event not found
 */
export function getLatencyBreakdownById(eventId) {
  ensureInitialized();

  if (eventId === undefined || eventId === null) {
    throw new TradeEventError(
      TradeEventErrorCodes.MISSING_REQUIRED_FIELD,
      'Missing required field: eventId',
      { field: 'eventId' }
    );
  }

  return getLatencyBreakdown(eventId);
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIPPAGE ANALYSIS FUNCTIONS (Story 5.2, AC6)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get slippage statistics with optional filters
 *
 * Returns min/max/avg slippage metrics for both absolute values and
 * percentages of expected price.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {string} [options.timeRange.startDate] - Start date (ISO string)
 * @param {string} [options.timeRange.endDate] - End date (ISO string)
 * @returns {Object} Slippage statistics
 */
export function getSlippageStats(options = {}) {
  ensureInitialized();
  return querySlippageStats(options);
}

/**
 * Get slippage correlation with order size
 *
 * Groups slippage by size buckets (small/medium/large) to identify
 * if larger orders experience more slippage.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {Object} [options.sizeBuckets] - Size bucket thresholds
 * @returns {Object[]} Slippage grouped by size bucket
 */
export function getSlippageBySize(options = {}) {
  ensureInitialized();
  return querySlippageBySize(options);
}

/**
 * Get slippage correlation with spread at signal time
 *
 * Groups slippage by spread buckets to identify if wider spreads
 * correlate with more slippage.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {Object} [options.spreadBuckets] - Spread bucket thresholds
 * @returns {Object[]} Slippage grouped by spread bucket
 */
export function getSlippageBySpread(options = {}) {
  ensureInitialized();
  return querySlippageBySpread(options);
}

// ═══════════════════════════════════════════════════════════════════════════
// DIVERGENCE DETECTION FUNCTIONS (Story 5.3, AC7)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check a trade event for all types of divergence
 *
 * Runs all divergence checks and returns structured results with
 * flags, severity levels, and diagnostic details.
 *
 * @param {Object} event - Trade event with all metrics
 * @param {Object} [thresholds] - Optional threshold overrides (uses config defaults)
 * @returns {Object} Divergence check result
 * @returns {boolean} result.hasDivergence - True if any divergence detected
 * @returns {string[]} result.flags - Array of divergence flag names
 * @returns {Object[]} result.divergences - Array of divergence details
 */
export function getDivergenceCheck(event, thresholds) {
  ensureInitialized();
  const config = getConfig() || {};
  const configThresholds = thresholds || config.tradeEvent?.thresholds || {};
  return checkDivergence(event, configThresholds);
}

/**
 * Query events that have divergence flags
 *
 * Filters trade events to find those with diagnostic_flags set,
 * indicating some form of divergence was detected.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {string[]} [options.flags] - Filter by specific flag types
 * @returns {Object[]} Events with divergence
 */
export function getDivergentEvents(options = {}) {
  ensureInitialized();
  return queryDivergentEvents(options);
}

/**
 * Get summary of divergence occurrences
 *
 * Aggregates divergence flags across events to provide counts and rates
 * for each divergence type.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @returns {Object} Summary with counts per divergence type
 */
export function getDivergenceSummary(options = {}) {
  ensureInitialized();
  return queryDivergenceSummary(options);
}

/**
 * Detect state divergence between local and exchange state
 *
 * Compares position state from local database with state from exchange API
 * to identify any mismatches. Useful for reconciliation checks.
 *
 * @param {Object} localState - Position state from local database
 * @param {Object} exchangeState - Position state from exchange API
 * @returns {Object|null} Divergence details or null if no divergence
 */
export function getStateDivergence(localState, exchangeState) {
  ensureInitialized();
  return detectStateDivergence(localState, exchangeState);
}

/**
 * Get current module state
 *
 * Returns initialization status, stats, and divergence summary.
 *
 * @returns {Object} Current state including initialization status, stats, and divergence summary
 */
export function getState() {
  const baseState = getStateSnapshot();

  // Add divergence stats if initialized (Story 5.3)
  if (baseState.initialized) {
    try {
      const divergenceSummary = queryDivergenceSummary();
      return {
        ...baseState,
        divergence: {
          eventsWithDivergence: divergenceSummary.eventsWithDivergence,
          divergenceRate: divergenceSummary.divergenceRate,
          flagCounts: divergenceSummary.flagCounts,
        },
      };
    } catch {
      // If query fails (e.g., database not ready), return base state
      return baseState;
    }
  }

  return baseState;
}

/**
 * Shutdown the module gracefully
 *
 * @returns {Promise<void>}
 */
export async function shutdown() {
  if (log) {
    log.info('module_shutdown_start');
  }

  resetState();

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

/**
 * Internal: Ensure module is initialized
 * @throws {TradeEventError} If not initialized
 */
function ensureInitialized() {
  if (!isInitialized()) {
    throw new TradeEventError(
      TradeEventErrorCodes.NOT_INITIALIZED,
      'Trade event module not initialized. Call init() first.',
      {}
    );
  }
}

// Re-export types and constants
export { TradeEventError, TradeEventErrorCodes, TradeEventType } from './types.js';
