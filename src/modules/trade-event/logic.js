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
