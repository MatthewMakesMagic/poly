/**
 * Latency Measurer
 *
 * Probes real Polymarket API latency using FOK orders and REST calls.
 * Maintains a ring buffer of recent measurements for p50/p90/p99 stats.
 *
 * @module modules/paper-trader/latency-measurer
 */

import * as polymarket from '../../clients/polymarket/index.js';
import persistence from '../../persistence/index.js';

const RING_BUFFER_SIZE = 100;

let log = null;
let measurements = [];

/**
 * Initialize the latency measurer
 *
 * @param {Object} logger - Child logger instance
 */
export function init(logger) {
  log = logger;
  measurements = [];
}

/**
 * Probe API latency via FOK buy at $0.01 (guaranteed no fill)
 *
 * Measures full round trip: SDK signing + HTTPS + exchange ack.
 *
 * @param {string} tokenId - Token to probe against
 * @returns {Promise<number|null>} Round-trip ms, or null on failure
 */
export async function probeLatency(tokenId) {
  const start = Date.now();
  try {
    // FOK buy at $0.01 at price 0.01 — guaranteed no fill, measures round trip
    await polymarket.buy(tokenId, 0.01, 0.01, 'FOK');
    const elapsed = Date.now() - start;

    await recordMeasurement('fok_probe', elapsed, tokenId);
    return elapsed;
  } catch (err) {
    const elapsed = Date.now() - start;

    // Even if the order is rejected, we got a round-trip measurement
    // The SDK signs + sends + gets a response, so timing is valid
    if (elapsed > 0) {
      await recordMeasurement('fok_probe_rejected', elapsed, tokenId, {
        error: err.message,
      });
      return elapsed;
    }

    if (log) {
      log.warn('latency_probe_failed', {
        token_id: tokenId?.substring(0, 16),
        error: err.message,
        elapsed_ms: elapsed,
      });
    }
    return null;
  }
}

/**
 * Probe API latency via REST getOrderBook call (lighter probe)
 *
 * @param {string} tokenId - Token to probe
 * @returns {Promise<number|null>} Round-trip ms, or null on failure
 */
export async function probeRestLatency(tokenId) {
  const start = Date.now();
  try {
    await polymarket.getOrderBook(tokenId);
    const elapsed = Date.now() - start;

    await recordMeasurement('rest_probe', elapsed, tokenId);
    return elapsed;
  } catch (err) {
    const elapsed = Date.now() - start;
    if (log) {
      log.warn('rest_latency_probe_failed', {
        token_id: tokenId?.substring(0, 16),
        error: err.message,
        elapsed_ms: elapsed,
      });
    }
    return null;
  }
}

/**
 * Record a measurement to ring buffer and database
 *
 * @param {string} type - Measurement type
 * @param {number} roundTripMs - Round-trip milliseconds
 * @param {string} tokenId - Token ID
 * @param {Object} [details=null] - Additional details
 */
async function recordMeasurement(type, roundTripMs, tokenId, details = null) {
  // Add to ring buffer
  measurements.push({
    timestamp: Date.now(),
    type,
    roundTripMs,
    tokenId,
  });

  // Keep ring buffer bounded
  while (measurements.length > RING_BUFFER_SIZE) {
    measurements.shift();
  }

  // Persist to database
  try {
    await persistence.run(`
      INSERT INTO latency_measurements (timestamp, measurement_type, round_trip_ms, token_id, details)
      VALUES (NOW(), $1, $2, $3, $4)
    `, [type, roundTripMs, tokenId, details ? JSON.stringify(details) : null]);
  } catch (err) {
    if (log) {
      log.warn('latency_measurement_persist_failed', { error: err.message });
    }
  }

  if (log) {
    log.info('latency_measured', {
      type,
      round_trip_ms: roundTripMs,
      token_id: tokenId?.substring(0, 16),
    });
  }
}

/**
 * Get latency statistics from ring buffer
 *
 * @returns {Object} { count, p50, p90, p99, min, max, avg }
 */
export function getStats() {
  if (measurements.length === 0) {
    return { count: 0, p50: null, p90: null, p99: null, min: null, max: null, avg: null };
  }

  const sorted = measurements
    .map(m => m.roundTripMs)
    .sort((a, b) => a - b);

  const count = sorted.length;

  return {
    count,
    p50: sorted[Math.floor(count * 0.5)],
    p90: sorted[Math.floor(count * 0.9)],
    p99: sorted[Math.floor(count * 0.99)],
    min: sorted[0],
    max: sorted[count - 1],
    avg: sorted.reduce((a, b) => a + b, 0) / count,
  };
}

/**
 * Get the most recent latency measurement
 *
 * @returns {number|null} Most recent round-trip ms
 */
export function getLatestLatency() {
  if (measurements.length === 0) return null;
  return measurements[measurements.length - 1].roundTripMs;
}

/**
 * Reset measurements (for testing)
 */
export function reset() {
  measurements = [];
}
