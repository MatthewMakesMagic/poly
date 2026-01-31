/**
 * Trade Event Logic
 *
 * Core business logic for recording trade events.
 * Handles slippage and latency calculations, database operations, and logging.
 */

import { run, get, all } from '../../persistence/database.js';
import { TradeEventType, TradeEventError, TradeEventErrorCodes } from './types.js';
import { incrementEventCount } from './state.js';

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

  // Parse ISO timestamps to milliseconds
  const signalMs = signalDetectedAt ? new Date(signalDetectedAt).getTime() : null;
  const submitMs = orderSubmittedAt ? new Date(orderSubmittedAt).getTime() : null;
  const ackMs = orderAckedAt ? new Date(orderAckedAt).getTime() : null;
  const fillMs = orderFilledAt ? new Date(orderFilledAt).getTime() : null;

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
 * Checks latency, slippage, and size impact against configurable thresholds
 * and returns an array of flags indicating which thresholds were exceeded.
 *
 * @param {Object} event - Event data with latency, slippage, and size metrics
 * @param {number} [event.latency_total_ms] - Total latency in milliseconds
 * @param {number} [event.slippage_vs_expected] - Slippage vs expected price
 * @param {number} [event.expected_price] - Expected execution price
 * @param {number} [event.size_vs_depth_ratio] - Ratio of order size to available depth
 * @param {Object} thresholds - Threshold configuration
 * @param {number} [thresholds.latencyThresholdMs=500] - Max acceptable latency (NFR1: 500ms)
 * @param {number} [thresholds.slippageThresholdPct=0.02] - Max acceptable slippage as % of expected
 * @param {number} [thresholds.sizeImpactThreshold=0.5] - Max acceptable size/depth ratio
 * @returns {string[]} Array of diagnostic flags (e.g., ['high_latency', 'high_slippage'])
 */
export function detectDiagnosticFlags(event, thresholds = {}) {
  const {
    latencyThresholdMs = 500,
    slippageThresholdPct = 0.02,
    sizeImpactThreshold = 0.5,
  } = thresholds;

  const flags = [];

  // Check high latency (NFR1: 500ms threshold)
  if (event.latency_total_ms != null && event.latency_total_ms > latencyThresholdMs) {
    flags.push('high_latency');
  }

  // Check high slippage (as percentage of expected price)
  if (event.slippage_vs_expected != null && event.expected_price != null && event.expected_price > 0) {
    const slippagePct = Math.abs(event.slippage_vs_expected / event.expected_price);
    if (slippagePct > slippageThresholdPct) {
      flags.push('high_slippage');
    }
  }

  // Check size impact (order size relative to available depth)
  if (event.size_vs_depth_ratio != null && event.size_vs_depth_ratio > sizeImpactThreshold) {
    flags.push('size_impact');
  }

  return flags;
}
