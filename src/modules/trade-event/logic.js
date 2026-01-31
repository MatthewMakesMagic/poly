/**
 * Trade Event Logic
 *
 * Core business logic for recording trade events.
 * Handles slippage and latency calculations, database operations, and logging.
 */

import { run, get, all } from '../../persistence/database.js';
import { TradeEventType, TradeEventError, TradeEventErrorCodes } from './types.js';
import { incrementEventCount } from './state.js';
import { child } from '../logger/index.js';

// Module-level logger for alert functions
let alertLog = null;

/**
 * Parse and validate an ISO timestamp string
 * @param {string} timestamp - ISO timestamp string
 * @returns {number|null} Milliseconds since epoch, or null if invalid/missing
 */
function parseTimestamp(timestamp) {
  if (!timestamp) return null;
  const ms = new Date(timestamp).getTime();
  // Check for Invalid Date (NaN)
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Calculate latencies from timestamps
 * @param {Object} timestamps - Timestamp object
 * @param {string} timestamps.signalDetectedAt - ISO timestamp when signal detected
 * @param {string} timestamps.orderSubmittedAt - ISO timestamp when order submitted
 * @param {string} [timestamps.orderAckedAt] - ISO timestamp when order acknowledged
 * @param {string} [timestamps.orderFilledAt] - ISO timestamp when order filled
 * @returns {Object} Calculated latencies in milliseconds
 */
export function calculateLatencies(timestamps) {
  const { signalDetectedAt, orderSubmittedAt, orderAckedAt, orderFilledAt } = timestamps;

  // Parse and validate ISO timestamps to milliseconds
  const signalMs = parseTimestamp(signalDetectedAt);
  const submitMs = parseTimestamp(orderSubmittedAt);
  const ackMs = parseTimestamp(orderAckedAt);
  const fillMs = parseTimestamp(orderFilledAt);

  return {
    latency_decision_to_submit_ms: signalMs && submitMs ? submitMs - signalMs : null,
    latency_submit_to_ack_ms: submitMs && ackMs ? ackMs - submitMs : null,
    latency_ack_to_fill_ms: ackMs && fillMs ? fillMs - ackMs : null,
    latency_total_ms: signalMs && fillMs ? fillMs - signalMs : null,
  };
}

/**
 * Calculate slippage values
 * @param {Object} prices - Price object
 * @param {number} prices.priceAtSignal - Price when signal detected
 * @param {number} prices.priceAtFill - Price when order filled
 * @param {number} prices.expectedPrice - Expected execution price
 * @returns {Object} Calculated slippage values
 */
export function calculateSlippage(prices) {
  const { priceAtSignal, priceAtFill, expectedPrice } = prices;

  return {
    slippage_signal_to_fill: priceAtFill != null && priceAtSignal != null
      ? priceAtFill - priceAtSignal
      : null,
    slippage_vs_expected: priceAtFill != null && expectedPrice != null
      ? priceAtFill - expectedPrice
      : null,
  };
}

/**
 * Insert a trade event record into the database
 * @param {Object} record - Trade event record
 * @returns {number} Inserted event ID
 */
export function insertTradeEvent(record) {
  const result = run(`
    INSERT INTO trade_events (
      event_type, window_id, position_id, order_id, strategy_id, module,
      signal_detected_at, order_submitted_at, order_acked_at, order_filled_at,
      latency_decision_to_submit_ms, latency_submit_to_ack_ms, latency_ack_to_fill_ms, latency_total_ms,
      price_at_signal, price_at_submit, price_at_fill, expected_price,
      slippage_signal_to_fill, slippage_vs_expected,
      bid_at_signal, ask_at_signal, spread_at_signal, depth_at_signal,
      requested_size, filled_size, size_vs_depth_ratio,
      level, event, diagnostic_flags, notes
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
    )
  `, [
    record.event_type,
    record.window_id,
    record.position_id ?? null,
    record.order_id ?? null,
    record.strategy_id ?? null,
    record.module,
    record.signal_detected_at ?? null,
    record.order_submitted_at ?? null,
    record.order_acked_at ?? null,
    record.order_filled_at ?? null,
    record.latency_decision_to_submit_ms ?? null,
    record.latency_submit_to_ack_ms ?? null,
    record.latency_ack_to_fill_ms ?? null,
    record.latency_total_ms ?? null,
    record.price_at_signal ?? null,
    record.price_at_submit ?? null,
    record.price_at_fill ?? null,
    record.expected_price ?? null,
    record.slippage_signal_to_fill ?? null,
    record.slippage_vs_expected ?? null,
    record.bid_at_signal ?? null,
    record.ask_at_signal ?? null,
    record.spread_at_signal ?? null,
    record.depth_at_signal ?? null,
    record.requested_size ?? null,
    record.filled_size ?? null,
    record.size_vs_depth_ratio ?? null,
    record.level,
    record.event,
    record.diagnostic_flags ? JSON.stringify(record.diagnostic_flags) : null,
    record.notes ? JSON.stringify(record.notes) : null,
  ]);

  incrementEventCount(record.event_type);
  return result.lastInsertRowid;
}

/**
 * Get a single event by ID
 * @param {number} eventId - Event ID
 * @returns {Object|undefined} Event record or undefined
 */
export function getEventById(eventId) {
  const event = get('SELECT * FROM trade_events WHERE id = ?', [eventId]);
  if (event) {
    // Parse JSON fields
    if (event.diagnostic_flags) {
      event.diagnostic_flags = JSON.parse(event.diagnostic_flags);
    }
    if (event.notes) {
      event.notes = JSON.parse(event.notes);
    }
  }
  return event;
}

/**
 * Query events with filters
 * @param {Object} options - Query options
 * @param {number} [options.limit=100] - Maximum number of results
 * @param {number} [options.offset=0] - Offset for pagination
 * @param {string} [options.eventType] - Filter by event type
 * @param {string} [options.level] - Filter by log level
 * @returns {Object[]} Array of event records
 */
export function queryEvents({ limit = 100, offset = 0, eventType, level } = {}) {
  let sql = 'SELECT * FROM trade_events WHERE 1=1';
  const params = [];

  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }

  if (level) {
    sql += ' AND level = ?';
    params.push(level);
  }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const events = all(sql, params);
  return events.map(event => {
    if (event.diagnostic_flags) {
      event.diagnostic_flags = JSON.parse(event.diagnostic_flags);
    }
    if (event.notes) {
      event.notes = JSON.parse(event.notes);
    }
    return event;
  });
}

