/**
 * Trade log type definitions for poly trading system
 *
 * Defines the structured JSON log schema used for all trade events.
 * Every log entry must include required fields for diagnostic coverage.
 */

/**
 * Log level values
 * @readonly
 * @enum {string}
 */
export const LogLevel = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

/**
 * Event type values for trade events
 * @readonly
 * @enum {string}
 */
export const EventType = {
  SIGNAL: 'signal',
  ENTRY: 'entry',
  EXIT: 'exit',
  ALERT: 'alert',
  DIVERGENCE: 'divergence',
};

/**
 * Create a structured log entry
 *
 * Required fields: timestamp, level, module, event
 * Optional fields: data, context, error
 *
 * @param {Object} params - Log parameters
 * @param {string} params.level - Log level (info, warn, error)
 * @param {string} params.module - Module name (e.g., 'position-manager')
 * @param {string} params.event - Event name (e.g., 'position_opened')
 * @param {Object} [params.data] - Event data with expected/actual values
 * @param {Object} [params.context] - Additional context
 * @param {Object} [params.error] - Error details if applicable
 * @returns {Object} Structured log entry
 */
export function createLogEntry({
  level,
  module,
  event,
  data = null,
  context = null,
  error = null,
}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    event,
  };

  if (data !== null) {
    entry.data = data;
  }

  if (context !== null) {
    entry.context = context;
  }

  if (error !== null) {
    entry.error = error;
  }

  return entry;
}

/**
 * Create a trade event record for database storage
 *
 * Includes explicit columns for latency and slippage analysis.
 *
 * @param {Object} params - Trade event parameters
 * @returns {Object} Trade event record
 */
export function createTradeEvent({
  eventType,
  windowId,
  positionId = null,
  orderId = null,
  strategyId = null,
  module,
  level = LogLevel.INFO,
  event,
  // Timestamps
  signalDetectedAt = null,
  orderSubmittedAt = null,
  orderAckedAt = null,
  orderFilledAt = null,
  // Prices
  priceAtSignal = null,
  priceAtSubmit = null,
  priceAtFill = null,
  expectedPrice = null,
  // Market context
  bidAtSignal = null,
  askAtSignal = null,
  depthAtSignal = null,
  // Size
  requestedSize = null,
  filledSize = null,
  // Diagnostics
  diagnosticFlags = [],
  notes = null,
}) {
  // Calculate latencies if timestamps available
  let latencyDecisionToSubmitMs = null;
  let latencySubmitToAckMs = null;
  let latencyAckToFillMs = null;
  let latencyTotalMs = null;

  if (signalDetectedAt && orderSubmittedAt) {
    latencyDecisionToSubmitMs = new Date(orderSubmittedAt) - new Date(signalDetectedAt);
  }
  if (orderSubmittedAt && orderAckedAt) {
    latencySubmitToAckMs = new Date(orderAckedAt) - new Date(orderSubmittedAt);
  }
  if (orderAckedAt && orderFilledAt) {
    latencyAckToFillMs = new Date(orderFilledAt) - new Date(orderAckedAt);
  }
  if (signalDetectedAt && orderFilledAt) {
    latencyTotalMs = new Date(orderFilledAt) - new Date(signalDetectedAt);
  }

  // Calculate slippage if prices available
  let slippageSignalToFill = null;
  let slippageVsExpected = null;

  if (priceAtSignal !== null && priceAtFill !== null) {
    slippageSignalToFill = priceAtFill - priceAtSignal;
  }
  if (expectedPrice !== null && priceAtFill !== null) {
    slippageVsExpected = priceAtFill - expectedPrice;
  }

  // Calculate spread and size ratio
  let spreadAtSignal = null;
  let sizeVsDepthRatio = null;

  if (bidAtSignal !== null && askAtSignal !== null) {
    spreadAtSignal = askAtSignal - bidAtSignal;
  }
  if (requestedSize !== null && depthAtSignal !== null && depthAtSignal > 0) {
    sizeVsDepthRatio = requestedSize / depthAtSignal;
  }

  return {
    event_type: eventType,
    window_id: windowId,
    position_id: positionId,
    order_id: orderId,
    strategy_id: strategyId,
    module,
    // Timestamps
    signal_detected_at: signalDetectedAt,
    order_submitted_at: orderSubmittedAt,
    order_acked_at: orderAckedAt,
    order_filled_at: orderFilledAt,
    // Computed latencies
    latency_decision_to_submit_ms: latencyDecisionToSubmitMs,
    latency_submit_to_ack_ms: latencySubmitToAckMs,
    latency_ack_to_fill_ms: latencyAckToFillMs,
    latency_total_ms: latencyTotalMs,
    // Prices
    price_at_signal: priceAtSignal,
    price_at_submit: priceAtSubmit,
    price_at_fill: priceAtFill,
    expected_price: expectedPrice,
    // Computed slippage
    slippage_signal_to_fill: slippageSignalToFill,
    slippage_vs_expected: slippageVsExpected,
    // Market context
    bid_at_signal: bidAtSignal,
    ask_at_signal: askAtSignal,
    spread_at_signal: spreadAtSignal,
    depth_at_signal: depthAtSignal,
    // Size
    requested_size: requestedSize,
    filled_size: filledSize,
    size_vs_depth_ratio: sizeVsDepthRatio,
    // Diagnostic
    level,
    event,
    diagnostic_flags: JSON.stringify(diagnosticFlags),
    notes: notes ? JSON.stringify(notes) : null,
  };
}

/**
 * Validate a log entry has required fields
 * @param {Object} entry - Log entry to validate
 * @returns {boolean} True if valid
 * @throws {Error} If validation fails
 */
export function validateLogEntry(entry) {
  const required = ['timestamp', 'level', 'module', 'event'];

  for (const field of required) {
    if (entry[field] === undefined || entry[field] === null) {
      throw new Error(`Log entry missing required field: ${field}`);
    }
  }

  if (!Object.values(LogLevel).includes(entry.level)) {
    throw new Error(`Invalid log level: ${entry.level}`);
  }

  return true;
}