/**
 * Get events by window ID
 * @param {string} windowId - Window identifier
 * @returns {Object[]} Array of event records for the window
 */
export function queryEventsByWindow(windowId) {
  const events = all(
    'SELECT * FROM trade_events WHERE window_id = ? ORDER BY id ASC',
    [windowId]
  );
  return events.map(event => {
    if (event.diagnostic_flags) {
      event.diagnostic_flags = JSON.parse(event.diagnostic_flags);
    }
    if (event.notes) {
      event.notes = JSON.parse(event.notes);
    }
    return event;
  });
}

/**
 * Get events by position ID
 * @param {number} positionId - Position identifier
 * @returns {Object[]} Array of event records for the position
 */
export function queryEventsByPosition(positionId) {
  const events = all(
    'SELECT * FROM trade_events WHERE position_id = ? ORDER BY id ASC',
    [positionId]
  );
  return events.map(event => {
    if (event.diagnostic_flags) {
      event.diagnostic_flags = JSON.parse(event.diagnostic_flags);
    }
    if (event.notes) {
      event.notes = JSON.parse(event.notes);
    }
    return event;
  });
}

/**
 * Validate required fields for an event
 * @param {Object} fields - Fields to validate
 * @param {string[]} required - Required field names
 * @throws {TradeEventError} If required field is missing
 */
export function validateRequiredFields(fields, required) {
  for (const field of required) {
    if (fields[field] === undefined || fields[field] === null) {
      throw new TradeEventError(
        TradeEventErrorCodes.MISSING_REQUIRED_FIELD,
        `Missing required field: ${field}`,
        { field }
      );
    }
  }
}

/**
 * Check if a position exists
 * @param {number} positionId - Position ID to check
 * @returns {boolean} True if position exists
 */
export function positionExists(positionId) {
  const result = get('SELECT id FROM positions WHERE id = ?', [positionId]);
  return result !== undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// LATENCY ANALYSIS FUNCTIONS (Story 5.2, AC5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get latency statistics with optional filters
 *
 * Returns min/max/avg latency metrics grouped by latency component.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {string} [options.timeRange.startDate] - Start date (ISO string)
 * @param {string} [options.timeRange.endDate] - End date (ISO string)
 * @returns {Object} Latency statistics
 */
export function queryLatencyStats({ windowId, strategyId, timeRange } = {}) {
  let sql = `
    SELECT
      COUNT(*) as count,
      MIN(latency_total_ms) as min_total_ms,
      MAX(latency_total_ms) as max_total_ms,
      AVG(latency_total_ms) as avg_total_ms,
      MIN(latency_decision_to_submit_ms) as min_decision_to_submit_ms,
      MAX(latency_decision_to_submit_ms) as max_decision_to_submit_ms,
      AVG(latency_decision_to_submit_ms) as avg_decision_to_submit_ms,
      MIN(latency_submit_to_ack_ms) as min_submit_to_ack_ms,
      MAX(latency_submit_to_ack_ms) as max_submit_to_ack_ms,
      AVG(latency_submit_to_ack_ms) as avg_submit_to_ack_ms,
      MIN(latency_ack_to_fill_ms) as min_ack_to_fill_ms,
      MAX(latency_ack_to_fill_ms) as max_ack_to_fill_ms,
      AVG(latency_ack_to_fill_ms) as avg_ack_to_fill_ms
    FROM trade_events
    WHERE latency_total_ms IS NOT NULL
  `;
  const params = [];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  const result = get(sql, params);

  // Return structured result with null handling
  return {
    count: result?.count || 0,
    total: {
      min: result?.min_total_ms ?? null,
      max: result?.max_total_ms ?? null,
      avg: result?.avg_total_ms ?? null,
    },
    decisionToSubmit: {
      min: result?.min_decision_to_submit_ms ?? null,
      max: result?.max_decision_to_submit_ms ?? null,
      avg: result?.avg_decision_to_submit_ms ?? null,
    },
    submitToAck: {
      min: result?.min_submit_to_ack_ms ?? null,
      max: result?.max_submit_to_ack_ms ?? null,
      avg: result?.avg_submit_to_ack_ms ?? null,
    },
    ackToFill: {
      min: result?.min_ack_to_fill_ms ?? null,
      max: result?.max_ack_to_fill_ms ?? null,
      avg: result?.avg_ack_to_fill_ms ?? null,
    },
  };
}

/**
 * Calculate p95 latency values
 *
 * Uses JavaScript for percentile calculation as SQLite doesn't have native percentile functions.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @returns {Object} P95 latency values for each component
 */
export function calculateP95Latency({ windowId, strategyId, timeRange } = {}) {
  let sql = `
    SELECT
      latency_total_ms,
      latency_decision_to_submit_ms,
      latency_submit_to_ack_ms,
      latency_ack_to_fill_ms
    FROM trade_events
    WHERE latency_total_ms IS NOT NULL
  `;
  const params = [];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  const events = all(sql, params);

  if (events.length === 0) {
    return {
      total: null,
      decisionToSubmit: null,
      submitToAck: null,
      ackToFill: null,
    };
  }

  // Helper to calculate p95 from an array
  const calcP95 = (values) => {
    const filtered = values.filter(v => v !== null).sort((a, b) => a - b);
    if (filtered.length === 0) return null;
    const p95Index = Math.ceil(filtered.length * 0.95) - 1;
    return filtered[Math.max(0, p95Index)];
  };

  return {
    total: calcP95(events.map(e => e.latency_total_ms)),
    decisionToSubmit: calcP95(events.map(e => e.latency_decision_to_submit_ms)),
    submitToAck: calcP95(events.map(e => e.latency_submit_to_ack_ms)),
    ackToFill: calcP95(events.map(e => e.latency_ack_to_fill_ms)),
  };
}

/**
 * Get detailed latency breakdown for a single event
 *
 * @param {number} eventId - Event ID
 * @returns {Object|null} Latency breakdown or null if event not found
 */
export function getLatencyBreakdown(eventId) {
  const event = get(`
    SELECT
      id,
      window_id,
      strategy_id,
      signal_detected_at,
      order_submitted_at,
      order_acked_at,
      order_filled_at,
      latency_decision_to_submit_ms,
      latency_submit_to_ack_ms,
      latency_ack_to_fill_ms,
      latency_total_ms
    FROM trade_events
    WHERE id = ?
  `, [eventId]);

  if (!event) {
    return null;
  }

  return {
    eventId: event.id,
    windowId: event.window_id,
    strategyId: event.strategy_id,
    timestamps: {
      signalDetectedAt: event.signal_detected_at,
      orderSubmittedAt: event.order_submitted_at,
      orderAckedAt: event.order_acked_at,
      orderFilledAt: event.order_filled_at,
    },
    latencies: {
      decisionToSubmit: event.latency_decision_to_submit_ms,
      submitToAck: event.latency_submit_to_ack_ms,
      ackToFill: event.latency_ack_to_fill_ms,
      total: event.latency_total_ms,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIPPAGE ANALYSIS FUNCTIONS (Story 5.2, AC6)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get slippage statistics with optional filters
 *
 * Returns min/max/avg slippage metrics for both signal-to-fill and vs-expected.
 *
 * @param {Object} options - Query options
 * @param {string} [options.windowId] - Filter by window ID
 * @param {string} [options.strategyId] - Filter by strategy ID
 * @param {Object} [options.timeRange] - Time range filter
 * @param {string} [options.timeRange.startDate] - Start date (ISO string)
 * @param {string} [options.timeRange.endDate] - End date (ISO string)
 * @returns {Object} Slippage statistics
 */
export function querySlippageStats({ windowId, strategyId, timeRange } = {}) {
  let sql = `
    SELECT
      COUNT(*) as count,
      MIN(slippage_signal_to_fill) as min_signal_to_fill,
      MAX(slippage_signal_to_fill) as max_signal_to_fill,
      AVG(slippage_signal_to_fill) as avg_signal_to_fill,
      MIN(slippage_vs_expected) as min_vs_expected,
      MAX(slippage_vs_expected) as max_vs_expected,
      AVG(slippage_vs_expected) as avg_vs_expected,
      AVG(expected_price) as avg_expected_price
    FROM trade_events
    WHERE (slippage_signal_to_fill IS NOT NULL OR slippage_vs_expected IS NOT NULL)
      AND event_type IN ('entry', 'exit')
  `;
  const params = [];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  const result = get(sql, params);

  // Calculate percentage-based stats if we have expected price
  const avgExpectedPrice = result?.avg_expected_price ?? null;

  return {
    count: result?.count || 0,
    signalToFill: {
      min: result?.min_signal_to_fill ?? null,
      max: result?.max_signal_to_fill ?? null,
      avg: result?.avg_signal_to_fill ?? null,
    },
    vsExpected: {
      min: result?.min_vs_expected ?? null,
      max: result?.max_vs_expected ?? null,
      avg: result?.avg_vs_expected ?? null,
      // Percentage of expected price (for summary reporting)
      avgPct: avgExpectedPrice && result?.avg_vs_expected
        ? result.avg_vs_expected / avgExpectedPrice
        : null,
    },
  };
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
 * @param {number} [options.sizeBuckets.small=50] - Max size for 'small' bucket
 * @param {number} [options.sizeBuckets.medium=200] - Max size for 'medium' bucket
 * @returns {Object[]} Slippage grouped by size bucket
 */
export function querySlippageBySize({ windowId, strategyId, timeRange, sizeBuckets } = {}) {
  const smallMax = sizeBuckets?.small ?? 50;
  const mediumMax = sizeBuckets?.medium ?? 200;

  let sql = `
    SELECT
      CASE
        WHEN requested_size < ? THEN 'small'
        WHEN requested_size < ? THEN 'medium'
        ELSE 'large'
      END as size_bucket,
      COUNT(*) as count,
      AVG(slippage_vs_expected) as avg_slippage,
      AVG(requested_size) as avg_size,
      MIN(slippage_vs_expected) as min_slippage,
      MAX(slippage_vs_expected) as max_slippage
    FROM trade_events
    WHERE requested_size IS NOT NULL
      AND slippage_vs_expected IS NOT NULL
      AND event_type IN ('entry', 'exit')
  `;
  const params = [smallMax, mediumMax];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  sql += ' GROUP BY size_bucket ORDER BY avg_size';

  const results = all(sql, params);

  return results.map(row => ({
    sizeBucket: row.size_bucket,
    count: row.count,
    avgSize: row.avg_size,
    slippage: {
      avg: row.avg_slippage,
      min: row.min_slippage,
      max: row.max_slippage,
    },
  }));
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
 * @param {number} [options.spreadBuckets.tight=0.01] - Max spread for 'tight' bucket
 * @param {number} [options.spreadBuckets.normal=0.03] - Max spread for 'normal' bucket
 * @returns {Object[]} Slippage grouped by spread bucket
 */
export function querySlippageBySpread({ windowId, strategyId, timeRange, spreadBuckets } = {}) {
  const tightMax = spreadBuckets?.tight ?? 0.01;
  const normalMax = spreadBuckets?.normal ?? 0.03;

  let sql = `
    SELECT
      CASE
        WHEN spread_at_signal < ? THEN 'tight'
        WHEN spread_at_signal < ? THEN 'normal'
        ELSE 'wide'
      END as spread_bucket,
      COUNT(*) as count,
      AVG(slippage_vs_expected) as avg_slippage,
      AVG(spread_at_signal) as avg_spread,
      MIN(slippage_vs_expected) as min_slippage,
      MAX(slippage_vs_expected) as max_slippage
    FROM trade_events
    WHERE spread_at_signal IS NOT NULL
      AND slippage_vs_expected IS NOT NULL
      AND event_type IN ('entry', 'exit')
  `;
  const params = [tightMax, normalMax];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  sql += ' GROUP BY spread_bucket ORDER BY avg_spread';

  const results = all(sql, params);

  return results.map(row => ({
    spreadBucket: row.spread_bucket,
    count: row.count,
    avgSpread: row.avg_spread,
    slippage: {
      avg: row.avg_slippage,
      min: row.min_slippage,
      max: row.max_slippage,
    },
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// THRESHOLD DETECTION FUNCTIONS (Story 5.2, AC8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect diagnostic flags based on threshold violations
 *
 * Checks latency, slippage, size impact, and other divergence types against
 * configurable thresholds and returns an array of flags indicating which
 * thresholds were exceeded.
 *
 * @param {Object} event - Event data with latency, slippage, and size metrics
 * @param {number} [event.latency_total_ms] - Total latency in milliseconds
 * @param {number} [event.latency_decision_to_submit_ms] - Latency from decision to submit
 * @param {number} [event.latency_submit_to_ack_ms] - Latency from submit to ack
 * @param {number} [event.latency_ack_to_fill_ms] - Latency from ack to fill
 * @param {number} [event.slippage_vs_expected] - Slippage vs expected price
 * @param {number} [event.slippage_signal_to_fill] - Price movement from signal to fill
 * @param {number} [event.expected_price] - Expected execution price
 * @param {number} [event.price_at_signal] - Price when signal was detected
 * @param {string} [event.event_type] - Type of event (entry, exit, signal)
 * @param {number} [event.size_vs_depth_ratio] - Ratio of order size to available depth
 * @param {number} [event.requested_size] - Requested order size
 * @param {number} [event.filled_size] - Actual filled size
 * @param {Object} thresholds - Threshold configuration
 * @param {number} [thresholds.latencyThresholdMs=500] - Max acceptable latency (NFR1: 500ms)
 * @param {number} [thresholds.slippageThresholdPct=0.02] - Max acceptable slippage as % of expected
 * @param {number} [thresholds.sizeImpactThreshold=0.5] - Max acceptable size/depth ratio
 * @param {number} [thresholds.partialFillThresholdPct=0.1] - Max acceptable size difference for partial fills
 * @param {Object} [thresholds.latencyComponentThresholds] - Individual component thresholds
 * @param {number} [thresholds.latencyComponentThresholds.decisionToSubmitMs=100] - Decision to submit threshold
 * @param {number} [thresholds.latencyComponentThresholds.submitToAckMs=200] - Submit to ack threshold
 * @param {number} [thresholds.latencyComponentThresholds.ackToFillMs=300] - Ack to fill threshold
 * @returns {string[]} Array of diagnostic flags (e.g., ['high_latency', 'high_slippage', 'size_divergence'])
 */
export function detectDiagnosticFlags(event, thresholds = {}) {
  const {
    latencyThresholdMs = 500,
    slippageThresholdPct = 0.02,
    sizeImpactThreshold = 0.5,
    partialFillThresholdPct = 0.1,
    latencyComponentThresholds = {},
  } = thresholds;

  const {
    decisionToSubmitMs = 100,
    submitToAckMs = 200,
    ackToFillMs = 300,
  } = latencyComponentThresholds;

  const flags = [];

  // Check high latency (NFR1: 500ms threshold)
  if (event.latency_total_ms != null && event.latency_total_ms > latencyThresholdMs) {
    flags.push('high_latency');
  }

  // Check individual latency component anomalies (Story 5.3)
  if (event.latency_decision_to_submit_ms != null && event.latency_decision_to_submit_ms > decisionToSubmitMs) {
    flags.push('slow_decision_to_submit');
  }
  if (event.latency_submit_to_ack_ms != null && event.latency_submit_to_ack_ms > submitToAckMs) {
    flags.push('slow_submit_to_ack');
  }
  if (event.latency_ack_to_fill_ms != null && event.latency_ack_to_fill_ms > ackToFillMs) {
    flags.push('slow_ack_to_fill');
  }

  // Check high slippage (as percentage of expected price)
  if (event.slippage_vs_expected != null && event.expected_price != null && event.expected_price > 0) {
    const slippagePct = Math.abs(event.slippage_vs_expected / event.expected_price);
    if (slippagePct > slippageThresholdPct) {
      flags.push('high_slippage');
    }
  }

  // Check entry slippage - specifically for entry events (Story 5.3)
  if (event.event_type === 'entry' && event.slippage_signal_to_fill != null && event.price_at_signal != null && event.price_at_signal > 0) {
    const entrySlippagePct = Math.abs(event.slippage_signal_to_fill / event.price_at_signal);
    if (entrySlippagePct > slippageThresholdPct) {
      flags.push('entry_slippage');
    }
  }

  // Check size impact (order size relative to available depth)
  if (event.size_vs_depth_ratio != null && event.size_vs_depth_ratio > sizeImpactThreshold) {
    flags.push('size_impact');
  }

  // Check size divergence - partial fills (Story 5.3)
  if (event.requested_size != null && event.filled_size != null && event.requested_size > 0) {
    const sizeDiffPct = Math.abs(event.filled_size - event.requested_size) / event.requested_size;
    if (sizeDiffPct > partialFillThresholdPct) {
      flags.push('size_divergence');
    }
  }

  return flags;
}

// ═══════════════════════════════════════════════════════════════════════════
// DIVERGENCE DETECTION FUNCTIONS (Story 5.3)
// ═══════════════════════════════════════════════════════════════════════════

// Note: getDivergenceSeverity is defined in the Alerting section (Story 5.4)
// and is exported for use by other modules

/**
 * Get detailed context for a divergence flag
 *
 * @param {Object} event - Trade event with all metrics
 * @param {string} flag - Divergence flag name
 * @param {Object} thresholds - Threshold configuration
 * @returns {Object} Divergence details for debugging/alerting
 */
function getDivergenceDetails(event, flag, thresholds = {}) {
  const {
    latencyThresholdMs = 500,
    sizeImpactThreshold = 0.5,
    latencyComponentThresholds = {},
  } = thresholds;

  const {
    decisionToSubmitMs = 100,
    submitToAckMs = 200,
    ackToFillMs = 300,
  } = latencyComponentThresholds;

  switch (flag) {
    case 'high_latency':
      return {
        latency_ms: event.latency_total_ms,
        threshold_ms: latencyThresholdMs,
      };
    case 'slow_decision_to_submit':
      return {
        latency_ms: event.latency_decision_to_submit_ms,
        threshold_ms: decisionToSubmitMs,
        component: 'decision_to_submit',
      };
    case 'slow_submit_to_ack':
      return {
        latency_ms: event.latency_submit_to_ack_ms,
        threshold_ms: submitToAckMs,
        component: 'submit_to_ack',
      };
    case 'slow_ack_to_fill':
      return {
        latency_ms: event.latency_ack_to_fill_ms,
        threshold_ms: ackToFillMs,
        component: 'ack_to_fill',
      };
    case 'high_slippage':
    case 'entry_slippage':
      return {
        slippage: event.slippage_vs_expected,
        signal_to_fill: event.slippage_signal_to_fill,
        expected: event.expected_price,
        actual: event.price_at_fill,
      };
    case 'size_impact':
      return {
        ratio: event.size_vs_depth_ratio,
        threshold: sizeImpactThreshold,
      };
    case 'size_divergence':
      return {
        requested: event.requested_size,
        filled: event.filled_size,
        diff_pct: event.requested_size > 0
          ? Math.abs(event.filled_size - event.requested_size) / event.requested_size
          : null,
      };
    case 'state_divergence':
      return {
        message: 'State mismatch detected - see localState and exchangeState',
      };
    default:
      return {};
  }
}

/**
 * Check a trade event for all types of divergence
 *
 * Runs all divergence checks and returns structured results with
 * flags, severity levels, and diagnostic details.
 *
 * @param {Object} event - Trade event with all metrics
 * @param {Object} [thresholds={}] - Threshold configuration
 * @returns {Object} Divergence check result
 * @returns {boolean} result.hasDivergence - True if any divergence detected
 * @returns {string[]} result.flags - Array of divergence flag names
 * @returns {Object[]} result.divergences - Array of divergence details
 * @returns {number|null} result.eventId - Event ID if available
 * @returns {string|null} result.windowId - Window ID if available
 */
export function checkDivergence(event, thresholds = {}) {
  const flags = detectDiagnosticFlags(event, thresholds);

  const divergences = [];

  for (const flag of flags) {
    divergences.push({
      type: flag,
      severity: getDivergenceSeverity(flag),
      details: getDivergenceDetails(event, flag, thresholds),
    });
  }

  return {
    hasDivergence: flags.length > 0,
    flags,
    divergences,
    eventId: event.id ?? null,
    windowId: event.window_id ?? null,
  };
}

/**
 * Detect state divergence between local and exchange state
 *
 * Compares position state from local database with state from exchange API
 * to identify any mismatches.
 *
 * @param {Object} localState - Position state from local database
 * @param {number} [localState.id] - Position ID
 * @param {string} [localState.window_id] - Window ID
 * @param {number} [localState.size] - Position size
 * @param {string} [localState.side] - Position side (long/short)
 * @param {string} [localState.status] - Position status
 * @param {Object} exchangeState - Position state from exchange API
 * @param {number} [exchangeState.id] - Position ID
 * @param {string} [exchangeState.window_id] - Window ID
 * @param {number} [exchangeState.size] - Position size
 * @param {string} [exchangeState.side] - Position side (long/short)
 * @param {string} [exchangeState.status] - Position status
 * @returns {Object|null} Divergence details or null if no divergence
 */
export function detectStateDivergence(localState, exchangeState) {
  if (!localState || !exchangeState) {
    return null;
  }

  const divergences = [];

  // Check size
  if (localState.size !== exchangeState.size) {
    divergences.push({
      field: 'size',
      local: localState.size,
      exchange: exchangeState.size,
    });
  }

  // Check side
  if (localState.side !== exchangeState.side) {
    divergences.push({
      field: 'side',
      local: localState.side,
      exchange: exchangeState.side,
    });
  }

  // Check status (if position exists on one side but not other)
  if (localState.status !== exchangeState.status) {
    divergences.push({
      field: 'status',
      local: localState.status,
      exchange: exchangeState.status,
    });
  }

  if (divergences.length === 0) {
    return null;
  }

  return {
    positionId: localState.id ?? exchangeState.id ?? null,
    windowId: localState.window_id ?? exchangeState.window_id ?? null,
    divergences,
    localState,
    exchangeState,
  };
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
 * @param {string} [options.timeRange.startDate] - Start date (ISO string)
 * @param {string} [options.timeRange.endDate] - End date (ISO string)
 * @param {string[]} [options.flags] - Filter by specific flag types
 * @returns {Object[]} Events with divergence
 */
export function queryDivergentEvents({ windowId, strategyId, timeRange, flags } = {}) {
  let sql = `
    SELECT * FROM trade_events
    WHERE diagnostic_flags IS NOT NULL
      AND diagnostic_flags != '[]'
  `;
  const params = [];

  if (windowId) {
    sql += ' AND window_id = ?';
    params.push(windowId);
  }
  if (strategyId) {
    sql += ' AND strategy_id = ?';
    params.push(strategyId);
  }
  if (timeRange?.startDate) {
    sql += ' AND signal_detected_at >= ?';
    params.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    sql += ' AND signal_detected_at <= ?';
    params.push(timeRange.endDate);
  }

  sql += ' ORDER BY id DESC';

  let events = all(sql, params).map(event => {
    if (event.diagnostic_flags) {
      try {
        event.diagnostic_flags = JSON.parse(event.diagnostic_flags);
      } catch {
        event.diagnostic_flags = [];
      }
    }
    if (event.notes) {
      try {
        event.notes = JSON.parse(event.notes);
      } catch {
        event.notes = null;
      }
    }
    return event;
  });

  // Filter by specific flags if requested
  if (flags && flags.length > 0) {
    events = events.filter(e =>
      e.diagnostic_flags?.some(f => flags.includes(f))
    );
  }

  return events;
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
 * @param {string} [options.timeRange.startDate] - Start date (ISO string)
 * @param {string} [options.timeRange.endDate] - End date (ISO string)
 * @returns {Object} Summary with counts per divergence type
 * @returns {number} summary.totalEvents - Total number of events in range
 * @returns {number} summary.eventsWithDivergence - Number of events with any divergence
 * @returns {number} summary.divergenceRate - Ratio of divergent events to total
 * @returns {Object} summary.flagCounts - Count per flag type
 * @returns {Object} summary.flagRates - Rate per flag type (count/total)
 */
export function queryDivergenceSummary({ windowId, strategyId, timeRange } = {}) {
  // First get all events with divergence
  const events = queryDivergentEvents({ windowId, strategyId, timeRange });

  // Count total events (with and without divergence) for percentage
  let totalSql = 'SELECT COUNT(*) as count FROM trade_events WHERE 1=1';
  const totalParams = [];

  if (windowId) {
    totalSql += ' AND window_id = ?';
    totalParams.push(windowId);
  }
  if (strategyId) {
    totalSql += ' AND strategy_id = ?';
    totalParams.push(strategyId);
  }
  if (timeRange?.startDate) {
    totalSql += ' AND signal_detected_at >= ?';
    totalParams.push(timeRange.startDate);
  }
  if (timeRange?.endDate) {
    totalSql += ' AND signal_detected_at <= ?';
    totalParams.push(timeRange.endDate);
  }

  const totalResult = get(totalSql, totalParams);
  const totalEvents = totalResult?.count || 0;

  // Aggregate flags
  const flagCounts = {};
  for (const event of events) {
    for (const flag of event.diagnostic_flags || []) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
  }

  return {
    totalEvents,
    eventsWithDivergence: events.length,
    divergenceRate: totalEvents > 0 ? events.length / totalEvents : 0,
    flagCounts,
    flagRates: Object.fromEntries(
      Object.entries(flagCounts).map(([flag, count]) => [
        flag,
        totalEvents > 0 ? count / totalEvents : 0,
      ])
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DIVERGENCE ALERTING FUNCTIONS (Story 5.4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get severity level for a divergence flag (exported for use in alerting)
 *
 * State and size divergence are more severe (error level),
 * while latency and slippage issues are warnings.
 *
 * @param {string} flag - Divergence flag name
 * @returns {string} Severity level ('error' or 'warn')
 */
export function getDivergenceSeverity(flag) {
  const severeFlags = ['state_divergence', 'size_divergence'];
  return severeFlags.includes(flag) ? 'error' : 'warn';
}

/**
 * Format a single divergence detail into a human-readable message
 *
 * @param {string} type - Divergence type
 * @param {Object} details - Divergence details from checkDivergence
 * @param {Object} event - Original trade event with metrics
 * @returns {string} Human-readable description
 */
function formatDivergenceDetail(type, details, event) {
  switch (type) {
    case 'high_latency':
      return `High latency: ${details.latency_ms ?? 'N/A'}ms (threshold: ${details.threshold_ms ?? 500}ms)`;

    case 'slow_decision_to_submit':
      return `Slow decision→submit: ${details.latency_ms ?? 'N/A'}ms (threshold: ${details.threshold_ms ?? 100}ms)`;

    case 'slow_submit_to_ack':
      return `Slow submit→ack: ${details.latency_ms ?? 'N/A'}ms (threshold: ${details.threshold_ms ?? 200}ms)`;

    case 'slow_ack_to_fill':
      return `Slow ack→fill: ${details.latency_ms ?? 'N/A'}ms (threshold: ${details.threshold_ms ?? 300}ms)`;

    case 'high_slippage':
    case 'entry_slippage': {
      const expected = details.expected ?? event?.expected_price;
      const actual = details.actual ?? event?.price_at_fill;
      let slippagePct = 'N/A';
      if (expected != null && actual != null && expected !== 0) {
        slippagePct = ((actual - expected) / expected * 100).toFixed(2) + '%';
      }
      const typeLabel = type === 'entry_slippage' ? 'Entry slippage' : 'High slippage';
      return `${typeLabel}: ${slippagePct} - expected ${expected?.toFixed(4) ?? 'N/A'}, got ${actual?.toFixed(4) ?? 'N/A'}`;
    }

    case 'size_impact':
      return `Size impact: ${((details.ratio ?? 0) * 100).toFixed(1)}% of depth (threshold: ${((details.threshold ?? 0) * 100).toFixed(1)}%)`;

    case 'size_divergence':
      return `Size divergence: requested ${details.requested ?? 'N/A'}, filled ${details.filled ?? 'N/A'}`;

    case 'state_divergence':
      return `State divergence: local vs exchange mismatch detected`;

    default:
      return `${type}: divergence detected`;
  }
}

/**
 * Get known threshold values for reference in alerts
 *
 * @param {string} flag - Divergence flag name
 * @returns {string} Human-readable threshold description
 */
function getThresholdForFlag(flag) {
  const thresholds = {
    high_latency: '500ms',
    slow_decision_to_submit: '100ms',
    slow_submit_to_ack: '200ms',
    slow_ack_to_fill: '300ms',
    high_slippage: '2%',
    entry_slippage: '2%',
    size_impact: '50% of depth',
    size_divergence: '10% difference',
    state_divergence: 'any mismatch',
  };
  return thresholds[flag] || 'N/A';
}

/**
 * Get actionable suggestions based on divergence flags
 *
 * @param {string[]} flags - Array of divergence flag names
 * @returns {string[]} Array of suggested actions
 */
function getSuggestionsForDivergences(flags) {
  const suggestions = [];

  if (flags.includes('high_latency')) {
    suggestions.push('Check network latency and API response times');
  }
  if (flags.includes('slow_decision_to_submit')) {
    suggestions.push('Check local processing bottlenecks');
  }
  if (flags.includes('slow_submit_to_ack')) {
    suggestions.push('Check API connection and exchange responsiveness');
  }
  if (flags.includes('slow_ack_to_fill')) {
    suggestions.push('Check market liquidity and order book depth');
  }
  if (flags.includes('high_slippage') || flags.includes('entry_slippage')) {
    suggestions.push('Review orderbook depth and timing of entry signals');
  }
  if (flags.includes('size_impact')) {
    suggestions.push('Consider reducing position size or improving liquidity detection');
  }
  if (flags.includes('size_divergence')) {
    suggestions.push('Check for partial fills and orderbook depth');
  }
  if (flags.includes('state_divergence')) {
    suggestions.push('CRITICAL: Run position reconciliation immediately');
  }

  return suggestions;
}

/**
 * Format a divergence alert with structured, actionable information
 *
 * Creates both a human-readable summary message and machine-readable
 * structured data suitable for analysis and debugging.
 *
 * @param {Object} divergenceResult - Result from checkDivergence()
 * @param {Object} event - Original trade event with metrics
 * @returns {Object} Formatted alert with message and structured data
 * @returns {string} result.message - Human-readable summary
 * @returns {Object} result.structured - Machine-readable structured data
 * @returns {string[]} result.suggestions - Actionable next steps
 */
export function formatDivergenceAlert(divergenceResult, event) {
  const { flags = [], divergences = [] } = divergenceResult || {};

  // Build human-readable summary
  const summaryParts = [];
  for (const divergence of divergences) {
    const { type, details = {} } = divergence;
    summaryParts.push(formatDivergenceDetail(type, details, event));
  }

  return {
    // Human-readable summary
    message: summaryParts.join(' | ') || 'No divergence details',

    // Structured data for analysis
    structured: {
      flags,
      divergences: divergences.map(d => ({
        type: d.type,
        severity: d.severity,
        expected: d.details?.expected ?? d.details?.threshold ?? d.details?.requested ?? null,
        actual: d.details?.actual ?? d.details?.latency_ms ?? d.details?.ratio ?? d.details?.filled ?? null,
        threshold: getThresholdForFlag(d.type),
      })),
      context: {
        window_id: event?.window_id ?? null,
        position_id: event?.position_id ?? null,
        strategy_id: event?.strategy_id ?? null,
        event_type: event?.event_type ?? null,
      },
      timestamps: {
        signal_detected_at: event?.signal_detected_at ?? null,
        order_filled_at: event?.order_filled_at ?? null,
      },
    },

    // Suggested next steps
    suggestions: getSuggestionsForDivergences(flags),
  };
}

/**
 * Determine if divergence should escalate to error level
 *
 * Returns true if any divergence in the result has 'error' severity,
 * which indicates state_divergence or size_divergence.
 *
 * @param {Object} divergenceResult - Result from checkDivergence()
 * @returns {boolean} True if any divergence requires error-level escalation
 */
export function shouldEscalate(divergenceResult) {
  if (!divergenceResult || !divergenceResult.divergences) {
    return false;
  }

  // Check if any divergence has 'error' severity
  return divergenceResult.divergences.some(d => d.severity === 'error');
}

/**
 * Generate alert for divergence - fail-loud, never throws
 *
 * Main entry point for divergence alerting. Formats the alert,
 * determines severity, logs appropriately, and returns alert details.
 * Wraps all operations in try/catch to ensure alerting never crashes
 * the trade flow.
 *
 * @param {Object} event - Trade event with metrics
 * @param {Object} divergenceResult - Result from checkDivergence()
 * @returns {Object} Alert details (or error info if alerting failed)
 * @returns {boolean} result.alerted - Whether alert was generated
 * @returns {string} [result.level] - Log level used ('error' or 'warn')
 * @returns {string} [result.message] - Alert message
 * @returns {string[]} [result.flags] - Divergence flags
 * @returns {string} [result.reason] - Reason if not alerted
 * @returns {string} [result.error] - Error message if alerting failed
 */
export function alertOnDivergence(event, divergenceResult) {
  try {
    // Return early if no divergence
    if (!divergenceResult || !divergenceResult.hasDivergence) {
      return { alerted: false, reason: 'no_divergence' };
    }

    // Format the alert
    const alert = formatDivergenceAlert(divergenceResult, event);

    // Determine log level
    const level = shouldEscalate(divergenceResult) ? 'error' : 'warn';

    // Get or create logger
    if (!alertLog) {
      alertLog = child({ module: 'trade-event' });
    }

    // Build log data
    const logData = {
      message: alert.message,
      ...alert.structured,
      suggestions: alert.suggestions,
    };

    // Log the alert - never suppress
    if (level === 'error') {
      alertLog.error('divergence_alert', logData);
    } else {
      alertLog.warn('divergence_alert', logData);
    }

    return {
      alerted: true,
      level,
      message: alert.message,
      flags: divergenceResult.flags,
    };
  } catch (error) {
    // Fail-loud but don't crash - log the alerting failure
    console.error('ALERT_SYSTEM_ERROR: Failed to generate divergence alert', {
      error: error.message,
      event_id: event?.id,
    });

    return {
      alerted: false,
      reason: 'alert_system_error',
      error: error.message,
    };
  }
}
